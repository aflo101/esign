// Assign an owner to every DOC META item that has none. DRY RUN unless --apply.
//   node scripts/backfill-owners.js --table T --owner a@b.com --account ripple [--apply]
// Never overwrites an existing ownerEmail (conditional write), so it is safe to re-run.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { parseArgs, ddbDoc } from './_args.js';

const o = parseArgs(['table', 'owner', 'account']);
const owner = String(o.owner).trim().toLowerCase();
const db = ddbDoc();
let todo = 0, done = 0, owned = 0, startKey;
do {
  const r = await db.send(new ScanCommand({
    TableName: o.table, ExclusiveStartKey: startKey,
    FilterExpression: 'begins_with(PK, :d) AND SK = :m',
    ExpressionAttributeValues: { ':d': 'DOC#', ':m': 'META' },
  }));
  for (const d of r.Items || []) {
    if (d.ownerEmail) { owned++; continue; }
    todo++;
    console.log(`${o.apply ? 'ASSIGN' : 'would assign'} ${d.PK} (${d.filename || '?'}, ${d.status || '?'}) -> ${owner}`);
    if (!o.apply) continue;
    try {
      await db.send(new UpdateCommand({
        TableName: o.table, Key: { PK: d.PK, SK: 'META' },
        ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(ownerEmail)',
        UpdateExpression: 'SET ownerEmail = :o, accountId = :a, GSI1PK = :g, GSI1SK = :c',
        ExpressionAttributeValues: { ':o': owner, ':a': o.account, ':g': `OWNER#${owner}`, ':c': d.createdAt || new Date(0).toISOString() },
      }));
      done++;
    } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
  }
  startKey = r.LastEvaluatedKey;
} while (startKey);
console.log(`${owned} already owned; ${todo} unowned; ${o.apply ? done + ' assigned' : 'dry run — pass --apply to write'}.`);
