const fs = require('fs');
const path = require('path');
const { Execution } = require('@cumulus/api/models');
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
const workflowName = 'DiscoverAndQueueGranules';

describe('The Discover and Queue Granules workflow', () => {
  const provider = {
    host: 'openaq-data',
    protocol: 's3'
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
      payload: {}
    });
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('the sf-sns-report task has published a sns message and', () => {
    it('the execution record is added to DynamoDB', async () => {
      const record = await executionModel.get({ arn: workflowExecution.executionArn });
      expect(record.status).toEqual('completed');
    });
  });
});
