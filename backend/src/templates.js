// Transactional email templates. Table-based, inline-styled, 600px — the only layout
// that survives Outlook. Every interpolated value passes through esc(): filenames and
// email addresses are user-supplied and would otherwise inject markup into the message.

const ACCENT = '#2563eb';
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

// Shell: wordmark header, white card, footer.
function layout({ heading, bodyHtml, footerNote }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

    <tr><td style="padding:0 0 20px 4px;font-family:${FONT};font-size:17px;font-weight:700;color:${INK};letter-spacing:-0.2px;">
      esign
    </td></tr>

    <tr><td style="background:#ffffff;border:1px solid ${RULE};border-radius:10px;padding:32px;font-family:${FONT};">
      <div style="font-size:20px;font-weight:700;color:${INK};line-height:1.35;margin:0 0 20px;">${heading}</div>
      ${bodyHtml}
    </td></tr>

    <tr><td style="padding:18px 4px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
      ${footerNote}
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px;">
  <tr><td bgcolor="${ACCENT}" style="border-radius:6px;">
    <a href="${esc(href)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>
  </td></tr></table>`;
}

const row = (label, value) =>
  `<tr><td style="padding:5px 14px 5px 0;font-family:${FONT};font-size:13px;color:${MUTED};white-space:nowrap;vertical-align:top;">${label}</td>
       <td style="padding:5px 0;font-family:${FONT};font-size:13px;color:${INK};word-break:break-all;">${value}</td></tr>`;

/** Signature request — the envelope email. */
export function signatureRequestEmail({ senderName, senderEmail, filename, link, expiresDays = 7 }) {
  const who = esc(senderName || senderEmail || 'A sender');
  const doc = esc(filename);

  const bodyHtml = `
    <p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">
      <strong>${who}</strong> has sent you a document to review and sign.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f9fafb;border:1px solid ${RULE};border-radius:6px;margin:0 0 22px;">
      <tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;font-weight:600;color:${INK};word-break:break-word;">${doc}</td></tr>
    </table>
    ${button(link, 'Review &amp; sign')}
    <p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">
      This link is unique to you and expires in ${expiresDays} days. If the button doesn't work, paste this into your browser:<br>
      <span style="color:${ACCENT};word-break:break-all;">${esc(link)}</span>
    </p>`;

  const text = `${senderName || senderEmail || 'A sender'} has sent you a document to review and sign.

Document: ${filename}

Review and sign:
${link}

This link is unique to you and expires in ${expiresDays} days.

If you weren't expecting this, you can ignore this message.`;

  return {
    subject: `Signature requested: ${filename}`,
    html: layout({
      heading: 'You have a document to sign',
      bodyHtml,
      footerNote: `Sent via esign on behalf of ${esc(senderEmail || '')}. If you weren't expecting this, you can ignore this message.`,
    }),
    text,
  };
}

/** Completion — signed PDF + evidence package attached, to both parties. */
export function completionEmail({ filename, signerEmail, originalHash, signedHash, signedAt }) {
  const doc = esc(filename);

  const bodyHtml = `
    <p style="margin:0 0 20px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">
      <strong>${doc}</strong> has been signed by ${esc(signerEmail)}. The signed document and its
      evidence package are attached.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f9fafb;border:1px solid ${RULE};border-radius:6px;">
      <tr><td style="padding:14px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
          ${row('Signed by', esc(signerEmail))}
          ${row('Completed', esc(signedAt))}
          ${row('Original SHA-256', `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;">${esc(originalHash)}</span>`)}
          ${row('Signed SHA-256', `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;">${esc(signedHash)}</span>`)}
        </table>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">
      The hashes above let either party verify the attached files haven't been altered since signing.
    </p>`;

  const text = `${filename} has been signed by ${signerEmail}.

The signed document and its evidence package are attached.

Signed by:         ${signerEmail}
Completed:         ${signedAt}
Original SHA-256:  ${originalHash}
Signed SHA-256:    ${signedHash}

These hashes let either party verify the attached files haven't been altered since signing.`;

  return {
    subject: `Signed: ${filename}`,
    html: layout({ heading: 'Document signed', bodyHtml, footerNote: 'Sent via esign. Keep this message for your records.' }),
    text,
  };
}

/** Sender sign-in link (magic link). Single-use, short-lived. */
export function magicLinkEmail({ name, link, expiresMinutes = 15 }) {
  const bodyHtml = `
    <p style="margin:0 0 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">
      ${name ? `Hi ${esc(name)}, use` : 'Use'} the button below to sign in to esign.
    </p>
    ${button(link, 'Sign in')}
    <p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">
      This link works once and expires in ${expiresMinutes} minutes. If the button doesn't work, paste this into your browser:<br>
      <span style="color:${ACCENT};word-break:break-all;">${esc(link)}</span>
    </p>`;

  const text = `Use this link to sign in to esign:
${link}

It works once and expires in ${expiresMinutes} minutes.

If you didn't request it, you can ignore this message.`;

  return {
    subject: 'Your esign sign-in link',
    html: layout({
      heading: 'Sign in to esign',
      bodyHtml,
      footerNote: "If you didn't request this, you can ignore this message — no one can sign in without the link.",
    }),
    text,
  };
}
