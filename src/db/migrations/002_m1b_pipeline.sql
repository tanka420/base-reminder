-- Migration 002: reminder_runs and reminder_deliveries
-- M1B — Action Pipeline
--
-- Creates tables for scheduler idempotency and per-user delivery state tracking.
-- Note: audit_log table is deferred to M2 (with Telegram/OTP/linking).

-- ============================
-- Reminder Runs (Scheduler Idempotency)
-- ============================
CREATE TABLE IF NOT EXISTS reminder_runs (
    id                  SERIAL PRIMARY KEY,
    run_date            DATE NOT NULL,               -- the date this run is for
    run_key             VARCHAR(20) UNIQUE NOT NULL, -- "2026-08-20" — idempotency key
    status              VARCHAR(20) NOT NULL DEFAULT 'started',
    -- Possible values: started, collecting, delivering, completed, failed
    users_total         INTEGER DEFAULT 0,
    users_delivered     INTEGER DEFAULT 0,
    users_empty         INTEGER DEFAULT 0,
    users_error         INTEGER DEFAULT 0,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_runs_key ON reminder_runs (run_key);

-- ============================
-- Reminder Deliveries (Per-User Per-Run)
-- ============================
CREATE TABLE IF NOT EXISTS reminder_deliveries (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER NOT NULL REFERENCES reminder_runs(id) ON DELETE CASCADE,
    base_user_id        INTEGER NOT NULL REFERENCES base_users(id),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- Possible values: pending, sending, delivered, empty, error, skipped
    wework_status       VARCHAR(10) NOT NULL DEFAULT 'pending',
    -- Possible values: ok, error, pending
    wework_count        SMALLINT DEFAULT 0,
    workflow_status     VARCHAR(10) NOT NULL DEFAULT 'pending',
    workflow_count      SMALLINT DEFAULT 0,
    request_status      VARCHAR(10) NOT NULL DEFAULT 'pending',
    request_count       SMALLINT DEFAULT 0,
    is_partial          BOOLEAN NOT NULL DEFAULT false,  -- true if any module failed
    telegram_message_id BIGINT,                      -- Telegram message ID on success
    error_message       TEXT,
    delivered_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_run ON reminder_deliveries (run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_deliveries_run_user
    ON reminder_deliveries (run_id, base_user_id);
