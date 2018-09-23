const fs = require('fs');
const path = require('path');
const { Execution } = require('@cumulus/api/models');
const { s3, s3ObjectExists } = require('@cumulus/common/aws');
const { buildAndExecuteWorkflow, LambdaStep } = require('@cumulus/integration-tests');
const { Config } = require('kes');
jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000000;
/**
 * Loads and parses the configuration defined in `./app/config.yml`
 *
 * @returns {Object} - Configuration object
*/
function loadConfig() {
  const params = {
    deployment: process.env.DEPLOYMENT,
    configFile: './app/config.yml',
    kesFolder: './app'
  };

  const config = new Config(params);
  return config;
}

const config = loadConfig();
const lambdaStep = new LambdaStep();
const workflowName = 'SyncGranule';

describe('The Sync Granules workflow', () => {
  const inputPayloadFilename = './spec/syncGranule.input.json';
  const payload = JSON.parse(fs.readFileSync(inputPayloadFilename));
  const provider = {
    host: 'https://openaq-data.s3.amazonaws.com/index.html',
    protocol: 'https'
  };
  let workflowExecution = null;

  process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
  const executionModel = new Execution();

  beforeAll(async () => {
    // eslint-disable-next-line function-paren-newline
    workflowExecution = await buildAndExecuteWorkflow({
      stackName: config.stackName,
      bucketName: config.bucket,
      workflowName,
      collection: {},
      provider,
      payload
    });
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('the SyncGranule Lambda function', () => {
    let lambdaOutput = null;
    let files;
    let key1;
    let key2;
    const existCheck = [];

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      files = lambdaOutput.payload.files;
      key1 = path.join(files[0].fileStagingDir, files[0].name);
      key2 = path.join(files[1].fileStagingDir, files[1].name);
      existCheck[0] = await s3ObjectExists({ Bucket: files[0].bucket, Key: key1 });
      existCheck[1] = await s3ObjectExists({ Bucket: files[1].bucket, Key: key2 });
    });

    afterAll(async () => {
      await s3().deleteObject({ Bucket: files[0].bucket, Key: key1 }).promise();
      await s3().deleteObject({ Bucket: files[1].bucket, Key: key2 }).promise();
    });

    it('receives payload with file objects updated to include file staging location', () => {
      expect(lambdaOutput.payload).toEqual(expectedPayload);
    });

    // eslint-disable-next-line max-len
    it('receives meta.input_granules with files objects updated to include file staging location', () => {
      expect(lambdaOutput.meta.input_granules).toEqual(expectedPayload.granules);
    });

    it('receives files with custom staging directory', () => {
      files.forEach((file) => {
        expect(file.fileStagingDir).toMatch('custom-staging-dir\/.*');
      });
    });

    it('adds files to staging location', () => {
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });
  });

  describe('the sf-sns-report task has published a sns message and', () => {
    it('the execution record is added to DynamoDB', async () => {
      const record = await executionModel.get({ arn: workflowExecution.executionArn });
      expect(record.status).toEqual('completed');
    });
  });
});
