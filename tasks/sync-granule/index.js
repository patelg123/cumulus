'use strict';

const path = require('path');
const cumulusMessageAdapter = require('@cumulus/cumulus-message-adapter-js');
const errors = require('@cumulus/common/errors');
const lock = require('@cumulus/ingest/lock');
const granule = require('@cumulus/ingest/granule');
const log = require('@cumulus/common/log');

/**
 * Ingest a list of granules
 *
 * @param {Object} ingest - an ingest object
 * @param {string} bucket - the name of an S3 bucket, used for locking
 * @param {string} provider - the name of a provider, used for locking
 * @param {Object[]} granules - the granules to be ingested
 * @returns {Promise.<Array>} - the list of successfully ingested granules
 */
async function download(ingest, bucket, provider, granules) {
  const updatedGranules = [];

  // log.debug(`awaiting lock.proceed in download() bucket: ${bucket}, `
  //           + `provider: ${JSON.stringify(provider)}, granuleID: ${granules[0].granuleId}`);
  // const proceed = await lock.proceed(bucket, provider, granules[0].granuleId);
  // log.debug('acquired lock');
  const proceed = true;

  if (!proceed) {
    const err =
      new errors.ResourcesLockedError('Download lock remained in place after multiple tries');
    log.error(err);
    throw err;
  }

  for (const g of granules) {
    try {
      log.debug(`await ingest.ingest(${JSON.stringify(g)}, ${bucket})`);
      let start = new Date();
      const r = await ingest.ingest(g, bucket);
      let duration = (new Date() - start) / 1000.0;
      log.debug(`ingest.ingest complete in ${duration} secs`);
      updatedGranules.push(r);
    }
    catch (e) {
      log.debug(`Error caught, await ingest.ingest(${JSON.stringify(g)},${bucket})`);
      //await lock.removeLock(bucket, provider.id, g.granuleId);
      log.error(e);
      throw e;
    }
  }
  log.debug(`finshed, await lock.removeLock(${bucket}, ${provider.id}, ${granules[0].granuleId})`);
  //await lock.removeLock(bucket, provider.id, granules[0].granuleId);
  return updatedGranules;
}

/**
 * Ingest a list of granules
 *
 * @param {Object} event - contains input and config parameters
 * @returns {Promise.<Object>} - a description of the ingested granules
 */
exports.syncGranule = function syncGranule(event) {
  // const config = event.config;
  const input = event.payload;

  log.debug(`input: ${JSON.stringify(input)}`);

  const stack = event.meta.stack;
  const buckets = event.meta.buckets;
  const provider = event.meta.provider;
  const collection = event.meta.collection;
  const forceDownload = false;
  const downloadBucket = event.meta.buckets.private.name;
  let duplicateHandling = null;
  if (!duplicateHandling && collection && collection.duplicateHandling) {
    duplicateHandling = collection.duplicateHandling;
  }

  /*
buckets: '{$.meta.buckets}'
        provider: '{$.meta.provider}'
        collection: '{$.meta.collection}'
        stack: '{$.meta.stack}'
        fileStagingDir: 'custom-staging-dir'
        downloadBucket: '{$.meta.buckets.private.name}'
  */

  log.debug('Start sync granule');

  // use stack and collection names to prefix fileStagingDir
  const fileStagingDir = path.join(
    'file-staging',
    stack
  );

  if (!provider) {
    const err = new errors.ProviderNotFound('Provider info not provided');
    log.error(err);
    return Promise.reject(err);
  }

  const IngestClass = granule.selector('ingest', provider.protocol);
  log.debug(`create IngestClass`);
  let start = new Date();
  const ingest = new IngestClass(
    buckets,
    collection,
    provider,
    fileStagingDir,
    forceDownload,
    duplicateHandling
  );
  const duration = (new Date() - start) / 1000.0;
  log.debug(`created IngestClass in ${duration} secs`);

  return download(ingest, downloadBucket, provider, input.granules)
    .then((granules) => {
      if (ingest.end) ingest.end();
      const output = { granules };
      if (collection && collection.process) output.process = collection.process;
      log.debug(`SyncGranule Complete. Returning output: ${JSON.stringify(output)}`);
      return output;
    }).catch((e) => {
      log.debug('SyncGranule errored.');
      if (ingest.end) ingest.end();

      let errorToThrow = e;
      if (e.toString().includes('ECONNREFUSED')) {
        errorToThrow = new errors.RemoteResourceError('Connection Refused');
      }
      else if (e.details && e.details.status === 'timeout') {
        errorToThrow = new errors.ConnectionTimeout('connection Timed out');
      }

      log.error(errorToThrow);
      throw errorToThrow;
    });
};

/**
 * Lambda handler
 *
 * @param {Object} event - a Cumulus Message
 * @param {Object} context - an AWS Lambda context
 * @param {Function} callback - an AWS Lambda handler
 * @returns {undefined} - does not return a value
 */
exports.handler = function handler(event, context, callback) {
  const startTime = Date.now();

  //log.debug('Call message adapter for sync granule');
  exports.syncGranule(event).then((data) => {
    const endTime = Date.now();
    const additionalMetaFields = {
      sync_granule_duration: endTime - startTime,
      sync_granule_end_time: endTime
    };
    const meta = Object.assign({}, event.meta, additionalMetaFields);
    const payload = Object.assign({}, event.payload, data);
    callback(null, Object.assign({}, event, { meta, payload }));
  })
    .catch((err) => callback(err));
};
