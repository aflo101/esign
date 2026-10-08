// Shared by the ops scripts: tiny --flag value parser + DynamoDB doc client.
// Region defaults to us-east-1; credentials come from the default AWS chain.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export function parseArgs(required) {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] === undefined || a[i + 1].startsWith('--')) ? true : a[++i];
  }
  const missing = required.filter(k => !o[k] || o[k] === true);
  if (missing.length) {
    console.error(`Missing required: ${missing.map(k => '--' + k).join(', ')}`);
    process.exit(2);
  }
  return o;
}

export function ddbDoc() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }),
    { marshallOptions: { removeUndefinedValues: true } });
}
