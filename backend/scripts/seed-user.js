// Create/update a sender account. DRY RUN unless --apply.
//   node scripts/seed-user.js --table T --email a@b.com --name "A B" --account ripple --role sender [--apply]
// Idempotent: re-running keeps createdAt and `disabled`, so it can't re-enable a disabled user.
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { parseArgs, ddbDoc } from './_args.js';

const o = parseArgs(['table', 'email', 'name', 'account', 'role']);
if (!['sender', 'admin'].includes(o.role)) { console.error('--role must be sender|admin'); process.exit(2); }
const email = String(o.email).trim().toLowerCase();
const db = ddbDoc();
const key = { PK: `USER#${email}`, SK: 'META' };
const existing = (await db.send(new GetCommand({ TableName: o.table, Key: key }))).Item;
const item = {
  ...key, entity: 'user', email, name: o.name, accountId: o.account, role: o.role,
  disabled: existing?.disabled ?? false, createdAt: existing?.createdAt ?? new Date().toISOString(),
};
console.log(existing ? 'UPDATE' : 'CREATE', JSON.stringify(item));
if (o.apply) { await db.send(new PutCommand({ TableName: o.table, Item: item })); console.log('written.'); }
else console.log('dry run — pass --apply to write.');
