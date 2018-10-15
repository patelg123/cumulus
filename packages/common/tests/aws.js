'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const test = require('ava');
const aws = require('../aws');
const { randomString } = require('../test-utils');

test('s3Join behaves as expected', (t) => {
  // Handles an array argument
  t.is(aws.s3Join(['a', 'b', 'c']), 'a/b/c');

  t.is(aws.s3Join(['a', 'b']), 'a/b');
  t.is(aws.s3Join(['a', 'b/']), 'a/b/');
  t.is(aws.s3Join(['a/', 'b']), 'a/b');
  t.is(aws.s3Join(['/a', 'b']), 'a/b');
  t.is(aws.s3Join(['a/', 'b']), 'a/b');

  t.is(aws.s3Join(['a']), 'a');
  t.is(aws.s3Join(['/a']), 'a');
  t.is(aws.s3Join(['a/']), 'a/');

  // Handles a list of arguments
  t.is(aws.s3Join('a', 'b'), 'a/b');
});

test('listS3ObjectsV2 handles non-truncated case', async (t) => {
  const Bucket = randomString();
  await aws.s3().createBucket({ Bucket }).promise();

  await Promise.all(['a', 'b', 'c'].map((Key) => aws.s3().putObject({
    Bucket,
    Key,
    Body: 'my-body'
  }).promise()));

  // List things from S3
  const result = await aws.listS3ObjectsV2({ Bucket, MaxKeys: 5 });
  const actualKeys = new Set(result.map((object) => object.Key));
  const expectedKeys = new Set(['a', 'b', 'c']);

  t.deepEqual(actualKeys, expectedKeys);

  return aws.recursivelyDeleteS3Bucket(Bucket);
});

test('listS3ObjectsV2 handles truncated case', async (t) => {
  const Bucket = randomString();
  await aws.s3().createBucket({ Bucket }).promise();

  await Promise.all(['a', 'b', 'c'].map((Key) => aws.s3().putObject({
    Bucket,
    Key,
    Body: 'my-body'
  }).promise()));

  // List things from S3
  const result = await aws.listS3ObjectsV2({ Bucket, MaxKeys: 2 });
  const actualKeys = new Set(result.map((object) => object.Key));
  const expectedKeys = new Set(['a', 'b', 'c']);

  t.deepEqual(actualKeys, expectedKeys);

  return aws.recursivelyDeleteS3Bucket(Bucket);
});

test('downloadS3File rejects promise if key not found', async (t) => {
  const Bucket = randomString();
  await aws.s3().createBucket({ Bucket }).promise();

  try {
    await aws.downloadS3File({ Bucket, Key: 'not-gonna-find-it' }, '/tmp/wut');
  }
  catch (err) {
    t.is(err.message, 'The specified key does not exist.');
  }
});

test('downloadS3File resolves filepath if key is found', async (t) => {
  const Bucket = randomString();
  const Key = 'example';
  const Body = 'example';

  await aws.s3().createBucket({ Bucket }).promise();
  await aws.s3().putObject({ Bucket, Key: Key, Body: Body }).promise();

  const params = { Bucket, Key: Key };
  const filepath = await aws.downloadS3File(params, path.join(tmpdir(), 'example'));

  const result = await new Promise((resolve, reject) => {
    fs.readFile(filepath, 'utf-8', (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  t.is(result, Body);
});

// exports.createS3Bucket = (bucketName) =>
//   exports.s3().createBucket({ Bucket: bucketName }).promise();

// exports.createBuckets = (bucketNames) =>
//   Promise.all(bucketNames.map(exports.createS3Bucket));

test('createS3Bucket creates an S3 bucket', async (t) => {
  const bucketName = randomString();

  try {
    await aws.createS3Bucket(bucketName);

    const listBucketsResponse = await aws.s3().listBuckets().promise();
    const bucketNames = listBucketsResponse.Buckets.map((bucket) => bucket.Name);

    t.true(bucketNames.includes(bucketName));
  }
  finally {
    await aws.s3().deleteBucket({ Bucket: bucketName }).promise();
  }
});

test('createS3Buckets creates S3 buckets', async (t) => {
  const bucketNames = [randomString(), randomString()];

  try {
    await aws.createS3Buckets(bucketNames);

    const listBucketsResponse = await aws.s3().listBuckets().promise();
    const allBucketNames = listBucketsResponse.Buckets.map((bucket) => bucket.Name);

    t.true(allBucketNames.includes(bucketNames[0]));
    t.true(allBucketNames.includes(bucketNames[1]));
  }
  finally {
    await Promise.all([
      aws.s3().deleteBucket({ Bucket: bucketNames[0] }).promise(),
      aws.s3().deleteBucket({ Bucket: bucketNames[1] }).promise()
    ]);
  }
});
