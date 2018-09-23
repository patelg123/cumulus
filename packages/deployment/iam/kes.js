/* eslint-disable no-console, no-param-reassign, no-await-in-loop, no-restricted-syntax */
/**
 * This module overrides the Kes Class
 * to support specific needs of the Cumulus Deployment.
 *
 * Specifically, this module changes the default Kes Deployment in the following ways:
 *
 * - Adds a custom handlebar helper for filtering buckets of a certain type
 *
 */

'use strict';

const AWS = require('aws-sdk');
const { Kes } = require('kes');
const Handlebars = require('handlebars');

/**
 * A subclass of Kes class that overrides parseCF method
 *
 * @class UpdatedKes
 */
class UpdatedKes extends Kes {
  parseCF(cfFile) {
    Handlebars.registerHelper('BucketIsType', (bucket, type, options) => {
      const fnTrue = options.fn;
      const fnFalse = options.inverse;

      if (bucket.type === type) return fnTrue(bucket);

      return fnFalse(bucket);
    });

    return super.parseCF(cfFile);
  }

  async checkBucketExists(options) { 
    const s3 = new AWS.S3();
    try {
      await s3.headBucket(options).promise();
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  };

  async uploadCF() {
    const s3 = new AWS.S3();
    const options = { Bucket: this.bucket };
    const bucketExists = this.bucket && await this.checkBucketExists(options);
    if (!bucketExists) {
      console.log(`options are ${JSON.stringify(options)}`);
      await s3.createBucket(options).promise();
    }
    return super.uploadCF();
  }
}

module.exports = UpdatedKes;
