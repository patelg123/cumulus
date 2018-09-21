/** @module */

'use strict';

const isBoolean = require('lodash.isboolean');
const isFunction = require('lodash.isfunction');
const isInteger = require('lodash.isinteger');
const sleep = require('./sleep');

async function waitForConditionalValue(fn, condition, options = {}) {
  if (!isFunction(fn)) throw new TypeError('fn must be a function');
  if (!isFunction(condition)) throw new TypeError('condition must be a function');

  const {
    interval = 1000,
    timeout = 5000
  } = options;

  if (!isInteger(interval) || interval <= 0) {
    throw new TypeError('interval must be a positive integer');
  }

  if (!isInteger(timeout) || timeout <= 0) {
    throw new TypeError('timeout must be a positive integer');
  }

  const timeoutAt = Date.now() + timeout;

  /* eslint-disable no-await-in-loop */
  while (true) { // eslint-disable-line no-constant-condition
    const value = await Promise.resolve().then(fn);

    const conditionResult = await Promise.resolve(value).then(condition);
    if (!isBoolean(conditionResult)) {
      throw new TypeError('condition must return or resolve to a boolean');
    }

    if (conditionResult) return value;

    if (Date.now() + interval >= timeoutAt) {
      const error = new Error('waitForConditionalValue timed out');
      error.name = 'TimeoutError';
      throw error;
    }

    await sleep(interval);
  }
  /* eslint-enable no-await-in-loop */
}
module.exports = waitForConditionalValue;
