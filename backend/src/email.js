import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import 'dotenv/config';

const FROM = process.env.SES_FROM || 'esign@example.com';
const FROM_NAME = process.env.SES_FROM_NAME || 'esign';
const REPLY_TO = process.env.SES_REPLY_TO || null;
const CONFIG_SET = process.env.SES_CONFIGURATION_SET || null;

let sesClient = null;
const ses = () => (sesClient ||= new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' }));

const fromHeader = () => `${encodeWord(FROM_NAME)} <${FROM}>`;

export async function sendEmail({ to, subject, html, text, attachments }) {
  // Console mode — dev default, logs instead of sending.
  if (process.env.EMAIL_MODE === 'console') {
    console.log('\n--- EMAIL (console mode) ---');
    console.log(`From: ${fromHeader()}`);
    if (REPLY_TO) console.log(`Reply-To: ${REPLY_TO}`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (attachments?.length) console.log(`Attachments: ${attachments.map(a => a.filename).join(', ')}`);
    console.log('---\n');
    return { id: 'console-' + Date.now() };
  }

  if (process.env.EMAIL_MODE === 'ses') {
    const raw = buildMime({ from: fromHeader(), to, replyTo: REPLY_TO, subject, html, text, attachments });
    const out = await ses().send(new SendEmailCommand({
      FromEmailAddress: fromHeader(),
      Destination: { ToAddresses: [to] },
      ...(REPLY_TO ? { ReplyToAddresses: [REPLY_TO] } : {}),
      ...(CONFIG_SET ? { ConfigurationSetName: CONFIG_SET } : {}),
      Content: { Raw: { Data: Buffer.from(raw) } },
    }));
    return { id: out.MessageId };
  }

  throw new Error(`EMAIL_MODE=${process.env.EMAIL_MODE || '(unset)'} not supported (use 'console' or 'ses')`);
}

// Build a MIME message — dependency-free.
//   no attachments: multipart/alternative [text, html]
//   attachments:    multipart/mixed [ multipart/alternative [text, html], ...files ]
// The plain-text part isn't optional politeness: a lone text/html body is a well-known
// spam signal, and this mail needs to reach an inbox on first contact.
export function buildMime({ from, to, replyTo, subject, html, text, attachments }) {
  const plain = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const altBoundary = boundary('alt');

  const headers = [
    `From: ${from}`,
    `To: ${sanitizeHeader(to)}`,
    ...(replyTo ? [`Reply-To: ${sanitizeHeader(replyTo)}`] : []),
    `Subject: ${encodeWord(sanitizeHeader(subject))}`,
    'MIME-Version: 1.0',
  ];

  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrap(Buffer.from(plain, 'utf8')),
    `--${altBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrap(Buffer.from(html, 'utf8')),
    `--${altBoundary}--`,
  ];

  if (!attachments?.length) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    return headers.join('\r\n') + '\r\n\r\n' + alternative.join('\r\n') + '\r\n';
  }

  const mixBoundary = boundary('mix');
  headers.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`);

  const parts = [
    `--${mixBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    ...alternative,
  ];

  for (const a of attachments) {
    const name = encodeWord(sanitizeHeader(a.filename));
    parts.push(
      `--${mixBoundary}`,
      `Content-Type: ${a.contentType || 'application/pdf'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      base64Wrap(Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content)),
    );
  }
  parts.push(`--${mixBoundary}--`, '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

const boundary = (tag) => `esign_${tag}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const sanitizeHeader = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const base64Wrap = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');

// RFC 2047 — headers are ASCII-only, so a non-ASCII filename in a subject must be encoded.
const encodeWord = (s) =>
  /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
