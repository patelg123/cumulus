'use strict';

const fs = require('fs-extra');
const {
  api: apiTestUtils,
  addProviders,
  cleanupProviders,
  addCollections,
  cleanupCollections,
  buildAndExecuteWorkflow,
  conceptExists,
  waitForConceptExistsOutcome,
  waitUntilGranuleStatusIs
} = require('@cumulus/integration-tests');
const {
  loadConfig,
  uploadTestDataToBucket,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
  deleteFolder
} = require('../helpers/testUtils');
const { setupTestGranuleForIngest } = require('../helpers/granuleUtils');
const config = loadConfig();
const taskName = 'IngestGranule';
const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg'
];

const isLambdaStatusLogEntry = (logEntry) =>
  logEntry.message.includes('START')
  || logEntry.message.includes('END')
  || logEntry.message.includes('REPORT');

const isCumulusLogEntry = (logEntry) => !isLambdaStatusLogEntry(logEntry);

describe('The Cumulus API', () => {
  const testId = createTimestampedTestId(config.stackName, 'APISuccess');
  const testSuffix = createTestSuffix(testId);
  const testDataFolder = createTestDataPath(testId);
  let workflowExecution = null;
  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006';
  const collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
  const provider = { id: `s3_provider${testSuffix}` };
  const inputPayloadFilename = './spec/testAPI/testAPI.input.payload.json';
  let inputPayload;
  let inputGranuleId;
  process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
  process.env.GranulesTable = `${config.stackName}-GranulesTable`;
  process.env.UsersTable = `${config.stackName}-UsersTable`;

  beforeAll(async () => {
    // populate collections, providers and test data
    await Promise.all([
      uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
      addCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      addProviders(config.stackName, config.bucket, providersDir, config.bucket, testSuffix)
    ]);

    const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
    // Update input file paths
    inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
    inputGranuleId = inputPayload.granules[0].granuleId;

    workflowExecution = await buildAndExecuteWorkflow(
      config.stackName, config.bucket, taskName, collection, provider, inputPayload
    );
  });

  afterAll(async () => {
    // clean up stack state added by test
    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix)
    ]);
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('granule endpoint', () => {
    let granule;
    let cmrLink;

    beforeAll(async () => {
      granule = await apiTestUtils.getGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });
      cmrLink = granule.cmrLink;
    });

    it('makes the granule available through the Cumulus API', async () => {
      expect(granule.granuleId).toEqual(inputGranuleId);
    });

    it('has the granule with a CMR link', () => {
      expect(granule.cmrLink).not.toBeUndefined();
    });

    it('allows reingest and executes with success status', async () => {
      granule = await apiTestUtils.getGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });
      const oldUpdatedAt = granule.updatedAt;
      const oldExecution = granule.execution;

      // Reingest Granule and compare the updatedAt times
      const response = await apiTestUtils.reingestGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });
      expect(response.status).toEqual('SUCCESS');

      const newUpdatedAt = (await apiTestUtils.getGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      })).updatedAt;
      expect(newUpdatedAt).not.toEqual(oldUpdatedAt);

      // Await reingest completion
      await waitUntilGranuleStatusIs(config.stackName, inputGranuleId, 'completed');
      const updatedGranule = await apiTestUtils.getGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });
      expect(updatedGranule.status).toEqual('completed');
      expect(updatedGranule.execution).not.toEqual(oldExecution);
    });

    it('removeFromCMR removes the ingested granule from CMR', async () => {
      const existsInCMR = await conceptExists(cmrLink);

      expect(existsInCMR).toEqual(true);

      // Remove the granule from CMR
      await apiTestUtils.removeFromCMR({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });

      // Check that the granule was removed
      await waitForConceptExistsOutcome(cmrLink, false, 10, 4000);
      const doesExist = await conceptExists(cmrLink);
      expect(doesExist).toEqual(false);
    });

    it('applyWorkflow PublishGranule publishes the granule to CMR', async () => {
      const existsInCMR = await conceptExists(cmrLink);
      expect(existsInCMR).toEqual(false);

      // Publish the granule to CMR
      await apiTestUtils.applyWorkflow({
        prefix: config.stackName,
        granuleId: inputGranuleId,
        workflow: 'PublishGranule'
      });

      await waitForConceptExistsOutcome(cmrLink, true, 10, 30000);
      const doesExist = await conceptExists(cmrLink);
      expect(doesExist).toEqual(true);
    });

    it('can delete the ingested granule from the API', async () => {
      // pre-delete: Remove the granule from CMR
      await apiTestUtils.removeFromCMR({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });

      // Delete the granule
      await apiTestUtils.deleteGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });

      // Verify deletion
      const resp = await apiTestUtils.getGranule({
        prefix: config.stackName,
        granuleId: inputGranuleId
      });
      expect(resp.message).toEqual('Granule not found');
    });
  });

  describe('executions endpoint', () => {
    it('returns tasks metadata with name and version', async () => {
      const executionResponse = await apiTestUtils.getExecution({
        prefix: config.stackName,
        arn: workflowExecution.executionArn
      });
      expect(executionResponse.tasks).toBeDefined();
      expect(executionResponse.tasks.length).not.toEqual(0);
      Object.keys(executionResponse.tasks).forEach((step) => {
        const task = executionResponse.tasks[step];
        expect(task.name).toBeDefined();
        expect(task.version).toBeDefined();
      });
    });
  });

  describe('logs endpoint', () => {
    it('returns the execution logs', async () => {
      const logs = await apiTestUtils.getLogs({ prefix: config.stackName });
      expect(logs).not.toBe(undefined);
      expect(logs.results.length).toEqual(10);
    });

    it('returns logs with sender set', async () => {
      const getLogsResponse = await apiTestUtils.getLogs({ prefix: config.stackName });

      const logEntries = getLogsResponse.results;
      const cumulusLogEntries = logEntries.filter(isCumulusLogEntry);

      cumulusLogEntries.forEach((logEntry) => {
        if (!logEntry.sender) {
          console.log('Expected a sender property:', JSON.stringify(logEntry, null, 2));
        }
        expect(logEntry.sender).not.toBe(undefined);
      });
    });

    it('returns logs with a specific execution name', async () => {
      const executionARNTokens = workflowExecution.executionArn.split(':');
      const executionName = executionARNTokens[executionARNTokens.length - 1];
      const logs = await apiTestUtils.getExecutionLogs({ prefix: config.stackName, executionName: executionName });
      expect(logs.meta.count).not.toEqual(0);
      logs.results.forEach((log) => {
        expect(log.sender).not.toBe(undefined);
        expect(log.executions).toEqual(executionName);
      });
    });
  });

  describe('collections endpoint', () => {
    it('returns a list of collections', async () => {
      const collections = await apiTestUtils.getCollections({ prefix: config.stackName });
      expect(collections).not.toBe(undefined);

      console.log('collections', collections);
    })
  });

  describe('providers endpoint', () => {
    it('returns a list of providers', async () => {
      const providers = await apiTestUtils.getProviders({ prefix: config.stackName });
      expect(providers).not.toBe(undefined);

      console.log('providers', providers);
    })
  });

  describe('workflows endpoint', () => {
    it('returns a list of workflows', async () => {
      const workflows = await apiTestUtils.getWorkflows({ prefix: config.stackName });
      expect(workflows).not.toBe(undefined);

      console.log('workflows', workflows);
    })
  });
});
