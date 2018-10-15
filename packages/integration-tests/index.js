/* eslint no-param-reassign: "off" */

'use strict';

const orderBy = require('lodash.orderby');
const Handlebars = require('handlebars');
const uuidv4 = require('uuid/v4');
const fs = require('fs-extra');
const pLimit = require('p-limit');
const {
  aws: {
    dynamodb,
    ecs,
    s3,
    sfn
  },
  stepFunctions: {
    describeExecution,
    getExecutionHistory
  }
} = require('@cumulus/common');
const {
  models: { Provider, Collection, Rule }
} = require('@cumulus/api');

const sfnStep = require('./sfnStep');
const api = require('./api/api');
const rulesApi = require('./api/rules');
const cmr = require('./cmr.js');
const lambda = require('./lambda');
const granule = require('./granule.js');

/**
 * Wait for the defined number of milliseconds
 *
 * @param {number} waitPeriod - number of milliseconds to wait
 * @returns {Promise.<undefined>} - promise resolves after a given time period
 */
function sleep(waitPeriod) {
  return new Promise((resolve) => setTimeout(resolve, waitPeriod));
}

/**
 * Wait for an AsyncOperation to reach a given status
 *
 * Retries every 2 seconds until the expected status has been reached or the
 *   number of retries has been exceeded.
 *
 * @param {Object} params - params
 * @param {string} params.TableName - the name of the AsyncOperations DynamoDB
 *   table
 * @param {string} params.id - the id of the AsyncOperation
 * @param {string} params.status - the status to wait for
 * @param {integer} params.retries - the number of times to retry Default: 5
 * @returns {Promise<Object>} - the AsyncOperation object
 */
async function waitForAsyncOperationStatus({
  TableName,
  id,
  status,
  retries = 5
}) {
  const { Item } = await dynamodb().getItem({
    TableName,
    Key: { id: { S: id } }
  }).promise();

  if (Item.status.S === status || retries <= 0) return Item;

  await sleep(2000);
  return waitForAsyncOperationStatus({
    TableName,
    id,
    status,
    retries: retries - 1
  });
}

/**
 * Return the ARN of the Cumulus ECS cluster
 *
 * @param {string} stackName - the Cumulus stack name
 * @returns {string|undefined} - the cluster ARN or undefined if not found
 */
async function getClusterArn(stackName) {
  const clusterPrefix = `${stackName}-CumulusECSCluster-`;
  const listClustersResponse = await ecs().listClusters().promise();
  return listClustersResponse.clusterArns.find((arn) => arn.includes(clusterPrefix));
}

/**
 * Get the template JSON from S3 for the workflow
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @returns {Promise.<Object>} template as a JSON object
 */
function getWorkflowTemplate(stackName, bucketName, workflowName) {
  const key = `${stackName}/workflows/${workflowName}.json`;
  return s3().getObject({ Bucket: bucketName, Key: key }).promise()
    .then((templateJson) => JSON.parse(templateJson.Body.toString()));
}

/**
 * Get the workflow ARN for the given workflow from the
 * template stored on S3
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @returns {Promise.<string>} - workflow arn
 */
function getWorkflowArn(stackName, bucketName, workflowName) {
  return getWorkflowTemplate(stackName, bucketName, workflowName)
    .then((template) => template.cumulus_meta.state_machine);
}

/**
 * Get the status of a given execution
 *
 * If the execution does not exist, this will return 'RUNNING'.  This seems
 * surprising in the "don't surprise users of your code" sort of way.  If it
 * does not exist then the calling code should probably know that.  Something
 * to be refactored another day.
 *
 * @param {string} executionArn - ARN of the execution
 * @param {Object} [retryOptions] - see the options described [here](https://github.com/tim-kos/node-retry#retrytimeoutsoptions)
 * @returns {Promise<string>} status
 */
async function getExecutionStatus(executionArn, retryOptions) {
  try {
    const execution = await describeExecution(executionArn, retryOptions);
    return execution.status;
  }
  catch (err) {
    throw err;
  }
}

/**
 * Wait for a given execution to complete, then return the status
 *
 * @param {string} executionArn - ARN of the execution
 * @param {number} [timeout=600] - the time, in seconds, to wait for the
 *   execution to reach a non-RUNNING state
 * @returns {string} status
 */
async function waitForCompletedExecution(executionArn, timeout = 600) {
  let executionStatus;
  let iteration = 0;
  const sleepPeriodMs = 5000;
  const maxMinutesWaitedForExecutionStart = 5;
  const iterationsPerMinute = Math.floor(60000 / sleepPeriodMs);
  const maxIterationsToStart = Math.floor(maxMinutesWaitedForExecutionStart * iterationsPerMinute);

  const stopTime = Date.now() + (timeout * 1000);

  /* eslint-disable no-await-in-loop */
  do {
    iteration += 1;
    try {
      executionStatus = await getExecutionStatus(executionArn);
    }
    catch (err) {
      if (!(err.code === 'ExecutionDoesNotExist') || iteration > maxIterationsToStart) {
        console.log(`waitForCompletedExecution failed: ${err.code}, arn: ${executionArn}`);
        throw err;
      }
      console.log("Execution does not exist... assuming it's still starting up.");
      executionStatus = 'STARTING';
    }
    if (executionStatus === 'RUNNING') {
      // Output a 'heartbeat' every minute
      if (!(iteration % iterationsPerMinute)) console.log('Execution running....');
    }
    await sleep(sleepPeriodMs);
  } while (['RUNNING', 'STARTING'].includes(executionStatus) && Date.now() < stopTime);
  /* eslint-enable no-await-in-loop */

  if (executionStatus === 'RUNNING') {
    const executionHistory = await getExecutionHistory({
      executionArn: executionArn, maxResults: 100
    });
    console.log(`waitForCompletedExecution('${executionArn}') timed out after ${timeout} seconds`);
    console.log('Execution History:');
    console.log(executionHistory);
  }
  return executionStatus;
}

/**
 * Kick off a workflow execution
 *
 * @param {string} workflowArn - ARN for the workflow
 * @param {string} workflowMsg - workflow message
 * @returns {Promise.<Object>} execution details: {executionArn, startDate}
 */
async function startWorkflowExecution(workflowArn, workflowMsg) {
  // Give this execution a unique name
  workflowMsg.cumulus_meta.execution_name = uuidv4();
  workflowMsg.cumulus_meta.workflow_start_time = Date.now();
  workflowMsg.cumulus_meta.state_machine = workflowArn;

  const workflowParams = {
    stateMachineArn: workflowArn,
    input: JSON.stringify(workflowMsg),
    name: workflowMsg.cumulus_meta.execution_name
  };

  return sfn().startExecution(workflowParams).promise();
}

/**
 * Start the workflow and return the execution Arn. Does not wait
 * for workflow completion.
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @param {string} workflowMsg - workflow message
 * @returns {string} - executionArn
 */
async function startWorkflow(stackName, bucketName, workflowName, workflowMsg) {
  const workflowArn = await getWorkflowArn(stackName, bucketName, workflowName);
  const { executionArn } = await startWorkflowExecution(workflowArn, workflowMsg);

  console.log(`\nStarting workflow: ${workflowName}. Execution ARN ${executionArn}`);

  return executionArn;
}

/**
 * Execute the given workflow.
 * Wait for workflow to complete to get the status
 * Return the execution arn and the workflow status.
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @param {string} workflowMsg - workflow message
 * @param {number} [timeout=600] - number of seconds to wait for execution to complete
 * @returns {Object} - {executionArn: <arn>, status: <status>}
 */
async function executeWorkflow(stackName, bucketName, workflowName, workflowMsg, timeout = 600) {
  const executionArn = await startWorkflow(stackName, bucketName, workflowName, workflowMsg);

  // Wait for the execution to complete to get the status
  const status = await waitForCompletedExecution(executionArn, timeout);

  return { status, executionArn };
}

/**
 * Test the given workflow and report whether the workflow failed or succeeded
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @param {string} inputFile - path to input JSON file
 * @returns {*} undefined
 */
async function testWorkflow(stackName, bucketName, workflowName, inputFile) {
  try {
    const rawInput = await fs.readFile(inputFile, 'utf8');
    const parsedInput = JSON.parse(rawInput);
    const workflowStatus = await executeWorkflow(stackName, bucketName, workflowName, parsedInput);

    if (workflowStatus.status === 'SUCCEEDED') {
      console.log(`Workflow ${workflowName} execution succeeded.`);
    }
    else {
      console.log(`Workflow ${workflowName} execution failed with state: ${workflowStatus.status}`);
    }
  }
  catch (err) {
    console.log(`Error executing workflow ${workflowName}. Error: ${err}`);
  }
}

/**
 * set process environment necessary for database transactions
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @returns {*} undefined
 */
function setProcessEnvironment(stackName, bucketName) {
  process.env.internal = bucketName;
  process.env.bucket = bucketName;
  process.env.stackName = stackName;
  process.env.kinesisConsumer = `${stackName}-kinesisConsumer`;
  process.env.CollectionsTable = `${stackName}-CollectionsTable`;
  process.env.ProvidersTable = `${stackName}-ProvidersTable`;
  process.env.RulesTable = `${stackName}-RulesTable`;
}

const concurrencyLimit = process.env.CONCURRENCY || 3;
const limit = pLimit(concurrencyLimit);

/**
 * Set environment variables and read in seed files from dataDirectory
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} dataDirectory - the directory of collection json files
 * @returns {Array} List of objects to seed in the database
 */
async function setupSeedData(stackName, bucketName, dataDirectory) {
  setProcessEnvironment(stackName, bucketName);
  const filenames = await fs.readdir(dataDirectory);
  const seedItems = [];
  filenames.forEach((filename) => {
    if (filename.match(/.*\.json/)) {
      const item = JSON.parse(fs.readFileSync(`${dataDirectory}/${filename}`, 'utf8'));
      seedItems.push(item);
    }
  });
  return seedItems;
}

/**
 * add collections to database
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} dataDirectory - the directory of collection json files
 * @param {string} postfix - string to append to collection name
 * @returns {Promise.<number>} number of collections added
 */
async function addCollections(stackName, bucketName, dataDirectory, postfix) {
  const collections = await setupSeedData(stackName, bucketName, dataDirectory);
  const promises = collections.map((collection) => limit(() => {
    if (postfix) {
      collection.name += postfix;
      collection.dataType += postfix;
    }
    const c = new Collection();
    console.log(`adding collection ${collection.name}___${collection.version}`);
    return c.delete({ name: collection.name, version: collection.version })
      .then(() => c.create(collection));
  }));
  return Promise.all(promises).then((cs) => cs.length);
}

/**
 * Return a list of collections
 *
 * @param {string} stackName - CloudFormation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} dataDirectory - the directory of collection json files
 * @returns {Promise.<Array>} list of collections
 */
async function listCollections(stackName, bucketName, dataDirectory) {
  return setupSeedData(stackName, bucketName, dataDirectory);
}

/**
 * Delete collections from database
 *
 * @param {string} stackName - CloudFormation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {Array} collections - List of collections to delete
 * @param {string} postfix - string that was appended to collection name
 * @returns {Promise.<number>} number of deleted collections
 */
async function deleteCollections(stackName, bucketName, collections, postfix) {
  setProcessEnvironment(stackName, bucketName);

  const promises = collections.map((collection) => {
    if (postfix) {
      collection.name += postfix;
      collection.dataType += postfix;
    }
    const c = new Collection();
    console.log(`\nDeleting collection ${collection.name}__${collection.version}`);
    return c.delete({ name: collection.name, version: collection.version });
  });

  return Promise.all(promises).then((cs) => cs.length);
}

/**
 * Delete all collections listed from a collections directory
 *
 * @param {string} stackName - CloudFormation stack name
 * @param {string} bucket - S3 internal bucket name
 * @param {string} collectionsDirectory - the directory of collection json files
 * @param {string} postfix - string that was appended to collection name
 * @returns {number} - number of deleted collections
 */
async function cleanupCollections(stackName, bucket, collectionsDirectory, postfix) {
  const collections = await listCollections(stackName, bucket, collectionsDirectory);
  return deleteCollections(stackName, bucket, collections, postfix);
}

/**
 * add providers to database.
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} dataDirectory - the directory of provider json files
 * @param {string} s3Host - bucket name to be used as the provider host for
 * S3 providers. This will override the host from the seed data. Defaults to null,
 * meaning no override.
 * @param {string} postfix - string to append to provider id
 * @returns {Promise.<number>} number of providers added
 */
async function addProviders(stackName, bucketName, dataDirectory, s3Host = null, postfix) {
  const providers = await setupSeedData(stackName, bucketName, dataDirectory);

  const promises = providers.map((provider) => limit(() => {
    if (postfix) {
      provider.id += postfix;
    }
    const p = new Provider();
    if (s3Host && provider.protocol === 's3') {
      provider.host = s3Host;
    }
    console.log(`adding provider ${provider.id}`);
    return p.delete({ id: provider.id }).then(() => p.create(provider));
  }));
  return Promise.all(promises).then((ps) => ps.length);
}

/**
 * Return a list of providers
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} dataDirectory - the directory of provider json files
 * @returns {Promise.<Array>} list of providers
 */
async function listProviders(stackName, bucketName, dataDirectory) {
  return setupSeedData(stackName, bucketName, dataDirectory);
}

/**
 * Delete providers from database
 *
 * @param {string} stackName - CloudFormation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {Array} providers - List of providers to delete
 * @param {string} postfix - string that was appended to provider id
 * @returns {Promise.<number>} number of deleted providers
 */
async function deleteProviders(stackName, bucketName, providers, postfix) {
  setProcessEnvironment(stackName, bucketName);

  const promises = providers.map((provider) => {
    if (postfix) {
      provider.id += postfix;
    }
    const p = new Provider();
    console.log(`\nDeleting provider ${provider.id}`);
    return p.delete({ id: provider.id });
  });

  return Promise.all(promises).then((ps) => ps.length);
}

/**
 * Delete all collections listed from a collections directory
 *
 * @param {string} stackName - CloudFormation stack name
 * @param {string} bucket - S3 internal bucket name
 * @param {string} providersDirectory - the directory of collection json files
 * @param {string} postfix - string that was appended to provider id
 * @returns {number} - number of deleted collections
 */
async function cleanupProviders(stackName, bucket, providersDirectory, postfix) {
  const providers = await listProviders(stackName, bucket, providersDirectory);
  return deleteProviders(stackName, bucket, providers, postfix);
}

/**
 * add rules to database
 *
 * @param {string} config - Test config used to set environmenet variables and template rules data
 * @param {string} dataDirectory - the directory of rules json files
 * @param {string} overrides - override rule fields
 * @returns {Promise.<number>} number of rules added
 */
async function addRules(config, dataDirectory, overrides) {
  const { stackName, bucket } = config;
  const rules = await setupSeedData(stackName, bucket, dataDirectory);

  const promises = rules.map((rule) => limit(() => {
    rule = Object.assign(rule, overrides);
    const ruleTemplate = Handlebars.compile(JSON.stringify(rule));
    const templatedRule = JSON.parse(ruleTemplate(config));
    const r = new Rule();
    console.log(`adding rule ${templatedRule.name}`);
    return r.create(templatedRule);
  }));
  return Promise.all(promises).then((rs) => rs.length);
}

/**
 * deletes a rule by name
 *
 * @param {string} name - name of the rule to delete.
 * @returns {Promise.<dynamodbDocClient.delete>} - superclass delete promise
 */
async function _deleteOneRule(name) {
  const r = new Rule();
  return r.get({ name: name }).then((item) => r.delete(item));
}


/**
 * returns a list of rule objects
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} rulesDirectory - The directory continaing rules json files
 * @returns {list} - list of rules found in rulesDirectory
 */
async function rulesList(stackName, bucketName, rulesDirectory) {
  return setupSeedData(stackName, bucketName, rulesDirectory);
}

/**
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {Array} rules - List of rules objects to delete
 * @param {string} postfix - string that was appended to provider id
 * @returns {Promise.<number>} - Number of rules deleted
 */
async function deleteRules(stackName, bucketName, rules, postfix) {
  setProcessEnvironment(stackName, bucketName);
  const promises = rules.map((rule) => {
    if (postfix) {
      rule.name += postfix;
    }
    return limit(() => _deleteOneRule(rule.name));
  });
  return Promise.all(promises).then((rs) => rs.length);
}

/**
 * build workflow message
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @param {Object} collection - collection information
 * @param {Object} collection.name - collection name
 * @param {Object} collection.version - collection version
 * @param {Object} provider - provider information
 * @param {Object} provider.id - provider id
 * @param {Object} payload - payload information
 * @returns {Promise.<string>} workflow message
 */
async function buildWorkflow(stackName, bucketName, workflowName, collection, provider, payload) {
  setProcessEnvironment(stackName, bucketName);
  const template = await getWorkflowTemplate(stackName, bucketName, workflowName);
  let collectionInfo = {};
  if (collection) {
    collectionInfo = await new Collection()
      .get({ name: collection.name, version: collection.version });
  }
  let providerInfo = {};
  if (provider) {
    providerInfo = await new Provider().get({ id: provider.id });
  }
  template.meta.collection = collectionInfo;
  template.meta.provider = providerInfo;
  template.payload = payload || {};
  return template;
}
/**
 * build workflow message and execute the workflow
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @param {Object} collection - collection information
 * @param {Object} collection.name - collection name
 * @param {Object} collection.version - collection version
 * @param {Object} provider - provider information
 * @param {Object} provider.id - provider id
 * @param {Object} payload - payload information
 * @param {number} [timeout=600] - number of seconds to wait for execution to complete
 * @returns {Object} - {executionArn: <arn>, status: <status>}
 */
async function buildAndExecuteWorkflow(
  stackName,
  bucketName,
  workflowName,
  collection,
  provider,
  payload,
  timeout = 600
) {
  const workflowMsg = await buildWorkflow(
    stackName,
    bucketName,
    workflowName,
    collection,
    provider,
    payload
  );
  return executeWorkflow(stackName, bucketName, workflowName, workflowMsg, timeout);
}

/**
 * build workflow message and start the workflow. Does not wait
 * for workflow completion.
 *
 * @param {string} stackName - Cloud formation stack name
 * @param {string} bucketName - S3 internal bucket name
 * @param {string} workflowName - workflow name
 * @param {Object} collection - collection information
 * @param {Object} collection.name - collection name
 * @param {Object} collection.version - collection version
 * @param {Object} provider - provider information
 * @param {Object} provider.id - provider id
 * @param {Object} payload - payload information
 * @returns {string} - executionArn
 */
async function buildAndStartWorkflow(
  stackName,
  bucketName,
  workflowName,
  collection,
  provider,
  payload
) {
  const workflowMsg = await
  buildWorkflow(stackName, bucketName, workflowName, collection, provider, payload);
  return startWorkflow(stackName, bucketName, workflowName, workflowMsg);
}

/**
 * returns the most recently executed workflows for the workflow type.
 *
 * @param {string} workflowName - name of the workflow to get executions for
 * @param {string} stackName - stack name
 * @param {string} bucket - S3 internal bucket name
 * @param {Integer} maxExecutionResults - max results to return
 * @returns {Array<Object>} array of state function executions.
 */
async function getExecutions(workflowName, stackName, bucket, maxExecutionResults = 10) {
  const kinesisTriggerTestStpFnArn = await getWorkflowArn(stackName, bucket, workflowName);
  const data = await sfn().listExecutions({
    stateMachineArn: kinesisTriggerTestStpFnArn,
    maxResults: maxExecutionResults
  }).promise();
  return (orderBy(data.executions, 'startDate', 'desc'));
}

module.exports = {
  api,
  rulesApi,
  buildWorkflow,
  testWorkflow,
  executeWorkflow,
  buildAndExecuteWorkflow,
  buildAndStartWorkflow,
  getWorkflowTemplate,
  waitForCompletedExecution,
  ActivityStep: sfnStep.ActivityStep,
  LambdaStep: sfnStep.LambdaStep,
  /**
   * @deprecated Since version 1.3. To be deleted version 2.0.
   * Use sfnStep.LambdaStep.getStepOutput instead.
   */
  getLambdaOutput: new sfnStep.LambdaStep().getStepOutput,
  addCollections,
  listCollections,
  deleteCollections,
  cleanupCollections,
  addProviders,
  listProviders,
  deleteProviders,
  cleanupProviders,
  conceptExists: cmr.conceptExists,
  getOnlineResources: cmr.getOnlineResources,
  generateCmrFilesForGranules: cmr.generateCmrFilesForGranules,
  addRules,
  deleteRules,
  getClusterArn,
  getWorkflowArn,
  rulesList,
  sleep,
  timeout: sleep,
  waitForAsyncOperationStatus,
  getWorkflowArn,
  getLambdaVersions: lambda.getLambdaVersions,
  getLambdaAliases: lambda.getLambdaAliases,
  waitForConceptExistsOutcome: cmr.waitForConceptExistsOutcome,
  waitUntilGranuleStatusIs: granule.waitUntilGranuleStatusIs,
  getExecutions
};
