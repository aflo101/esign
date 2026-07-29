import pg from 'pg';
import 'dotenv/config';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function logEvent(docId, type, req, metadata = {}) {
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;
  const ua = req?.headers?.['user-agent'] || null;
  await pool.query(
    `INSERT INTO events (doc_id, type, actor, ip, user_agent, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
    [docId, type, metadata.actor || null, ip, ua, metadata]
  );
}
