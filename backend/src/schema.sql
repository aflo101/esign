CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  signer_email  TEXT,
  sender_email  TEXT,
  original_hash TEXT NOT NULL,
  signed_hash   TEXT,
  s3_key_original TEXT NOT NULL,
  s3_key_signed   TEXT,
  status        TEXT NOT NULL DEFAULT 'uploaded',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  actor       TEXT,
  ip          TEXT,
  user_agent  TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_doc_id_idx ON events(doc_id, created_at);

-- Sender-placed fields (v2). Single signer for MVP → no recipient_id yet.
-- Coords are normalized 0-1 with a TOP-LEFT origin (x,y = top-left corner of the box).
CREATE TABLE IF NOT EXISTS fields (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                 -- signature | initials | date | name | text | checkbox
  page        INT  NOT NULL,                 -- 0-based page index
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  w           REAL NOT NULL,
  h           REAL NOT NULL,
  required    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0,        -- guided Start→Next order
  value       JSONB,                         -- filled at signing (png dataurl / text / bool / iso date)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fields_doc_id_idx ON fields(doc_id, sort_order);
