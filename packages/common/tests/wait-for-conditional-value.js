'use strict';

const pTimeout = require('p-timeout');
const test = require('ava');
const waitForConditionalValue = require('../wait-for-conditional-value');

test('waitForConditionalValue throws an error if fn is not a function', async (t) => {
  const fn = 5;
  const condition = () => false;

  const error = await t.throws(
    waitForConditionalValue(fn, condition),
    TypeError
  );

  t.is(error.message, 'fn must be a function');
});

test('waitForConditionalValue throws an error if condition is not a function', async (t) => {
  const fn = () => 1;
  const condition = 2;

  const error = await t.throws(
    waitForConditionalValue(fn, condition),
    TypeError
  );

  t.is(error.message, 'condition must be a function');
});

test('waitForConditionalValue throws an error if interval is not an integer', async (t) => {
  const fn = () => 1;
  const condition = () => true;

  const error = await t.throws(
    waitForConditionalValue(fn, condition, { interval: 'asdf' }),
    TypeError
  );

  t.is(error.message, 'interval must be a positive integer');
});

test('waitForConditionalValue throws an error if interval is not positive', async (t) => {
  const fn = () => 1;
  const condition = () => true;

  const error = await t.throws(
    waitForConditionalValue(fn, condition, { interval: 0 }),
    TypeError
  );

  t.is(error.message, 'interval must be a positive integer');
});

test('waitForConditionalValue throws an error if timeout is not an integer', async (t) => {
  const fn = () => 1;
  const condition = () => true;

  const error = await t.throws(
    waitForConditionalValue(fn, condition, { timeout: 'asdf' }),
    TypeError
  );

  t.is(error.message, 'timeout must be a positive integer');
});

test('waitForConditionalValue throws an error if timeout is not positive', async (t) => {
  const fn = () => 1;
  const condition = () => true;

  const error = await t.throws(
    waitForConditionalValue(fn, condition, { timeout: 0 }),
    TypeError
  );

  t.is(error.message, 'timeout must be a positive integer');
});

test('waitForConditionalValue throws an error if condition does not return a boolean', async (t) => {
  const fn = () => 1;
  const condition = () => 1;

  const error = await t.throws(
    waitForConditionalValue(fn, condition),
    TypeError
  );

  t.is(error.message, 'condition must return or resolve to a boolean');
});

test('waitForConditionalValue throws an error if condition does not resolve to a boolean', async (t) => {
  const fn = () => 1;
  const condition = () => Promise.resolve(1);

  const error = await t.throws(
    waitForConditionalValue(fn, condition),
    TypeError
  );

  t.is(error.message, 'condition must return or resolve to a boolean');
});

test('waitForConditionalValue works when fn and condition return values', async (t) => {
  const fn = () => 1;
  const condition = (x) => x === 1;

  const result = await waitForConditionalValue(fn, condition);
  t.is(result, 1);
});

test('waitForConditionalValue works when fn returns a Promise', async (t) => {
  const fn = () => Promise.resolve(1);
  const condition = (x) => x === 1;

  const result = await waitForConditionalValue(fn, condition);
  t.is(result, 1);
});

test('waitForConditionalValue works when condition returns a Promise', async (t) => {
  const fn = () => 1;
  const condition = (x) => Promise.resolve(x === 1);

  const result = await waitForConditionalValue(fn, condition);
  t.is(result, 1);
});

test('waitForConditionalValue times out after a specified time', async (t) => {
  const expectedTimeout = 500;
  const interval = 100;
  const fn = () => 1;
  const condition = () => false;

  const runTest = async () => {
    let startTime;
    try {
      startTime = Date.now();
      await waitForConditionalValue(
        fn,
        condition,
        { interval, timeout: expectedTimeout }
      );
      t.fail('Expected a timeout error');
    }
    catch (err) {
      const actualDuration = Date.now() - startTime;

      t.is(err.name, 'TimeoutError');
      t.true(actualDuration > expectedTimeout * 0.8);
      t.true(actualDuration < expectedTimeout * 1.2);
    }
  };

  return pTimeout(runTest(), expectedTimeout + 1000);
});

test('waitForConditionalValue times out after a default of 5 seconds', async (t) => {
  const expectedTimeout = 5000;
  const interval = 1000;
  const fn = () => 1;
  const condition = () => false;

  const runTest = async () => {
    let startTime;
    try {
      startTime = Date.now();
      await waitForConditionalValue(fn, condition, { interval });
      t.fail('Expected a timeout error');
    }
    catch (err) {
      const actualDuration = Date.now() - startTime;

      t.is(err.name, 'TimeoutError');
      t.true(actualDuration > expectedTimeout * 0.8);
      t.true(actualDuration < expectedTimeout * 1.2);
    }
  };

  return pTimeout(runTest(), expectedTimeout + 1000);
});

test('waitForConditionalValue retries after a specified interval', async (t) => {
  const timeout = 500;
  const expectedInterval = 100;

  let previousCallTime = null;
  let intervalChecked = false;

  const fn = () => {
    const thisCallTime = Date.now();

    if (previousCallTime) {
      const actualInterval = Date.now() - previousCallTime;

      t.true(actualInterval > expectedInterval * 0.8);
      t.true(actualInterval < expectedInterval * 1.2);
      intervalChecked = true;
    }

    previousCallTime = thisCallTime;
  };

  const condition = () => false;

  const runTest = async () => {
    try {
      await waitForConditionalValue(
        fn,
        condition,
        { interval: expectedInterval, timeout }
      );
      t.fail('Expected a timeout error');
    }
    catch (err) {
      t.is(err.name, 'TimeoutError');
      t.true(intervalChecked);
    }
  };

  return pTimeout(runTest(), timeout + 1000);
});

test('waitForConditionalValue retries after a default of 1 second', async (t) => {
  const timeout = 3000;
  const expectedInterval = 1000;

  let previousCallTime = null;
  let intervalChecked = false;

  const fn = () => {
    const thisCallTime = Date.now();

    if (previousCallTime) {
      const actualInterval = Date.now() - previousCallTime;

      t.true(actualInterval > expectedInterval * 0.8);
      t.true(actualInterval < expectedInterval * 1.2);
      intervalChecked = true;
    }

    previousCallTime = thisCallTime;
  };

  const condition = () => false;

  const runTest = async () => {
    try {
      await waitForConditionalValue(fn, condition, { timeout });
      t.fail('Expected a timeout error');
    }
    catch (err) {
      t.is(err.name, 'TimeoutError');
      t.true(intervalChecked);
    }
  };

  return pTimeout(runTest(), timeout + 1000);
});
