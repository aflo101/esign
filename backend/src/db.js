// Audit-event helper. Storage lives in repo.js; this only decides *what* gets recorded
// about the requester.
import { putEvent } from './repo.js';

/**
 * Client IP.
 *
 * x-forwarded-for is client-controlled: CloudFront APPENDS the real viewer address to
 * whatever the client sent, so the FIRST entry is attacker-chosen and must never be
 * trusted — these values are printed into a legal evidence document. CloudFront's own
 * CloudFront-Viewer-Address header is set at the edge and cannot be spoofed, so it wins
 * whenever present; otherwise fall back to the LAST forwarded entry (the hop nearest us).
 */
export function clientIp(req) {
  const viewer = req?.headers?.['cloudfront-viewer-address'];
  if (viewer) return String(viewer).replace(/:\d+$/, ''); // strip :port (IPv4 and IPv6 forms)

  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req?.socket?.remoteAddress || null;
}

export async function logEvent(docId, type, req, metadata = {}) {
  await putEvent(docId, {
    type,
    actor: metadata.actor || null,
    ip: clientIp(req),
    userAgent: req?.headers?.['user-agent'] || null,
    metadata,
  });
}
