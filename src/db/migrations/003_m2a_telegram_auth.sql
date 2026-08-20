-- Migration 003: M2A Telegram Bot, OTP Challenges, Account Linking, and Audit Trail
--
-- Tables:
--  - telegram_links: active and unlinked Telegram account bindings (1 active Base ↔ 1 active Telegram)
--  - otp_challenges: hashed 6-digit verification codes with attempt limits & TTL
--  - telegram_conversations: state machine persistence across bot restarts
--  - audit_log: persistent security audit trail (zero secrets/PII)

-- ============================================================================
-- 1. Telegram Links
-- ============================================================================
CREATE TABLE IF NOT EXISTS telegram_links (
    id                  SERIAL PRIMARY KEY,
    base_user_id        INTEGER NOT NULL REFERENCES base_users(id),
    telegram_user_id    BIGINT NOT NULL,
    telegram_chat_id    BIGINT NOT NULL,
    reminders_enabled   BOOLEAN NOT NULL DEFAULT true, -- false when paused via /stop
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at         TIMESTAMPTZ,                   -- set on unlinking/relinking (soft delete)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exactly ONE active Telegram account per Base user
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_links_base_active
    ON telegram_links (base_user_id)
    WHERE unlinked_at IS NULL;

-- Exactly ONE active Base account per Telegram user
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_links_tg_active
    ON telegram_links (telegram_user_id)
    WHERE unlinked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_links_tg_user ON telegram_links (telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_links_base_user ON telegram_links (base_user_id);

-- ============================================================================
-- 2. OTP Challenges
-- ============================================================================
CREATE TABLE IF NOT EXISTS otp_challenges (
    id                  SERIAL PRIMARY KEY,
    telegram_user_id    BIGINT NOT NULL,
    base_user_id        INTEGER NOT NULL REFERENCES base_users(id),
    otp_hash            VARCHAR(255) NOT NULL,        -- bcrypt hash (cost 10), NEVER plaintext
    expires_at          TIMESTAMPTZ NOT NULL,         -- NOW() + 10 minutes
    attempts            SMALLINT NOT NULL DEFAULT 0,  -- current failed attempt count
    max_attempts        SMALLINT NOT NULL DEFAULT 5,  -- threshold before invalidation
    consumed_at         TIMESTAMPTZ,                  -- set immediately upon successful verification
    invalidated_at      TIMESTAMPTZ,                  -- set when superseded, expired, or exhausted
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active challenge lookup index
CREATE INDEX IF NOT EXISTS idx_otp_challenges_active
    ON otp_challenges (telegram_user_id, base_user_id)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- Dual-axis rate limiting index (Telegram user axis)
CREATE INDEX IF NOT EXISTS idx_otp_challenges_rate_tg
    ON otp_challenges (telegram_user_id, created_at);

-- Dual-axis rate limiting index (Base user axis)
CREATE INDEX IF NOT EXISTS idx_otp_challenges_rate_base
    ON otp_challenges (base_user_id, created_at);

-- ============================================================================
-- 3. Telegram Conversation State
-- ============================================================================
CREATE TABLE IF NOT EXISTS telegram_conversations (
    telegram_user_id    BIGINT PRIMARY KEY,
    state               VARCHAR(50) NOT NULL DEFAULT 'IDLE',
    -- Values: IDLE, AWAIT_USERNAME, AWAIT_OTP, LINKED, AWAIT_UNLINK_CONFIRM
    context_data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 4. Persistent Audit Log
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id                  SERIAL PRIMARY KEY,
    event_type          VARCHAR(50) NOT NULL,
    -- Values: LINK_SUCCESS, LINK_FAIL, UNLINK, RELINK, OTP_SENT,
    --         OTP_VERIFY_FAIL, OTP_VERIFY_SUCCESS, OTP_EXPIRED,
    --         OTP_RATE_LIMITED, OTP_EXHAUSTED, OTP_DELIVERY_FAIL,
    --         REMINDERS_PAUSED, REMINDERS_RESUMED, PREVIOUS_NOTIFICATION_FAILED
    actor_telegram_id   BIGINT,
    actor_base_user_id  INTEGER,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb, -- strictly NO tokens, secrets, or OTPs
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_telegram ON audit_log (actor_telegram_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_base ON audit_log (actor_base_user_id, created_at);
