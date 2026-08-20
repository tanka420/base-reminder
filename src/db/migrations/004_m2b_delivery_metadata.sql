-- Migration 004: reminder_deliveries enhancements and reminder_delivery_chunks
-- M2B — Telegram Digest Delivery & Production Scheduler
--
-- Schema additions:
--  - Adds operational columns to reminder_deliveries (delivery_channel, telegram_error_code, chunks_total, chunks_sent, timestamps)
--  - Creates reminder_delivery_chunks table for granular per-chunk state tracking (pending/sending/delivered/error/ambiguous)
--
-- Note: Migrations 001, 002, and 003 are never modified.

-- 1. Enhance reminder_runs table to support namespaced run_key (scheduled:, manual:, test:, dryrun:)
ALTER TABLE reminder_runs
    ALTER COLUMN run_key TYPE VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_runs_key ON reminder_runs (run_key);

ALTER TABLE reminder_runs
    ADD CONSTRAINT uq_reminder_runs_key UNIQUE (run_key);

-- 2. Enhance reminder_deliveries table
ALTER TABLE reminder_deliveries
    ADD COLUMN IF NOT EXISTS delivery_channel      VARCHAR(20) DEFAULT 'telegram',
    ADD COLUMN IF NOT EXISTS telegram_error_code   VARCHAR(50),
    ADD COLUMN IF NOT EXISTS chunks_total          SMALLINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chunks_sent           SMALLINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS delivery_started_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivery_completed_at TIMESTAMPTZ;

-- Index for locating deliveries stuck in sending
CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_stale_sending
    ON reminder_deliveries (status, delivery_started_at)
    WHERE status = 'sending';

-- 2. Create reminder_delivery_chunks table
CREATE TABLE IF NOT EXISTS reminder_delivery_chunks (
    id                  SERIAL PRIMARY KEY,
    delivery_id         INTEGER NOT NULL REFERENCES reminder_deliveries(id) ON DELETE CASCADE,
    chunk_index         SMALLINT NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- Status values: pending, sending, delivered, error, ambiguous
    telegram_message_id BIGINT,
    attempt_count       SMALLINT NOT NULL DEFAULT 0,
    error_code          VARCHAR(50),
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_reminder_delivery_chunk UNIQUE (delivery_id, chunk_index)
);

-- Index for chunks by delivery
CREATE INDEX IF NOT EXISTS idx_reminder_delivery_chunks_delivery
    ON reminder_delivery_chunks (delivery_id);

-- Index for detecting stale sending chunks on recovery
CREATE INDEX IF NOT EXISTS idx_reminder_delivery_chunks_stale_sending
    ON reminder_delivery_chunks (status, updated_at)
    WHERE status = 'sending';
