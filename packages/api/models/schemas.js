'use strict';

// Ingest Rule Record Schema
module.exports.rule = {
  title: 'Ingest Rule Record Object',
  type: 'object',
  properties: {
    name: {
      title: 'name',
      type: 'string'
    },
    workflow: {
      title: 'Workflow Name',
      type: 'string'
    },
    provider: {
      title: 'Provider ID',
      type: 'string'
    },
    collection: {
      title: 'Collection Name and Version',
      type: 'object',
      properties: {
        name: {
          title: 'Collection Name',
          type: 'string'
        },
        version: {
          title: 'Collection Version',
          type: 'string'
        }
      },
      required: ['name', 'version']
    },
    meta: {
      title: 'Optional MetaData for the Rule',
      type: 'object'
    },
    rule: {
      title: 'Ingest Rule',
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['onetime', 'scheduled', 'sns', 'kinesis']
        },
        value: {
          type: 'string'
        },
        arn: {
          type: 'string',
          readonly: true
        }
      },
      required: ['type']
    },
    state: {
      title: 'Rule state',
      type: 'string',
      enum: ['ENABLED', 'DISABLED']
    },
    createdAt: {
      type: 'number',
      readonly: true
    },
    updatedAt: {
      type: 'number',
      readonly: true
    },
    tags: {
      title: 'Optional tags for search',
      type: 'array',
      items: {
        type: 'string'
      }
    }
  },
  require: ['name', 'workflow', 'collection', 'rule', 'state']
};

// Execution Schema => the model keeps information about each step function execution
module.exports.execution = {
  title: 'Execution Object',
  description: 'Keep the information about each step function execution',
  type: 'object',
  properties: {
    arn: {
      title: 'Execution arn (this field is unique)',
      type: 'string'
    },
    name: {
      title: 'Execution name',
      type: 'string'
    },
    execution: {
      title: 'The execution page url on AWS console',
      type: 'string'
    },
    error: {
      title: 'The error details in case of a failed execution',
      type: 'object'
    },
    type: {
      title: 'The workflow name, e.g. IngestGranule',
      type: 'string'
    },
    status: {
      title: 'the execution status',
      enum: ['running', 'completed', 'failed', 'unknown'],
      type: 'string'
    },
    createdAt: {
      type: 'number',
      readonly: true
    },
    timestamp: {
      type: 'number',
      readonly: true
    }
  },
  required: [
    'arn',
    'name',
    'status',
    'createdAt'
  ]
};
