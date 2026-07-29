import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

export const s3 = new S3Client({ region: process.env.AWS_REGION });
export const BUCKET = process.env.S3_BUCKET;

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
