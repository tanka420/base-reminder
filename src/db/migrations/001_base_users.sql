-- Migration 001: base_users
-- M1A — Core Foundation
--
-- Creates the base_users table: canonical identity for all workspace members,
-- synced from Base Account API.
--
-- Design decisions (per architecture-review.md v1.1 §5.1 and §5.3):
--  - id is the Base user ID (integer from API). Not a surrogate key.
--  - username may change; id is the stable identity.
--  - Soft-deactivation only: is_active = false when user leaves workspace.
--  - No raw_manager / raw_direct_reports: not used by any MVP feature.
--  - No Telegram/OTP fields here: those belong to M2 migration.

CREATE TABLE IF NOT EXISTS base_users (
    id              INTEGER PRIMARY KEY,          -- Base user ID (from Account API)
    username        VARCHAR(100) UNIQUE NOT NULL, -- May change; matched on id for updates
    display_name    VARCHAR(255) NOT NULL,        -- Full display name (API field: name)
    email           VARCHAR(255) NOT NULL,        -- Corporate email (PII; never logged)
    is_active       BOOLEAN NOT NULL DEFAULT true,-- false when user leaves workspace
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- last successful sync time
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast username lookup (onboarding: search.by.username)
CREATE INDEX IF NOT EXISTS idx_base_users_username
    ON base_users (username);

-- Partial index: only active users (most queries filter active only)
CREATE INDEX IF NOT EXISTS idx_base_users_active
    ON base_users (is_active)
    WHERE is_active = true;
