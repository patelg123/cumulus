'use strict';

const test = require('ava');
const sleep = require('../sleep');

test('sleep() resolves after the expected amount of time', async (t) => {
  const expectedSleepTime = 500;

  const startTime = Date.now();
  await sleep(expectedSleepTime);
  const actualSleepTime = Date.now() - startTime;

  t.true(actualSleepTime > expectedSleepTime * 0.8);
  t.true(actualSleepTime < expectedSleepTime * 1.2);
});
