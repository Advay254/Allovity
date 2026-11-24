-- 0001_foundation: site settings and the audit log.
-- Migrations are additive and safe to repeat. Never edit this file once it has
-- been applied anywhere. Add a new numbered file instead.
-- Do not put BEGIN or COMMIT in a migration: the runner wraps each file in a transaction.

CREATE TABLE IF NOT EXISTS site_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
              CONSTRAINT audit_log_metadata_small
              CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192),
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at);

-- The audit log only ever grows: rows cannot be changed or removed.
CREATE OR REPLACE FUNCTION audit_log_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_append_only' AND tgrelid = 'audit_log'::regclass
  ) THEN
    CREATE TRIGGER audit_log_append_only
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
  END IF;
END
$$;
