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
const FIELD_LIMIT = 100; // keeps replaceFields inside one TransactWriteItems call

let evtSeq = 0;
const eventSk = () =>
  `EVT#${pad(Date.now(), 13)}#${pad(++evtSeq % 1e6, 6)}#${crypto.randomBytes(3).toString('hex')}`;

const isConditionFailure = (e) =>
  e?.name === 'ConditionalCheckFailedException' ||
  e?.CancellationReasons?.some(r => r?.Code === 'ConditionalCheckFailed');

// --- documents ---------------------------------------------------------------

export async function createDocument({ id, filename, originalHash, s3KeyOriginal, senderEmail }) {
  const item = {
    PK: docPk(id), SK: 'META', entity: 'document',
    id, filename, originalHash, s3KeyOriginal,
    senderEmail: senderEmail || null,
    signerEmail: null, signedHash: null, s3KeySigned: null,
    tokenNonce: null, status: 'uploaded',
    createdAt: new Date().toISOString(),
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
export async function markSent({ id, signerEmail, tokenNonce }) {
  try {
    const { Attributes } = await db().send(new UpdateCommand({
      TableName: TABLE, Key: { PK: docPk(id), SK: 'META' },
      UpdateExpression: 'SET signerEmail = :s, tokenNonce = :n, #st = :sent',
      ConditionExpression: 'attribute_exists(PK) AND #st <> :signed',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':s': signerEmail, ':n': tokenNonce, ':sent': 'sent', ':signed': 'signed' },
      ReturnValues: 'ALL_NEW',
    }));
    return Attributes;
  } catch (e) {
    if (isConditionFailure(e)) return null; // already signed
    throw e;
  }
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
  const { Items = [] } = await db().send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
    ExpressionAttributeValues: { ':pk': docPk(docId), ':p': 'FLD#' },
    ConsistentRead: consistent,
  }));
  return Items; // already in sortOrder — SK embeds it fixed-width
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
  if (ops.length > FIELD_LIMIT) throw new Error('field replacement exceeds transaction limit');
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
  await db().send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: docPk(docId), SK: eventSk(), entity: 'event',
      type, actor: actor || null, ip: ip || null, userAgent: userAgent || null,
      metadata: metadata || {}, createdAt: new Date().toISOString(),
    },
  }));
}

export async function listEvents(docId) {
  const { Items = [] } = await db().send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
    ExpressionAttributeValues: { ':pk': docPk(docId), ':p': 'EVT#' },
  }));
  return Items; // chronological — SK embeds fixed-width millis + counter
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
