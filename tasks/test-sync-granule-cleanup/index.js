'use strict';

const path = require('path');

const { log, aws } = require('@cumulus/common');

async function cleanFiles(payload) {
  const obj = payload.granules[0].files[0];

  const params = {
    Bucket: obj.bucket,
    Key: `${obj.fileStagingDir}/${path.basename(obj.filename)}`
  };

  log.info(`DELETING ${JSON.stringify(params)}`);
  await aws.deleteS3Object(params.Bucket, params.Key);
}

/**
* Lambda handler
*
* @param {Object} event - a Cumulus Message
* @param {Object} context - an AWS Lambda context
* @param {Function} callback - an AWS Lambda handler
* @returns {undefined} - does not return a value
*/
function handler(event, context, callback) {
  const syncDuration = event.meta.sync_granule_duration;
  // pull info from event.
  log.info(`syncGranule duration: ${syncDuration}`);
  try {
    cleanFiles(event.payload);
  }
  catch (error) {
    callback('Failed to delete files');
  }


  if (syncDuration > 2 * 60 * 1000) {
    callback(`SyncGranule Took too long to finish ${syncDuration}`);
  }
  else {
    callback(null, event);
  }
}

exports.handler = handler;
