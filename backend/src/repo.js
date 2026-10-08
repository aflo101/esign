// DynamoDB single-table data layer.
//
// Layout — one partition per document, so a single Query returns the document, every
// placed field, and the full audit trail in one round trip:
//
//   PK              SK                                   item
//   DOC#<id>        EVT#<millis>#<seq>#<rand>            audit event   (append-only)
//   DOC#<id>        FLD#<order>#<uuid>                   placed field
//   DOC#<id>        META                                 document
//   TOK#<token>     META                                 signing token (Phase 4, TTL'd)
//   USER#<email>    META                                 sender account (invite-only)
//   APIKEY#<sha256> META                                 script API key (hash only)
//   LOGIN#<sha256>  META                                 magic-link token (hash only, TTL'd)
//
// GSI1 (GSI1PK, GSI1SK) indexes a sender's documents: OWNER#<email> / createdAt.
//
// SK prefixes sort EVT < FLD < META, so the Query result is partitioned in code.
// Event SKs use fixed-width epoch millis + a monotonic counter: sequential writes inside
// one invocation can share a millisecond, and a bare timestamp would let the audit trail
// render out of order.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
  UpdateCommand, TransactWriteCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'node:crypto';
import 'dotenv/config';

const TABLE = process.env.DDB_TABLE || 'esign-dev';

let docClient = null;
const db = () => (docClient ||= DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }),
  { marshallOptions: { removeUndefinedValues: true } },
));

const docPk = (id) => `DOC#${id}`;
const pad = (n, w) => String(n).padStart(w, '0');

// 50, not 100: replaceFields transacts deletes of the OLD set plus puts of the NEW set,
// and TransactWriteItems caps at 100 total operations. A limit of 100 fields let the
// FIRST save succeed (100 puts) and then made every subsequent edit throw (100 deletes
// + 100 puts = 200), permanently locking the document's fields.
const FIELD_LIMIT = 50;

// Per-container tiebreaker for events written in the same millisecond by the SAME warm
// container. It resets on cold start and is not unique across containers — cross-container
// ordering is authoritative only to the millisecond, with the random suffix breaking ties
// arbitrarily. 8 random bytes so a cross-container same-millisecond collision (which would
// silently overwrite an audit event) is out of reach; putEvent also refuses to overwrite.
let evtSeq = 0;
const eventSk = () =>
  `EVT#${pad(Date.now(), 13)}#${pad(++evtSeq % 1e6, 6)}#${crypto.randomBytes(8).toString('hex')}`;

// DynamoDB caps a Query response at 1MB and silently pages past it. A single call
// truncates the NEWEST items — for events that means consent_given / document_signed,
// the exact records the evidence package exists to preserve. Always drain the cursor.
async function queryAll(input) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await db().send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(out.Items ?? []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const isConditionFailure = (e) =>
  e?.name === 'ConditionalCheckFailedException' ||
  e?.CancellationReasons?.some(r => r?.Code === 'ConditionalCheckFailed');

// --- documents ---------------------------------------------------------------

export async function createDocument({ id, filename, originalHash, s3KeyOriginal, senderEmail, ownerEmail, accountId }) {
  const createdAt = new Date().toISOString();
  const owner = ownerEmail ? String(ownerEmail).toLowerCase() : null;
  const item = {
    PK: docPk(id), SK: 'META', entity: 'document',
    id, filename, originalHash, s3KeyOriginal,
    senderEmail: senderEmail || null,
    ownerEmail: owner, accountId: accountId || null,
    // Sparse GSI keys: a doc with no owner is simply absent from every sender's list.
    ...(owner ? { GSI1PK: `OWNER#${owner}`, GSI1SK: createdAt } : {}),
    signerEmail: null, signedHash: null, s3KeySigned: null,
    tokenNonce: null, status: 'uploaded',
    createdAt,
  };
  await db().send(new PutCommand({
    TableName: TABLE, Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  return item;
}

export async function getDocument(id, { consistent = false } = {}) {
  const { Item } = await db().send(new GetCommand({
    TableName: TABLE, Key: { PK: docPk(id), SK: 'META' }, ConsistentRead: consistent,
  }));
  return Item || null;
}

/** Mark sent + rotate the token nonce. Rejects an already-executed document. */
export async function markSent({ id, signerEmail, ccEmails = [], tokenNonce, linkExpiresAt }) {
  try {
    // ccEmails is overwritten on every send, not appended to: a re-send re-states who the
    // recipients are, so a cc dropped from the second send must not survive from the first.
    const { Attributes } = await db().send(new UpdateCommand({
      TableName: TABLE, Key: { PK: docPk(id), SK: 'META' },
      UpdateExpression: 'SET signerEmail = :s, ccEmails = :cc, tokenNonce = :n, #st = :sent, sentAt = :at, linkExpiresAt = :exp REMOVE revokedAt',
      // 'signing' blocked too: rotating the nonce mid-submit would fail the in-flight
      // commitSigned after the signer had already completed the document.
      ConditionExpression: 'attribute_exists(PK) AND NOT (#st IN (:signed, :signing))',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':s': signerEmail, ':cc': ccEmails, ':n': tokenNonce, ':sent': 'sent', ':signed': 'signed', ':signing': 'signing',
        ':at': new Date().toISOString(), ':exp': linkExpiresAt ?? null,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null; // already signed
    throw e;
  }
}

/**
 * Revoke every outstanding link: rotate the nonce to a value no token carries, WITHOUT
 * minting a replacement. Refuses signed/signing so a revoke can't race an in-flight submit.
 * Returns null on condition failure (caller maps to 409).
 */
export async function revokeDocument(id) {
  try {
    const { Attributes } = await db().send(new UpdateCommand({
      TableName: TABLE, Key: { PK: docPk(id), SK: 'META' },
      UpdateExpression: 'SET tokenNonce = :n, #st = :r, revokedAt = :t',
      // Only a sent document has live links to kill; revoking an unsent upload is a no-op.
      ConditionExpression: 'attribute_exists(PK) AND #st = :sentst',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':sentst': 'sent',
        ':n': `revoked-${crypto.randomBytes(9).toString('base64url')}`, ':r': 'revoked',
        ':t': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

/** A sender's documents, newest first, via GSI1. Drains pagination. */
export async function listDocumentsByOwner(email) {
  return queryAll({
    TableName: TABLE, IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `OWNER#${String(email).toLowerCase()}` },
    ScanIndexForward: false,
  });
}

/**
 * Atomically take ownership of the signing operation (sent -> signing).
 * Returns null if another submit already holds it, or the document is executed.
 * Without this, two concurrent submits both flatten and race the same S3 key,
 * leaving the committed hash describing a PDF that is no longer in the bucket.
 */
export async function claimForSigning(id) {
  try {
    const { Attributes } = await db().send(new UpdateCommand({
      TableName: TABLE, Key: { PK: docPk(id), SK: 'META' },
      UpdateExpression: 'SET #st = :signing',
      ConditionExpression: '#st = :sent',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':signing': 'signing', ':sent': 'sent' },
      ReturnValues: 'ALL_NEW',
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

/** Release a claim after a failure mid-sign, so the signer isn't locked out forever. */
export async function releaseClaim(id) {
  try {
    await db().send(new UpdateCommand({
      TableName: TABLE, Key: { PK: docPk(id), SK: 'META' },
      UpdateExpression: 'SET #st = :sent',
      ConditionExpression: '#st = :signing',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':sent': 'sent', ':signing': 'signing' },
    }));
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
  }
}

export async function commitSigned({ id, signedHash, s3KeySigned }) {
  await db().send(new UpdateCommand({
    TableName: TABLE, Key: { PK: docPk(id), SK: 'META' },
    UpdateExpression: 'SET signedHash = :h, s3KeySigned = :k, #st = :signed, signedAt = :t',
    ConditionExpression: '#st = :signing',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':h': signedHash, ':k': s3KeySigned, ':signed': 'signed',
      ':signing': 'signing', ':t': new Date().toISOString(),
    },
  }));
}

// --- fields ------------------------------------------------------------------

export async function listFields(docId, { consistent = false } = {}) {
  return queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
    ExpressionAttributeValues: { ':pk': docPk(docId), ':p': 'FLD#' },
    ConsistentRead: consistent,
  }); // already in sortOrder — SK embeds it fixed-width
}

/**
 * Replace the whole field set atomically. DynamoDB has no delete-by-partition, so the
 * old items are queried and their deletes ride in the same transaction as the new puts —
 * a partial write would otherwise leave a mixed old/new field set that a signer could sign.
 */
export async function replaceFields(docId, fields) {
  if (fields.length > FIELD_LIMIT) throw new Error(`too many fields (max ${FIELD_LIMIT})`);
  const existing = await listFields(docId, { consistent: true });

  const items = fields.map((f, i) => {
    const order = Number.isInteger(f.sort_order) ? f.sort_order : i;
    const id = crypto.randomUUID();
    return {
      PK: docPk(docId), SK: `FLD#${pad(order, 4)}#${id}`, entity: 'field',
      id, docId, type: f.type, page: f.page,
      x: f.x, y: f.y, w: f.w, h: f.h,
      required: f.required, sortOrder: order, value: null,
      createdAt: new Date().toISOString(),
    };
  });

  const ops = [
    ...existing.map(e => ({ Delete: { TableName: TABLE, Key: { PK: e.PK, SK: e.SK } } })),
    ...items.map(Item => ({ Put: { TableName: TABLE, Item } })),
  ];
  // TransactWriteItems hard cap. FIELD_LIMIT=50 guarantees deletes+puts fit; this is the
  // backstop in case a legacy document somehow carries more stored fields than the limit.
  if (ops.length > 100) throw new Error('field replacement exceeds transaction limit');
  if (ops.length) await db().send(new TransactWriteCommand({ TransactItems: ops }));
  return items;
}

/** Persist filled values. Signature images are redacted — the PNG lives in the flattened PDF. */
export async function setFieldValues(docId, entries) {
  if (!entries.length) return;
  await db().send(new TransactWriteCommand({
    TransactItems: entries.map(({ sk, value }) => ({
      Update: {
        TableName: TABLE, Key: { PK: docPk(docId), SK: sk },
        UpdateExpression: 'SET #v = :v',
        ExpressionAttributeNames: { '#v': 'value' },
        ExpressionAttributeValues: { ':v': value },
      },
    })),
  }));
}

// --- events ------------------------------------------------------------------

export async function putEvent(docId, { type, actor, ip, userAgent, metadata }) {
  // Append-only is enforced, not assumed: the condition makes an SK collision (two
  // containers, same millisecond, same random suffix) throw instead of silently
  // overwriting an audit event. On that astronomically rare throw, retry with a new SK.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db().send(new PutCommand({
        TableName: TABLE,
        Item: {
          PK: docPk(docId), SK: eventSk(), entity: 'event',
          type, actor: actor || null, ip: ip || null, userAgent: userAgent || null,
          metadata: metadata || {}, createdAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException' && attempt < 3) continue;
      throw e;
    }
  }
}

export async function listEvents(docId) {
  return queryAll({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
    ExpressionAttributeValues: { ':pk': docPk(docId), ':p': 'EVT#' },
  }); // chronological — SK embeds fixed-width millis + counter
}

// --- signing tokens (opaque, revocable, TTL'd) --------------------------------

export async function putToken({ token, docId, signerEmail, nonce, expiresAt }) {
  await db().send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `TOK#${token}`, SK: 'META', entity: 'token',
      docId, signerEmail, nonce,
      expiresAt,                                  // checked in code — authoritative
      ttl: Math.floor(expiresAt / 1000) + 86400,  // GC only; DynamoDB TTL lags by hours
      createdAt: new Date().toISOString(),
    },
  }));
}

export async function getToken(token) {
  const { Item } = await db().send(new GetCommand({
    TableName: TABLE, Key: { PK: `TOK#${token}`, SK: 'META' }, ConsistentRead: true,
  }));
  return Item || null;
}

export async function deleteToken(token) {
  await db().send(new DeleteCommand({ TableName: TABLE, Key: { PK: `TOK#${token}`, SK: 'META' } }));
}

// --- users, API keys, magic-link logins ---------------------------------------

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const normEmail = (e) => String(e ?? '').trim().toLowerCase();

export async function getUser(email) {
  const { Item } = await db().send(new GetCommand({
    TableName: TABLE, Key: { PK: `USER#${normEmail(email)}`, SK: 'META' }, ConsistentRead: true,
  }));
  return Item || null;
}

export async function putUser({ email, name, accountId, role = 'sender', disabled = false }) {
  const item = {
    PK: `USER#${normEmail(email)}`, SK: 'META', entity: 'user',
    email: normEmail(email), name, accountId, role, disabled,
    createdAt: new Date().toISOString(),
  };
  await db().send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

/** Resolve a plaintext API key. Only the hash is stored. */
export async function getApiKey(key) {
  const { Item } = await db().send(new GetCommand({
    TableName: TABLE, Key: { PK: `APIKEY#${sha256hex(key)}`, SK: 'META' },
  }));
  return Item || null;
}

export async function putApiKey({ key, email, label }) {
  await db().send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `APIKEY#${sha256hex(key)}`, SK: 'META', entity: 'apikey',
      email: normEmail(email), label: label || null, createdAt: new Date().toISOString(),
    },
  }));
}

export async function putLoginToken({ token, email, expiresAt }) {
  await db().send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `LOGIN#${sha256hex(token)}`, SK: 'META', entity: 'login',
      email: normEmail(email),
      expiresAt,                                  // checked in code — authoritative
      ttl: Math.floor(expiresAt / 1000) + 86400,  // GC only
    },
  }));
}

/** Single-use: the delete IS the check, so two concurrent verifies can't both win. */
export async function consumeLoginToken(token) {
  try {
    const { Attributes } = await db().send(new DeleteCommand({
      TableName: TABLE, Key: { PK: `LOGIN#${sha256hex(token)}`, SK: 'META' },
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_OLD',
    }));
    return Attributes || null;
  } catch (e) {
    if (isConditionFailure(e)) return null;
    throw e;
  }
}

// --- rate limiting (atomic counter, no WAF) -----------------------------------

/** Returns the count within the current window. Caller decides the threshold. */
export async function bumpRateLimit(bucket, windowSeconds) {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const { Attributes } = await db().send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `RL#${bucket}#${window}`, SK: 'META' },
    UpdateExpression: 'ADD #c :one SET #t = :ttl',
    ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
    ExpressionAttributeValues: {
      ':one': 1,
      ':ttl': (window + 2) * windowSeconds,
    },
    ReturnValues: 'UPDATED_NEW',
  }));
  return Attributes?.count ?? 1;
}

export { TABLE };
