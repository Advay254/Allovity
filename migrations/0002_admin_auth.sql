-- 0002_admin_auth: admin users, sessions, recovery codes and the shared rate limit store.
-- Additive and safe to repeat. The runner wraps this file in a transaction, so it
-- contains no BEGIN or COMMIT. The audit_log table from 0001 is not touched.

CREATE TABLE IF NOT EXISTS admin_users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text NOT NULL,
  display_name           text NOT NULL,
  password_hash          text NOT NULL,
  role                   text NOT NULL,
  active                 boolean NOT NULL DEFAULT true,
  must_change_password   boolean NOT NULL DEFAULT false,
  totp_secret_encrypted  text,
  totp_enabled_at        timestamptz,
  totp_last_step         bigint,
  last_login_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT admin_users_email_length CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT admin_users_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80),
  CONSTRAINT admin_users_role_valid CHECK (role IN ('owner', 'admin', 'editor'))
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_key ON admin_users (email);
CREATE INDEX IF NOT EXISTS admin_users_role_active_idx ON admin_users (role, active);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_hash           text NOT NULL,
  stage                text NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  ip_address           inet,
  user_agent           text,
  revoked_at           timestamptz,
  reauthenticated_at   timestamptz,
  CONSTRAINT admin_sessions_stage_valid CHECK (stage IN ('pending', 'active')),
  CONSTRAINT admin_sessions_user_agent_short CHECK (user_agent IS NULL OR char_length(user_agent) <= 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_token_hash_key ON admin_sessions (token_hash);
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (absolute_expires_at);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_recovery_codes_user_idx ON admin_recovery_codes (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS admin_recovery_codes_hash_key ON admin_recovery_codes (user_id, code_hash);

-- Shared sliding-window counters for admin security limits. One row per key,
-- updated with an atomic upsert. Rows expire and are pruned on a schedule.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key          text PRIMARY KEY,
  window_start bigint NOT NULL,
  window_ms    integer NOT NULL,
  current_hits integer NOT NULL DEFAULT 0,
  previous_hits integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_hits_key_length CHECK (char_length(key) <= 200),
  CONSTRAINT rate_limit_hits_window_valid CHECK (window_ms > 0)
);

CREATE INDEX IF NOT EXISTS rate_limit_hits_expires_idx ON rate_limit_hits (expires_at);
CREATE INDEX IF NOT EXISTS rate_limit_hits_updated_idx ON rate_limit_hits (updated_at);

-- The audit log from 0001 rejects row updates and deletes. A row-level trigger does not
-- fire on TRUNCATE, so add a statement-level guard for that gap. The table and its
-- existing trigger are left exactly as they were.
CREATE OR REPLACE FUNCTION audit_log_reject_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_log_no_truncate' AND tgrelid = 'audit_log'::regclass
  ) THEN
    CREATE TRIGGER audit_log_no_truncate
      BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_truncate();
  END IF;
END
$$;
