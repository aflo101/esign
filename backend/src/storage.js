import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import 'dotenv/config';

export const s3 = new S3Client({ region: process.env.AWS_REGION });
export const BUCKET = process.env.S3_BUCKET;

// Presigned URLs keep PDF bytes out of the Lambda request/response path, which is capped
// at 6MB. They are bearer credentials for one object, so the window is deliberately short.
const PUT_TTL = 300;  // 5 min — the sender is uploading right now
const GET_TTL = 900;  // 15 min — long enough to open and read a document

export const presignPut = (key, contentType = 'application/pdf') =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }), { expiresIn: PUT_TTL });

export const presignGet = (key, downloadAs = null) =>
  getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET, Key: key,
    ...(downloadAs ? { ResponseContentDisposition: `attachment; filename="${downloadAs.replace(/"/g, '')}"` } : {}),
  }), { expiresIn: GET_TTL });

export async function headObject(key) {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: out.ContentLength, contentType: out.ContentType };
  } catch {
    return null;
  }
}

export async function putObject(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getObject(key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
