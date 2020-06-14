import _ from 'lodash';
import fs from 'fs';
import path from 'path';
import {ImageElement} from 'appium-base-driver';
import {
  canvasFromImage,
  canvasFromImageData,
  elementImageFromScreenshot,
} from './image';
import {asyncmap} from 'asyncbox';
import labels from './labels';
import * as tf from '@tensorflow/tfjs-node';
import {detect} from './detector';
import npmlog from 'npmlog';

const DEBUG_IMAGES = process.env.DEBUG_IMAGES || false; // truthy to write out images
const DEBUG_IMAGE_DIR = process.env.DEBUG_IMAGE_DIR || `${process.env.HOME}/elements`;

const DEFAULT_CONFIDENCE_THRESHOLD = 0.2;
const OBJ_DETECTION_MODE = "object_detection";
const ELEMENT_LOOKUP_MODE = "element_lookup";

const TF_MODEL = path.resolve(__dirname, "..", "..", "model", "model.json");
const IMG_CHANNELS = 3;
let _cached_model = null;

const logger = new Proxy({}, {
  get (target, name) {
    return function (...args) {
      npmlog[name]('ai-classifier', ...args);
    };
  }
});

async function getModel () {
  if (!_cached_model) {
    _cached_model = await tf.loadGraphModel(`file://${TF_MODEL}`);
  }
  return _cached_model;
}

async function tensorFromImage (canvas, height=224, width=224, mean=0, std=255) {
  let t = await tf.browser.fromPixels(canvas, IMG_CHANNELS);

  // convert to grayscale
  t = t.mean(2); // average down the r/g/b values
  t = tf.stack([t, t, t], 2); // then repeat each monochrome value 3 times to turn it back to rgb

  // change type to floats because we eventually want to normalize values in
  // the 0-1 range
  t = tf.cast(t, 'float32');

  // now actually do the normalize
  t = tf.div(tf.sub(t, [mean]), [std]);

  // resize the image to the specified height and width
  t = tf.image.resizeBilinear(t, [height, width]);

  return t;
}

async function tensorFromImages (canvases, height=224, width=224, mean=0, std=255) {
  const tensors = await asyncmap(canvases, async (canvas) => {
    return tensorFromImage(canvas, height, width, mean, std);
  });
  return tf.stack(tensors);
}

async function saveImageFromTensor (tensor, imgFile) {
  if (tensor.shape.length === 4) {
    // if we have the tensor we get in tensorFromImage, it has an extra dim, so
    // squeeze it out
    tensor = tensor.squeeze();
  }
  const [w, h] = tensor.shape;
  const pxArray = await tf.toPixels(tensor);
  const cvs = canvasFromImageData(pxArray, w, h);
  fs.writeFileSync(imgFile, cvs.toBuffer('image/png'));
}

async function predictionFromImage (imgData, confidence, labelHint, imgExt = ".png") {
  const model = await getModel();
  let t = await tensorFromImage(imgData);
  // if we're just finding a prediction for a single image, we need to add
  // a dimension on the front end because the model is looking for an array of
  // images
  t = t.expandDims(0);

  if (DEBUG_IMAGES) {
    await saveImageFromTensor(t, path.resolve(DEBUG_IMAGE_DIR, `tensor-for-${labelHint}.${imgExt}`));
  }
  let pred = await model.executeAsync({Placeholder: t}, ['final_result']);
  pred = pred.squeeze();
  const confMap = getConfidenceMap(await pred.data());
  return predictionFromConfMap(confMap, confidence, labelHint);
}

async function predictionsFromImages (imgDatas, confidence, labelHint) {
  const model = await getModel();
  const tensors = await tensorFromImages(imgDatas);
  const predTensors = await model.executeAsync({Placeholder: tensors}, ['final_result']);
  let preds = [];
  for (let i = 0; i < imgDatas.length; i++) {
    const confMapTensor = tf.slice(predTensors, [i, 0], 1).squeeze();
    const confMap = getConfidenceMap(await confMapTensor.data());
    preds.push(predictionFromConfMap(confMap, confidence, labelHint));
  }
  return preds;
}

function predictionFromConfMap (confMap, confidence, desiredLabel) {
  // keep track of the confidence for the label the user is looking for so we
  // can provide that feedback, if an element is not ultimately found
  let confForDesiredLabel = 0;
  confMap.sort((a, b) => b[1] - a[1]);

  let onlyDesiredLabel = confMap.filter(i => i[0] === desiredLabel);
  if (onlyDesiredLabel.length > 0) {
    confForDesiredLabel = onlyDesiredLabel[0][1];
  }

  // if the most likely classified label is below our confidence threshold,
  // say it's unclassified
  let [foundLabel, foundConfidence] = confMap[0];
  if (foundConfidence < confidence) {
    foundLabel = "unclassified";
  }
  return [foundLabel, confForDesiredLabel, foundConfidence];
}

function getConfidenceMap (predArr) {
  if (predArr.length !== labels.length) {
    throw new Error(`Prediction result array had ${predArr.length} elements ` +
                    `but labels list had ${labels.length} elements. They ` +
                    `need to match.`);
  }
  let map = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].trim() !== "unclassified") {
      map.push([labels[i], predArr[i]]);
    }
  }
  return map;
}

const QUERY = "//body//*[not(self::script) and not(self::style) and not(child::*)]";
async function getAllElements (driver, query = QUERY) {
  logger.info("Retrieving data for all leaf-node elements on screen");
  // retry since we can often get a staleelementexception when trying to find
  // all elements
  return driver.$$(query);
}

async function getElementsScreenshot (els) {
  const elementImages = {};
  for (const el of els) {
    try {
      logger.info("Getting screenshot to use for classifier");
      const b64Screen = await el.takeElementScreenshot(el.elementId);
      elementImages[el.elementId] = Buffer.from(b64Screen, 'base64');

      // eslint-disable-next-line promise/prefer-await-to-callbacks
      // fs.writeFile(`${el.elementId}.png`, b64Screen, 'base64', function(err) {
      //   console.log(err);
      // });
    } catch (ign) {}
  }
  if (_.size(elementImages) < 1) {
    throw new Error('Could not find any screenshots for leaf node elements');
  }

  return elementImages;
}

async function getElementImages (elementImages) {
  // match up each element with its slice of the screenshot
  logger.info("Getting screenshot slices for each element");
  const elsAndImages = await asyncmap(_.keys(elementImages), async (k) => {
    return [k, await canvasFromImage(elementImages[k])];
  });

  // filter out any elements for whom we could not extract images
  return elsAndImages.filter(Boolean);
}

async function getMatchingElements ({
  elsAndImages,
  label,
  confidence,
  allowWeakerMatches,
  returnMetadata = false
}) {
  // turn each screenshot slice into a label prediction, still linked up with
  // the appium element
  logger.info("Making label predictions based on element images");
  // const img = await canvasFromImage();
  // await detect(elsAndImages[0][1]);

  const start = Date.now();
  const preds = await predictionsFromImages(elsAndImages.map(ei => ei[1]), confidence, label);
  const elapsed = Date.now() - start;
  logger.info(`Predictions for ${elsAndImages.length} element(s) took ${elapsed / 1000} seconds`);
  let elsAndPreds = [];
  for (let i = 0; i < elsAndImages.length; i++) {
    elsAndPreds.push([elsAndImages[i][0], ...preds[i]]);
  }

  // make sure we sort elsAndPreds by the confidence for the desired label; it
  // could be sorted by highest confidence in general, but we care most about
  // the confidence ranking for the label in question
  elsAndPreds.sort((a, b) => b[2] - a[2]);

  let matchingEls;
  if (allowWeakerMatches) {
    // if the user has elected to allow weaker matches, return any matches
    // whose conf for desired label is above the threshold, regardless of
    // whether it was the strongest match for that element
    matchingEls = elsAndPreds.filter(ep => ep[2] >= confidence);
  } else {
    // otherwise, get rid of any elements whose top label prediction doesn't
    // match what the user has requested
    matchingEls = elsAndPreds.filter(ep => ep[1] === label);
  }
  logger.info(`Found ${matchingEls.length} matching elements`);

  // short-circuit if we found no matching elements
  if (matchingEls.length < 1) {
    return [];
  }

  // sort the matching elements by confidence
  matchingEls.sort((a, b) => b[2] - a[2]);

  logger.info(`Highest confidence of any element for desired label ` +
              `'${label}' was ${matchingEls[0][2]}`);

  // if we're only returning elements because we found a match that was weaker
  // than some other label, let the user know
  if (matchingEls[0][1] !== label) {
    logger.warn(`Found element whose confidence for label '${label}' is above ` +
                `the confidence threshold, but the most likely label for this ` +
                `element is actually '${matchingEls[0][1]}'. Proceeding ` +
                `nonetheless since allowWeakerMatches is true.`);
  }

  // if the caller wants all the confidence data, send everything back
  if (returnMetadata) {
    return matchingEls;
  }

  // otherwise just return matching elements (letting appium decide whether to return one
  // or more to the user)
  return matchingEls.map(ep => ep[0]);
}

function getConfidenceThreshold (opts) {
  let confidence = DEFAULT_CONFIDENCE_THRESHOLD;
  const confCap = opts.testaiConfidenceThreshold;
  if (confCap) {
    if (!_.isNumber(confCap) || confCap < 0 || confCap > 1) {
      throw new Error(`The 'testaiConfidenceThreshold' capability must be a ` +
                      `number between 0 and 1`);
    }
    confidence = confCap;
    logger.info(`Setting confidence threshold to overridden value of ${confCap}`);
  } else {
    logger.info(`Setting confidence threshold to default value of ${DEFAULT_CONFIDENCE_THRESHOLD}`);
  }
  return confidence;
}

async function findViaElementScreenshots (driver, label, opts) {
  const confidence = getConfidenceThreshold(opts);
  const classifications = {};

  try {
    const els = await getAllElements(driver, opts.query);
    const elementImages = await getElementsScreenshot(els);
    const elsAndImages = await getElementImages(elementImages);

    const matchingEls = await getMatchingElements({
      elsAndImages,
      label,
      confidence,
      allowWeakerMatches: opts.testaiAllowWeakerMatches,
      returnMetadata: true
    });

    for (const [elId, label, confidenceForHint, confidence] of matchingEls) {
      classifications[elId] = {label, confidenceForHint, confidence};
    }

    // return only those elements whose ids ended up in our matched list
    return els.filter(el => _.includes(_.keys(classifications), el.elementId));
  } finally {}
}

async function findByObjectDetector (driver, label, allowWeakerMatches) {
  logger.info("Will use object detection method for finding elements via AI");
  const confidence = getConfidenceThreshold(driver, logger);

  const {image, imageData, size} = await getElementsScreenshot(driver, logger);

  // TODO don't hardcode screenshot path; instead we want to find a way to pass
  // an image data buffer to the native c code
  const screenshotPath = path.resolve(__dirname, `${new Date().toUTCString()}_classifiertest.png`);
  logger.info(`Writing screenshot to ${screenshotPath} for use in object detection`);
  fs.writeFileSync(screenshotPath, imageData);

  // TODO don't hardcode threshold, allow to come from a setting
  logger.info("Gathering object candidates from tensorflow native");
  const candidates = await detect(screenshotPath, driver.opts.testaiObjDetectionThreshold || 0.95, driver.opts.testaiObjDetectionDebug);
  logger.info("Candidates retrieved");
  // we need to turn the obj detection candidates into objects that look
  // somewhat like actual elements with a 'rect' property
  let els = candidates.map((c) => {
    const {width: w, height: h} = size;
    const [xmin, ymin, xmax, ymax] = [c.xmin * w, c.ymin * h, c.xmax * w, c.ymax * h];
    return {rect: {x: xmin, y: ymin, width: xmax - xmin, height: ymax - ymin}};
  });

  const elsAndImages = await asyncmap(els, async (el) => {
    const img = await elementImageFromScreenshot(el, image);
    if (DEBUG_IMAGES) {
      const imgFile = `${DEBUG_IMAGE_DIR}/element-(${el.rect.x}, ${el.rect.y}) ` +
                      `[${el.rect.width} x ${el.rect.height}].png`;
      fs.writeFileSync(imgFile, img.canvas.toBuffer('image/png'));
    }
    return [el, img.canvas];
  });

  for (let i = 0; i < elsAndImages.length; i++) {
    // add an id to both the fake element and the image
    elsAndImages[i][0]._id = i;
    elsAndImages[i][1]._id = i;
  }

  els = await getMatchingElements({elsAndImages, label, confidence, allowWeakerMatches, logger});
  logger.info("Registering image elements with driver");
  const imageEls = els.map((el) => {
    const canvases = elsAndImages.map((ci) => ci[1]).filter((i) => i._id === el._id);
    if (canvases.length < 1) {
      throw new Error(`Could not find canvas image to map to element with fake id ${el._id}`);
    }

    const b64Template = canvases[0].toBuffer('image/png').toString('base64');
    const imgEl = new ImageElement(b64Template, el.rect);
    return driver.registerImageElement(imgEl);
  });

  return imageEls;
}

async function find (driver, label, opts = {}/* multiple */) {
  const allowWeakerMatches = opts.testaiAllowWeakerMatches;
  const mode = opts.testaiFindMode;
  if (mode === OBJ_DETECTION_MODE) {
    return await findByObjectDetector(driver, label, allowWeakerMatches);
  } else if (!mode || mode === ELEMENT_LOOKUP_MODE) {
    return await findViaElementScreenshots(driver, label, opts);
  } else {
    throw new Error(`Invalid testAiFindMode '${mode}'. Must be one of: ` +
                    `'${OBJ_DETECTION_MODE}', '${ELEMENT_LOOKUP_MODE}'`);
  }
}

export { getModel, tensorFromImage, predictionFromImage, saveImageFromTensor,
  tensorFromImages, getMatchingElements, predictionsFromImages,
  DEFAULT_CONFIDENCE_THRESHOLD };
export default find;
