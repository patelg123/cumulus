/** @module */

'use strict';

/**
 * A Promise-based sleep function
 *
 * @param {number} milliseconds - number of milliseconds to sleep
 * @returns {Promise<undefined>} undefined
 *
 * @example
 *
 * const sleep = require('@cumulus/common/sleep');
 *
 * console.log('going to sleep');
 * await sleep(1000);
 * console.log('wide awake now');
 */
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

module.exports = sleep;
