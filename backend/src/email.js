import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import 'dotenv/config';

const FROM = process.env.SES_FROM || 'esign@example.com';
let sesClient = null;
const ses = () => (sesClient ||= new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' }));

export async function sendEmail({ to, subject, html, attachments }) {
  // Console mode — dev default, logs instead of sending.
  if (process.env.EMAIL_MODE === 'console') {
    console.log('\n--- EMAIL (console mode) ---');
    console.log(`From: ${FROM}`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body: ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    if (attachments?.length) console.log(`Attachments: ${attachments.map(a => a.filename).join(', ')}`);
    console.log('---\n');
    return { id: 'console-' + Date.now() };
  }

  if (process.env.EMAIL_MODE === 'ses') {
    const raw = buildMime({ from: FROM, to, subject, html, attachments });
    const out = await ses().send(new SendEmailCommand({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [to] },
      Content: { Raw: { Data: Buffer.from(raw) } },
    }));
    return { id: out.MessageId };
  }

  throw new Error(`EMAIL_MODE=${process.env.EMAIL_MODE || '(unset)'} not supported (use 'console' or 'ses')`);
}

// Build a MIME message (multipart/mixed when attachments present) — dependency-free.
function buildMime({ from, to, subject, html, attachments }) {
  const boundary = 'esign_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${sanitizeHeader(subject)}`,
    'MIME-Version: 1.0',
  ];

  if (!attachments?.length) {
    headers.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return headers.join('\r\n') + '\r\n\r\n' + base64Wrap(Buffer.from(html, 'utf8'));
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [];
  parts.push(
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrap(Buffer.from(html, 'utf8')),
  );
  for (const a of attachments) {
    const ct = a.contentType || 'application/pdf';
    parts.push(
      `--${boundary}`,
      `Content-Type: ${ct}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      base64Wrap(Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content)),
    );
  }
  parts.push(`--${boundary}--`, '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

const sanitizeHeader = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const base64Wrap = (buf) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
