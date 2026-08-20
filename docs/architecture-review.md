# Base Reminder — Architecture Review & Implementation Reconciliation

> Status: **ORIGINAL DESIGN BASELINE / IMPLEMENTATION RECONCILED**  
> Version: 2.0 (Reconciled)  
> Date: 2026-08-20  
> Scope: Milestone 1 (Core Backend) + Milestone 2 (Telegram Bot + Account Linking + Delivery)  
> Target Environment: AWS EC2 (Ubuntu 24.04 LTS, Docker Compose, PostgreSQL 16)  

---

## Cross-Document References & System Documentation

- [`README.md`](../README.md) — System Overview, Requirements, Local Setup & Production Quick Start
- [`docs/deployment.md`](deployment.md) — AWS EC2 Production Deployment Guide & Topology Architecture
- [`docs/operations.md`](operations.md) — Day-to-day Operations, Monitoring, Backup/Restore Runbook & Troubleshooting
- [`docs/pre-production-risk-review.md`](pre-production-risk-review.md) — Pre-Production Security Audit, Hardening & Risk Review
- [`docs/sign-api-findings.md`](sign-api-findings.md) — Base Sign M2C Research Checkpoint & API Findings (Paused)

---

## Table of Contents

1. [M0 / M0.1 Review Summary](#1-m0--m01-review-summary)
2. [Milestone Boundaries & Reconciled State](#2-milestone-boundaries--reconciled-state)
3. [Implementation Evolution & Design Deltas](#3-implementation-evolution--design-deltas)
4. [M1 Architecture](#4-m1-architecture)
5. [M2 Telegram Account Linking Architecture](#5-m2-telegram-account-linking-architecture)
6. [PostgreSQL Schema](#6-postgresql-schema)
7. [Base User Sync Strategy](#7-base-user-sync-strategy)
8. [OTP Lifecycle](#8-otp-lifecycle)
9. [Account Takeover Risk Analysis](#9-account-takeover-risk-analysis)
10. [Telegram Relinking / Unlinking](#10-telegram-relinking--unlinking)
11. [Secret / Token Management](#11-secret--token-management)
12. [Scheduler Idempotency & Delivery Semantics](#12-scheduler-idempotency--delivery-semantics)
13. [Logging / Audit Strategy](#13-logging--audit-strategy)
14. [Race Conditions](#14-race-conditions)
15. [Health Checks & Failure Recovery](#15-health-checks--failure-recovery)
16. [Simplification Opportunities](#16-simplification-opportunities)
17. [Security Risks (Severity-Ranked)](#17-security-risks-severity-ranked)
18. [Architecture Conformance Matrix (Items 1–50)](#18-architecture-conformance-matrix-items-150)

---

## 1. M0 / M0.1 Review Summary

### What Was Proven

| Area | Status | Evidence |
|---|---|---|
| Account API — all users, search by username | ✅ PASS | 4/4 probes passed. ~30 users in single payload. |
| Wework API — list tasks by user, get task | ✅ PASS | 4/4 probes. Cross-user visibility confirmed. |
| Workflow API — active jobs by assignee, job detail | ✅ PASS | 5/5 probes. `username` = current stage assignee confirmed. |
| Request API — list pending, get detail | ✅ PASS | 4/4 probes. Sequential + Parallel approval logic fully mapped. |
| Cross-user visibility (single token per app) | ✅ PASS | All modules. One system token can fetch data for any `@username`. |
| `access_token_v2` auth mechanism | ✅ PASS | All modules use POST body param `access_token_v2`. |
| Deep-link URL patterns | ✅ Mapped | Wework, Workflow, Request web URLs documented. |

### Key API Characteristics (Architecture-Impacting)

1. **Pull-based integration**: The MVP intentionally uses the verified Base pull APIs. Push/webhook mechanisms are outside the current architecture.
2. **No pagination needed for Account**: ~30 users in single response.
3. **Wework pagination**: `page` parameter exists with loop limits and duplicate ID termination guards.
4. **Workflow pagination**: `page_id` cursor-based pagination with deterministic loop bounds.
5. **Request filtering**: `users` param returns requests where user is *involved* (creator, follower, approver) — **not** just actionable ones. Application-level filtering is mandatory.
6. **All timestamps**: 10-digit Unix seconds (string type in most fields).
7. **Status encoding**: String numerics (`"0"`, `"1"`, `"10"`, `"-10"`).
8. **Workflow `username` field**: Confirmed as current-stage assignee, not creator.

### No Blockers Identified

All four core modules are fully operational with the existing token configuration. No API quirks or undocumented behaviors were discovered that block implementation.

---

## 2. Milestone Boundaries & Reconciled State

| Milestone | Scope | Reconciled Status | Delivery Artifacts |
|---|---|---|---|
| **M0** | Base API Probes & Sanitized Samples | ✅ **COMPLETE** | `scripts/probe-*.ts`, `docs/sample-responses/` |
| **M0.1** | Deep Request Analysis & Actionability Logic | ✅ **COMPLETE** | Sequential/parallel approver logic proven in `docs/` |
| **M1** | Core Backend Infrastructure & Collectors | ✅ **COMPLETE** | Database, Account/Wework/Workflow/Request collectors, Digest builder, Healthcheck |
| **M2A** | Telegram Bot Auth & Account Linking | ✅ **COMPLETE** | grammY bot, OTP service via SMTP, atomic link/relink, OTP-hardened `/unlink` |
| **M2B** | Morning Reminder Pipeline & Delivery State Machine | ✅ **COMPLETE** | Chunk-level delivery tracking, stale crash recovery, 08:15 ICT scheduler, preview/test CLI |
| **M2C** | Base Sign Research Checkpoint | ⏸️ **PAUSED** | Canonical ID & deep link verified in [`docs/sign-api-findings.md`](sign-api-findings.md); server API paused |
| **M3** | Advanced Hardening & Admin Observability | ⏳ **DEFERRED** | Scheduled for post-pilot operations (admin UI, external dashboards) |

---

## 3. Implementation Evolution & Design Deltas

During the implementation of Milestones 1, 2A, and 2B, several architectural improvements and safety hardenings were introduced. These evolutions preserve all original functional requirements while improving reliability, operational isolation, and system security:

1. **Runtime Upgrade (Node.js 24 LTS)**:
   - *Baseline*: Node.js 20 LTS.
   - *Evolution*: Implemented on **Node.js 24 LTS** with native ECMAScript Modules (ESM) and TypeScript 5. Node.js 24 provides improved crypto performance (`crypto.randomInt`), active LTS maintenance, and long-term stability.

2. **Native Transactional SQL Migration System**:
   - *Baseline*: `node-pg-migrate` external tool.
   - *Evolution*: Implemented a lightweight, zero-dependency migration engine (`src/db/migrate.ts`) utilizing the `schema_migrations` tracking table. Migrations (`001_base_users.sql`, `002_m1b_pipeline.sql`, `003_m2a_telegram_auth.sql`, `004_m2b_delivery_metadata.sql`) run within strict SQL transactions automatically on startup.

3. **OTP-Hardened `/unlink` Security Flow**:
   - *Baseline*: Unlinking via direct command with basic confirmation.
   - *Evolution*: Hardened `/unlink` to require a 6-digit OTP delivered to the user's Base-registered corporate email (`src/telegram/handlers/unlink.ts`). This prevents unauthorized unlinking if an unattended device is accessed.

4. **Namespaced Reminder Run Keys**:
   - *Baseline*: Simple date-string run keys (`"2026-08-20"`).
   - *Evolution*: Namespaced run keys (`scheduled:YYYY-MM-DD`, `manual:<timestamp>:<rand>`, `test:<username>:<timestamp>`, `dryrun:<timestamp>`) implemented in `src/db/queries/runs.ts`. This allows operators to run ad-hoc test deliveries, dry-runs, and preview commands without colliding with or blocking the daily scheduled morning run.

5. **Telegram Chunk-Level Delivery State Machine**:
   - *Baseline*: Message splitting at 4,096 characters without persistent chunk tracking.
   - *Evolution*: Dedicated `reminder_delivery_chunks` table with `UNIQUE(delivery_id, chunk_index)`. Each chunk transitions through `pending → sending → delivered | error | ambiguous` with individual `telegram_message_id` records, ensuring zero message duplication during retries.

6. **Stale `sending` → `ambiguous` Crash Recovery**:
   - *Baseline*: Mark stale sending deliveries as generic errors after 5 minutes.
   - *Evolution*: Startup and pre-run crash recovery (`recoverStaleSending()`) explicitly transitions unresolved `sending` records to `ambiguous` with error code `AMBIGUOUS_AFTER_CRASH`. The system strictly prohibits auto-resending ambiguous items, preventing duplicate notifications.

7. **Empty-Digest Delivery Rule**:
   - *Baseline*: Send "all clear" message or omit message.
   - *Evolution*: When all successful modules return zero items, no Telegram message is sent (`formatTelegramDigest()` returns `[]`), and the delivery is recorded as `status = 'empty'` in the database, avoiding employee inbox spam.

8. **Base Wework `review=1` Review-State Task Exclusion**:
   - *Baseline*: Filter by `status === "0"` and overdue/due-today.
   - *Evolution*: Discovered `task.review = "1"` / `1` indicates tasks submitted to managers for review. These are excluded (`src/collectors/wework.ts`) to avoid notifying assignees of tasks pending manager action.

9. **Production Docker Container Hardening**:
   - *Baseline*: Standard Docker Compose setup.
   - *Evolution*: Hardened multi-stage `node:24-alpine` container running as non-root `appuser`, isolated internal bridge network (`internal`), persistent `pgdata` volume, and Docker `json-file` log size limits (`max-size: 10m, max-file: 3`) to eliminate log disk exhaustion risks.

10. **Localhost-Bound Internal Health Endpoint**:
    - *Baseline*: `GET /health` on application port.
    - *Evolution*: Bound strictly to `127.0.0.1:3000` (`HEALTH_HOST=127.0.0.1`) using native Node.js `http` module, avoiding external attack surface while reporting active database latency and passive Base API timestamps.

11. **Strict SMTP STARTTLS Enforcement**:
    - *Baseline*: Generic SMTP configuration.
    - *Evolution*: Port 587 enforces STARTTLS (`requireTLS: true`) with SSL port 465 support. Pino logger redacts all credentials and masks corporate emails (`t***n@company.com`) across all log streams.

12. **Paused Base Sign M2C Research Checkpoint**:
    - *Baseline*: Base Sign scheduled for future implementation.
    - *Evolution*: Milestone 2C research formalized in [`docs/sign-api-findings.md`](sign-api-findings.md). Verified canonical ID and deep link (`https://sign.base.vn/detail/{id}`). Production collector is formally paused pending Base.vn server-to-server API route publication, maintaining zero unverified code in production.

---

## 3. M1 Architecture

### 3.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Docker Compose                     │
│                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌───────────┐ │
│  │PostgreSQL │◄───│  App Server   │───►│ Base APIs │ │
│  │  (data)   │    │  (Node.js)   │    │ (external)│ │
│  └──────────┘    └──────┬───────┘    └───────────┘ │
│                         │                           │
│                    ┌────┴────┐                      │
│                    │Scheduler│                      │
│                    │(node-   │                      │
│                    │ cron)   │                      │
│                    └─────────┘                      │
└─────────────────────────────────────────────────────┘
```

### 3.2 Directory Structure (Planned)

```
base-reminder/
├── src/
│   ├── config/            # env loading, validation, constants
│   ├── db/
│   │   ├── migrations/    # numbered SQL migration files
│   │   ├── connection.ts  # pg pool setup
│   │   └── queries/       # typed query functions (no ORM)
│   ├── base-api/
│   │   ├── client.ts      # shared HTTP client (axios + retry + concurrency)
│   │   ├── account.ts     # Account API adapter
│   │   ├── wework.ts      # Wework API adapter
│   │   ├── workflow.ts    # Workflow API adapter
│   │   └── request.ts     # Request API adapter
│   ├── collectors/
│   │   ├── wework.ts      # fetch + filter overdue/due-today tasks
│   │   ├── workflow.ts    # fetch active jobs for user
│   │   └── request.ts     # fetch + apply isRequestActionableForUser
│   ├── sync/
│   │   └── user-sync.ts   # Base Account → local users table
│   ├── digest/
│   │   └── builder.ts     # assemble per-user structured digest (channel-agnostic)
│   ├── scheduler/
│   │   ├── cron.ts        # node-cron setup
│   │   └── reminder-job.ts# orchestrate: sync → collect → build → store
│   ├── telegram/          # (M2) bot, conversations, formatter, delivery
│   ├── health/
│   │   └── check.ts       # health endpoint (localhost-bound)
│   ├── logging/
│   │   └── logger.ts      # structured logger (pino)
│   └── index.ts           # app entry point
├── docs/                  # existing M0 docs
├── scripts/               # existing probe scripts
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
└── tsconfig.json
```

### 3.3 Technology Choices

| Component | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 24 LTS | Current LTS as of project date. Node.js 20 is EOL. |
| Language | TypeScript 5 (strict) | Already in use. Type safety for API contracts. |
| Database | PostgreSQL 16 | User preference. ACID for OTP + linking. JSON support if needed. |
| DB driver | `pg` (node-postgres) | Lightweight, no ORM overhead. Typed query wrappers. |
| Migrations | `node-pg-migrate` | SQL-based, no ORM dependency, rollback support. |
| HTTP client | `axios` | Already in use. Add `axios-retry` for automatic retries. |
| Scheduler | `node-cron` | In-process, simple. Sufficient for single-instance deployment. |
| Logging | `pino` | Structured JSON logging, fast, low overhead. |
| Telegram | `grammy` | Modern, TypeScript-first, well-maintained Telegram bot framework. |
| Containerization | Docker Compose | User preference. Single `docker-compose up`. |
| Email (OTP) | `nodemailer` via SMTP | Simple, proven. Uses existing Base-registered email domain. |

### 3.4 Base API Client Design

```
BaseApiClient
├── shared config: { baseUrl, token, timeout, retryConfig }
├── request(method, path, params) → typed response
├── retry: 3 attempts, exponential backoff with jitter
│   ├── initial delay: 1s, factor: 2, max delay: 8s
│   ├── jitter: ±25% randomization on each delay
│   └── retry only on: 5xx, network errors, timeouts
├── bounded concurrency: p-limit(3) per module (configurable)
├── timeout: 15s per request
├── HTTP 429 handling: honor Retry-After header when present
├── error classification:
│   ├── transient (5xx, network, timeout) → retry
│   ├── rate limited (429) → wait Retry-After or backoff, then retry
│   └── permanent (4xx except 429) → throw immediately, do not retry
└── never log tokens or request bodies containing tokens
```

**Throttling rationale**: Base API rate limits are undocumented. Rather than speculating a fixed rate limit, use bounded concurrency (initially 3 parallel requests per module) combined with exponential backoff + jitter. This adapts naturally to Base API behavior. If HTTP 429 is received, honor the `Retry-After` header. With ~30 users and 3 modules, a full collection sweep makes ~90 API calls — well within any reasonable limit.

### 3.5 Data Collection Flow (M1)

```
Scheduler triggers (08:15 weekdays)
│
├─ 1. User Sync
│     Account API → upsert local users table
│     Filter: status === "0" (active only)
│     ~30 users, single API call, no pagination
│
├─ 2. For each active user (concurrency: 3 parallel users):
│     ├─ Wework Collector
│     │   POST /extapi/v3/user/tasks { user: @username }
│     │   Filter: status === "0" AND (overdue === 1 OR deadline === today)
│     │   Paginate if needed
│     │   On failure: mark module as ERROR (do not return empty list)
│     │
│     ├─ Workflow Collector
│     │   POST /extapi/v1/jobs/get { username: @username, status: "active" }
│     │   Filter: job.username === targetUsername (current stage)
│     │   Paginate via page_id cursor
│     │   On failure: mark module as ERROR (do not return empty list)
│     │
│     └─ Request Collector
│         POST /extapi/v1/request/list { users: username, status: "pending" }
│         Apply isRequestActionableForUser() for each request
│         Paginate via page
│         On failure: mark module as ERROR (do not return empty list)
│
├─ 3. Build Digest (channel-agnostic)
│     Assemble per-user {
│       wework:   { status: "ok"|"error", items: [...] },
│       workflow:  { status: "ok"|"error", items: [...] },
│       request:   { status: "ok"|"error", items: [...] }
│     }
│     If all modules succeeded with zero items → digest status = "empty"
│     If any module has items → digest status = "has_items"
│     If any module errored but others have items → digest status = "partial"
│     If all modules errored → digest status = "all_failed"
│
└─ 4. Store Run Record
      Insert into reminder_runs table (idempotency)
      Per-user digest status: pending / empty / error
      (delivery states managed in M2)
```

---

## 4. M2 Telegram Account Linking Architecture

### 4.1 Onboarding Flow

```
User opens Telegram bot (MUST be private chat)
        │
        ▼
   /start command
        │
        ▼
   ── Private chat check ──► NOT PRIVATE → "Vui lòng nhắn riêng cho bot."
        │
        ▼ (private chat)
   Bot: "Chào bạn! Nhập Base username của bạn để liên kết:"
        │
        ▼
   User types: "Digital01"
        │
        ▼
   Backend:
   ├─ Call Account API: search.by.username("Digital01")
   ├─ If not found → "Username không tồn tại. Thử lại."
   ├─ If found but already linked to DIFFERENT Telegram → see Relinking flow
   ├─ If found + active → proceed
   │
   ▼
   Bot: "Tìm thấy: Mai Thanh Tân (Digital01).
         Mã OTP đã được gửi tới email đã đăng ký trên Base.
         Nhập mã OTP (6 chữ số):"
        │
        ▼
   Backend:
   ├─ Generate OTP (6 digits)
   ├─ Hash OTP (bcrypt, cost 10)
   ├─ Store in otp_attempts: { telegram_user_id, base_user_id, otp_hash, expires_at, attempts: 0 }
   ├─ Send OTP email to user's Base-registered email
   │
   ▼
   User enters OTP in Telegram
        │
        ▼
   Backend:
   ├─ Lookup active OTP for this telegram_user_id
   ├─ If expired → "OTP hết hạn. Gõ /start để thử lại."
   ├─ If attempts >= 5 → "Quá nhiều lần thử. Chờ 15 phút."
   ├─ Verify OTP against hash
   ├─ If wrong → increment attempts, "OTP sai. Còn {n} lần thử."
   ├─ If correct:
   │   ├─ Insert/update users_telegram: { base_user_id, telegram_user_id, telegram_chat_id }
   │   ├─ Mark OTP as consumed
   │   └─ Bot: "✅ Liên kết thành công! Bạn sẽ nhận reminder mỗi sáng 08:15."
   └
```

### 4.2 Conversation State Machine

```
           ┌──────────┐
           │  IDLE     │ ← initial state / after /stop
           └────┬─────┘
                │ /start (private chat only)
                ▼
       ┌────────────────┐
       │ AWAIT_USERNAME  │
       └───────┬────────┘
               │ valid username found
               ▼
       ┌────────────────┐
       │  AWAIT_OTP     │ ← OTP sent to email
       └───────┬────────┘
               │ correct OTP
               ▼
       ┌────────────────┐
       │   LINKED       │ ← normal operating state
       └────────────────┘

Transitions on error:
  AWAIT_USERNAME → AWAIT_USERNAME  (user not found, retry)
  AWAIT_OTP → AWAIT_OTP           (wrong OTP, retry within limits)
  AWAIT_OTP → IDLE                (expired / max attempts)
```

> [!NOTE]
> Conversation state is stored in PostgreSQL (`telegram_conversations` table), not in memory, so the bot can restart without losing onboarding progress.

### 4.3 Bot Commands

| Command | State | Description |
|---|---|---|
| `/start` | Any | Begin or restart onboarding flow |
| `/status` | LINKED | Show current link info |
| `/unlink` | LINKED | Unlink Base account (requires confirmation) |
| `/help` | Any | Show available commands |
| `/stop` | Any | Pause reminders (keep link, stop delivery) |
| `/resume` | LINKED | Resume reminders |

> [!IMPORTANT]
> **Private chat enforcement**: All bot commands (account linking, OTP entry, reminder delivery) must only operate in private (direct) chats. If a message arrives in a group or channel, the bot must respond with a redirect message and take no further action. This prevents OTP leakage and accidental data exposure in shared chats.

### 4.4 Telegram Message Safety

1. **HTML escaping**: All Base-originated text (task titles, job names, request names, usernames, display names) must be escaped before rendering in Telegram HTML mode. Characters `<`, `>`, `&`, `"` must be escaped to prevent injection into Telegram's HTML parser.
2. **Message splitting**: Telegram enforces a 4096-character limit per message. The digest formatter must support splitting one user's digest across multiple sequential messages when the combined content exceeds this limit. Each split message must be self-contained (valid HTML, no broken tags).
3. **No Markdown mode**: Use Telegram HTML parse mode exclusively. Markdown mode has ambiguous escaping rules with Base data that may contain `*`, `_`, `` ` ``, `[`, etc.

---

## 5. PostgreSQL Schema

### 5.1 M1 Schema (Migration 001)

```sql
-- ============================
-- Base Users (synced from Account API)
-- ============================
CREATE TABLE base_users (
    id              INTEGER PRIMARY KEY,          -- Base user ID (from API)
    username        VARCHAR(100) UNIQUE NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_base_users_username ON base_users (username);
CREATE INDEX idx_base_users_active ON base_users (is_active) WHERE is_active = true;

-- ============================
-- Reminder Runs (Scheduler Idempotency)
-- ============================
CREATE TABLE reminder_runs (
    id                  SERIAL PRIMARY KEY,
    run_date            DATE NOT NULL,               -- the date this run is for
    run_key             VARCHAR(20) NOT NULL,         -- "2026-08-20" — idempotency key
    status              VARCHAR(20) NOT NULL DEFAULT 'started',
    -- Possible values: started, collecting, delivering, completed, failed
    users_total         INTEGER,
    users_delivered     INTEGER DEFAULT 0,
    users_empty         INTEGER DEFAULT 0,
    users_error         INTEGER DEFAULT 0,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_reminder_runs_key ON reminder_runs (run_key);

-- ============================
-- Reminder Deliveries (Per-User Per-Run)
-- ============================
CREATE TABLE reminder_deliveries (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER NOT NULL REFERENCES reminder_runs(id),
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

CREATE INDEX idx_reminder_deliveries_run ON reminder_deliveries (run_id);
CREATE UNIQUE INDEX idx_reminder_deliveries_run_user
    ON reminder_deliveries (run_id, base_user_id);

-- ============================
-- Audit Log (Persistent Audit Trail)
-- ============================
CREATE TABLE audit_log (
    id                  SERIAL PRIMARY KEY,
    event_type          VARCHAR(50) NOT NULL,
    -- Values: LINK_SUCCESS, LINK_FAIL, UNLINK, RELINK, OTP_SENT,
    --         OTP_VERIFY_FAIL, OTP_VERIFY_SUCCESS, OTP_EXPIRED,
    --         OTP_RATE_LIMITED, USER_SYNC, REMINDER_RUN
    actor_telegram_id   BIGINT,
    actor_base_user_id  INTEGER,
    metadata            JSONB,                       -- event-specific data (NO secrets/tokens)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_event ON audit_log (event_type, created_at);
CREATE INDEX idx_audit_log_telegram ON audit_log (actor_telegram_id, created_at);
```

### 5.2 M2 Schema (Migration 002)

```sql
-- ============================
-- Telegram Linking
-- ============================
CREATE TABLE users_telegram (
    id                  SERIAL PRIMARY KEY,
    base_user_id        INTEGER NOT NULL REFERENCES base_users(id),
    telegram_user_id    BIGINT NOT NULL,
    telegram_chat_id    BIGINT NOT NULL,
    reminders_enabled   BOOLEAN NOT NULL DEFAULT true,  -- false = /stop paused
    linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at         TIMESTAMPTZ,                    -- set when unlinked
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce one Base account ↔ one Telegram account (among active links)
CREATE UNIQUE INDEX idx_users_telegram_base_active
    ON users_telegram (base_user_id)
    WHERE unlinked_at IS NULL;

CREATE UNIQUE INDEX idx_users_telegram_tg_active
    ON users_telegram (telegram_user_id)
    WHERE unlinked_at IS NULL;

-- ============================
-- OTP Attempts
-- ============================
CREATE TABLE otp_attempts (
    id                  SERIAL PRIMARY KEY,
    telegram_user_id    BIGINT NOT NULL,
    base_user_id        INTEGER NOT NULL REFERENCES base_users(id),
    otp_hash            VARCHAR(255) NOT NULL,       -- bcrypt hash
    expires_at          TIMESTAMPTZ NOT NULL,
    attempts            SMALLINT NOT NULL DEFAULT 0,
    max_attempts        SMALLINT NOT NULL DEFAULT 5,
    consumed_at         TIMESTAMPTZ,                 -- set when successfully verified
    invalidated_at      TIMESTAMPTZ,                 -- set when superseded or expired
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_active
    ON otp_attempts (telegram_user_id, base_user_id)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

-- Index for rate limiting by base_user_id (prevent multiple Telegram accounts
-- from spamming OTP emails to the same Base user)
CREATE INDEX idx_otp_rate_limit_base_user
    ON otp_attempts (base_user_id, created_at);

-- ============================
-- Telegram Conversation State
-- ============================
CREATE TABLE telegram_conversations (
    telegram_user_id    BIGINT PRIMARY KEY,
    state               VARCHAR(50) NOT NULL DEFAULT 'IDLE',
    -- Possible values: IDLE, AWAIT_USERNAME, AWAIT_OTP, LINKED
    context_data        JSONB,                       -- e.g. { pending_base_user_id }
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5.3 Schema Design Decisions

| Decision | Rationale |
|---|---|
| **No ORM** | ~7 tables. Raw `pg` with typed query functions is simpler and gives full control. |
| **Soft delete for unlink** | `users_telegram.unlinked_at` preserves history. Partial unique indexes enforce "one active link" constraint at DB level. |
| **No task/job/request caching** | Per requirements: "Do not persist full Wework/Workflow/Request content unless necessary." Digest data is collected, formatted, delivered, and discarded. Only counts and per-module status are stored in `reminder_deliveries`. |
| **`reminder_runs` + `reminder_deliveries`** | Two-level structure for idempotency (run level) and per-user audit (delivery level). |
| **`telegram_conversations` in DB** | Bot can restart without losing user's onboarding state. Single-row-per-user, upserted on state change. |
| **No `raw_manager` / `raw_direct_reports`** | Removed from MVP. Not used by any current feature. Can be added in a future migration if needed. |
| **`reminders_enabled` instead of `is_active`** | Clearer semantics: distinguishes "user paused reminders via /stop" from "link is active." |
| **No `ip_address` in audit_log** | Telegram Bot API interactions do not provide a useful end-user IP address. The bot receives messages through Telegram's servers, not directly from clients. |
| **M1/M2 migration split** | Each milestone owns its tables. M1 does not pre-create M2-only tables. Normal migration workflow. |
| **Per-module status in deliveries** | `wework_status`, `workflow_status`, `request_status` track each module's collection outcome independently, supporting partial digest delivery and operational reporting. |

---

## 6. Base User Sync Strategy

### 6.1 Sync Trigger

| Trigger | When | Description |
|---|---|---|
| **Scheduled** | 08:10 weekdays | 5 minutes before reminder run. Ensures user list is fresh. |
| **On-demand** | During onboarding | When a user enters a username, the system verifies against the Account API in real time (not just local DB). |
| **Manual** | Admin command | Future: `/admin sync` command for ad-hoc sync. |

### 6.2 Sync Algorithm

```
1. Call Account API: POST /extapi/v1/users → get all users
2. For each user in API response:
   a. UPSERT into base_users:
      - Match on id (Base user ID)
      - Update: username, display_name, email, is_active, synced_at, updated_at
   b. Set is_active = (status === "0")
3. For users in local DB but NOT in API response:
   a. Set is_active = false, updated_at = NOW()
   b. Log: "User {id} no longer in Base workspace"
4. Return sync summary: { total, created, updated, deactivated }
```

### 6.3 Key Rules

- **Account API is source of truth** — never modify user data locally.
- **Username can change** — match on `id`, not `username`. Update username on change.
- **Deactivated users** — mark `is_active = false`. Do NOT delete. Their Telegram link persists but reminders skip them.
- **No partial sync** — always fetch all users. With ~30 users in a single API call, there's no performance concern.

---

## 7. OTP Lifecycle

### 7.1 Generation

| Parameter | Value | Rationale |
|---|---|---|
| Format | 6-digit numeric (000000–999999) | Easy to type in Telegram on mobile. |
| Source | `crypto.randomInt(0, 1_000_000)` | Cryptographically secure. Node.js built-in. |
| Uniqueness | Not required | OTP is scoped to (telegram_user_id, base_user_id). Collisions don't matter. |

### 7.2 Hashing

| Parameter | Value | Rationale |
|---|---|---|
| Algorithm | bcrypt | Standard for password-like hashing. |
| Cost factor | 10 | Fast enough for OTP verification (~100ms). Not a password, doesn't need 12+. |
| Storage | Only hash stored in `otp_attempts.otp_hash` | Plaintext OTP exists only in memory and in the email. |

### 7.3 Expiration

| Parameter | Value | Rationale |
|---|---|---|
| TTL | 10 minutes | Generous enough for email delivery delays. Short enough to limit replay. |
| Enforcement | `expires_at` checked server-side before verification | Clock is server-side only. |
| Cleanup | Expired OTPs marked `invalidated_at = NOW()` by the verification check | No background cleanup job needed for ~30 users. |

### 7.4 Rate Limiting

Rate limiting is applied on **two axes** to prevent abuse from multiple directions:

| Axis | Limit | Rationale |
|---|---|---|
| **Per telegram_user_id** | 5 OTP requests per 15 minutes | Prevents a single Telegram user from spamming OTP emails. |
| **Per base_user_id** | 5 OTP requests per 15 minutes | Prevents multiple different Telegram accounts from repeatedly sending OTP emails to the same Base user's inbox. |

| Parameter | Value | Rationale |
|---|---|---|
| Implementation | SQL COUNT queries on `otp_attempts` table | Two queries: one `WHERE telegram_user_id = X AND created_at > NOW() - 15min`, one `WHERE base_user_id = Y AND created_at > NOW() - 15min`. Simple. No Redis needed for ~30 users. |
| Enforcement | **Both** limits must pass before an OTP is generated and sent | Either limit exceeded → request blocked. |
| Cooldown message (Telegram axis) | "Bạn đã yêu cầu quá nhiều mã OTP. Vui lòng thử lại sau 15 phút." | |
| Cooldown message (Base user axis) | "Tài khoản này đã nhận quá nhiều mã OTP. Vui lòng thử lại sau." | Does not reveal which Telegram account triggered the other requests. |

### 7.5 Attempt Limit

| Parameter | Value | Rationale |
|---|---|---|
| Max verification attempts per OTP | 5 | Prevents brute force on a 6-digit code (1M possibilities). |
| On exceed | OTP invalidated. User must request a new one. | |
| Lockout | After 3 consecutive *OTPs* are fully exhausted (15 total attempts) in a 1-hour window → 1-hour lockout | Stops persistent attackers while being lenient for genuine typos. |

### 7.6 Resend Policy

| Scenario | Behavior |
|---|---|
| User requests resend (types username again or `/start`) | Previous OTP is invalidated. New OTP generated. |
| Rate limit not exceeded (both axes) | Resend allowed immediately. |
| Same session, valid OTP exists | Bot reminds "OTP đã được gửi tới email. Kiểm tra lại email hoặc chờ {remaining_time} để yêu cầu mới." |

### 7.7 OTP Flow Sequence

```
User → /start → enters username
                    │
                    ▼
            ┌─ Rate limit check (telegram_user_id) ──► BLOCKED
            │
            ├─ Rate limit check (base_user_id) ──► BLOCKED
            │
            ▼ (both OK)
    Invalidate any previous active OTP for this telegram_user_id
            │
            ▼
    Generate 6-digit OTP
            │
            ├─ Hash with bcrypt(cost=10)
            ├─ Store: { telegram_user_id, base_user_id, otp_hash, expires_at }
            └─ Send plaintext OTP to user's Base email via SMTP
                    │
                    ▼
            User enters OTP in Telegram
                    │
            ┌─ Check expiration ──► EXPIRED → invalidate, prompt restart
            │
            ├─ Check attempt count ──► MAX REACHED → invalidate, prompt restart
            │
            ▼ (OK)
    bcrypt.compare(input, otp_hash)
            │
            ├─ WRONG → increment attempts, notify remaining
            │
            └─ CORRECT → mark consumed_at, create/update users_telegram link
```

---

## 8. Account Takeover Risk Analysis

### 8.1 Threat Model

| Threat | Vector | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **T1: Attacker guesses OTP** | Brute force 6-digit code via Telegram | Low | High (unauthorized link) | 5 attempts per OTP. Rate limit on OTP generation (both axes). |
| **T2: Attacker knows username** | Base usernames are not secret (visible in workspace) | Medium | Low (alone) | Username alone cannot complete linking. Email OTP required. |
| **T3: Email account compromise** | Attacker has access to victim's Base email | Low | High | Out of scope — if email is compromised, many systems are affected. Log all linking events for post-incident audit. |
| **T4: Telegram account takeover** | Attacker gains control of victim's Telegram | Low | High | Out of scope — Telegram's own 2FA. Our system can only detect anomalies via audit log. |
| **T5: Relink attack** | Attacker tries to relink victim's Base account to attacker's Telegram | Medium | High | Relinking requires full OTP verification. Previous link holder is notified. Old link only deactivated after new verification succeeds. |
| **T6: OTP interception in transit** | Email sent over unencrypted channel | Low | Medium | Use STARTTLS for SMTP (port 587). OTP has 10-min expiry. |
| **T7: Enumeration attack** | Attacker iterates usernames via bot | Medium | Low | Rate limit username lookups. Don't differentiate "not found" vs "deactivated." |
| **T8: Session fixation** | Attacker starts onboarding for a username, victim completes it | Very Low | High | OTP is tied to specific telegram_user_id. Victim would be on different Telegram account. |
| **T9: Cross-Telegram OTP spam** | Multiple Telegram accounts send OTP requests for same Base user | Medium | Medium (email flooding) | Dual-axis rate limiting: per-base_user_id limit caps total OTP emails regardless of source Telegram account. |
| **T10: OTP/data leakage in group chats** | User interacts with bot in a group chat, exposing OTP or digest content | Medium | High | Private-chat-only enforcement. Bot ignores all non-private messages. |

### 8.2 Defense Summary

1. **OTP verification is mandatory** for every linking operation. No exceptions.
2. **Attempt limits + rate limits** make brute force impractical (5 attempts × 5 OTPs in 15 min = 25 guesses max against 1M possibilities = 0.0025% success rate).
3. **Dual-axis rate limiting** prevents both single-user spam and cross-Telegram email flooding.
4. **All link/unlink events are audited** with telegram_user_id, base_user_id, and timestamp.
5. **Notification on relink**: When a Base account is relinked to a new Telegram account, the *previous* Telegram account receives a notification.
6. **Verify-before-unlink**: Old link is never deactivated until the new account's OTP verification succeeds.
7. **Fail closed**: Unknown workflow types in Request module return `false` (not actionable), as specified.
8. **Private chat only**: All bot interactions restricted to direct messages.

---

## 9. Telegram Relinking / Unlinking

### 9.1 Unlinking

> [!IMPORTANT]
> **M2A Implementation Hardening**: M2A intentionally hardened `/unlink` by requiring OTP verification sent to the user's linked Base corporate email before unlinking. This prevents unauthorized unlinking and ensures auditability. Treat this as the source of truth.

```
User sends /unlink (private chat)
        │
        ▼
Bot: Checks active link
     ├─ If not linked → "Bạn chưa liên kết tài khoản nào."
     └─ If linked → Generate 6-digit OTP, send to user's Base email
        │
        ▼
Bot: "⚠️ Xác nhận hủy liên kết: Nhập mã 6 chữ số OTP đã gửi tới email {masked_email}:"
        │
        ▼
User enters OTP
        │
        ▼
Backend:
├─ Verify OTP (bcrypt, attempt tracking)
├─ If correct:
│   ├─ Set telegram_links.unlinked_at = NOW()
│   ├─ Set telegram_conversations.state = 'IDLE'
│   ├─ Audit log: UNLINK event
│   └─ Bot: "✅ Đã hủy liên kết. Gõ /start để liên kết lại."
└─ If incorrect/expired → notify user remaining attempts / lockout
```

### 9.2 Relinking

Relinking occurs when:
- **Case A**: User wants to link a *different* Base account to their Telegram.
- **Case B**: User wants to link their Base account to a *different* Telegram account.

> [!IMPORTANT]
> **Verify-before-unlink principle**: The currently active link is never deactivated until the new account's OTP verification succeeds. This prevents an attacker (or accidental user error) from leaving a Base account in an unlinked state.

Both cases go through the full onboarding flow with atomic finalization:

```
Relink request detected
        │
        ├─ Case A: Telegram T1 already linked to Base account X, user enters Base account Y
        │   ├─ Full OTP verification for Y (Base account X link remains active throughout)
        │   ├─ On OTP failure → nothing changes, X link remains active
        │   └─ On OTP success → single DB transaction:
        │       ├─ Deactivate old link: X.unlinked_at = NOW()
        │       ├─ Create new link: T1 ↔ Y
        │       └─ Audit log: RELINK event
        │
        └─ Case B: Base account X already linked to Telegram A, request comes from Telegram B
            ├─ Full OTP verification for X via Telegram B (existing A ↔ X link remains active)
            ├─ On OTP failure → nothing changes, A ↔ X link remains active
            └─ On OTP success → single DB transaction:
                ├─ Deactivate old link: A ↔ X unlinked_at = NOW()
                ├─ Create new link: B ↔ X
                ├─ Audit log: RELINK event with both Telegram IDs
                └─ ⚠️ Notify Telegram A: "Tài khoản {username} đã được liên kết với thiết bị khác."
```

> [!WARNING]
> The notification to the previous Telegram account (Case B) is a critical security feature. Without it, an attacker who compromises someone's email can silently redirect their reminders. The notification ensures the legitimate user is aware.

---

## 10. Secret / Token Management

### 10.1 Secrets Inventory

| Secret | Storage | Rotation | Access |
|---|---|---|---|
| Base API tokens (×4) | `.env` file / Docker secrets | Manual (when Base admin rotates) | App server only |
| PostgreSQL password | `.env` file / Docker secrets | On deployment | App server + DB container |
| Telegram Bot token | `.env` file / Docker secrets | Rarely (only if compromised) | App server only |
| SMTP credentials | `.env` file / Docker secrets | Per email provider policy | App server only |
| OTP plaintext | In-memory only (during generation → email send) | N/A (ephemeral) | Never persisted |
| OTP hash | PostgreSQL `otp_attempts.otp_hash` | N/A (bcrypt, one-way) | DB only |

### 10.2 Rules

1. **No secrets in code** — all secrets come from environment variables.
2. **No secrets in logs** — logger must redact any field named `token`, `password`, `otp`, `secret`, `authorization`.
3. **No secrets reach Telegram** — bot messages never contain tokens, passwords, or full OTP hashes.
4. **No secrets in error messages** — API error responses are logged with status codes and URLs only, not request bodies containing tokens.
5. **`.env` in `.gitignore`** — already established in M0.
6. **Docker secrets preferred** — for production, use Docker secrets mount (`/run/secrets/`) rather than environment variables in `docker-compose.yml`. Environment variables in compose files are visible in `docker inspect`.

### 10.3 Base API Token Architecture

```
.env / Docker secrets
        │
        ▼
   Config loader (validated at startup)
        │
        ▼
   BaseApiClient instances (one per module)
   │  Token stored as private property
   │  Added to POST body as access_token_v2
   │  Never logged, never exposed
        │
        ▼
   Base API servers (HTTPS)
```

> [!IMPORTANT]
> Each Base module (Account, Wework, Workflow, Request) requires its own `access_token_v2`. These are NOT interchangeable. The config loader must validate that all 4 tokens are present at startup and fail fast if any is missing.

---

## 11. Scheduler Idempotency & Delivery Semantics

### 11.1 Problem

The 08:15 reminder should run once per business day. Possible failure modes:
- **Double run**: Server restarts at 08:15, cron fires twice.
- **Missed run**: Server was down at 08:15.
- **Partial run**: Server crashes mid-collection or mid-delivery.

### 11.2 Scheduler Idempotency (Run-Level)

```
run_key = format(today, "YYYY-MM-DD")   // e.g. "2026-08-20"

BEGIN TRANSACTION
  INSERT INTO reminder_runs (run_key, run_date, status)
  VALUES (run_key, today, 'started')
  ON CONFLICT (run_key) DO NOTHING
  RETURNING id
COMMIT

if (no row returned):
  // Run already exists for today
  log.info("Reminder run already exists for {run_key}, skipping")
  return

// Proceed with collection + delivery
```

The unique `run_key` constraint prevents duplicate scheduler runs. However, this does **not** guarantee exactly-once delivery at the Telegram message level.

### 11.3 Delivery State Machine (Per-User)

Each `reminder_deliveries` row transitions through these states:

```
  pending → sending → delivered
                  ↘ error
```

| State | Meaning |
|---|---|
| `pending` | Digest built, not yet sent to Telegram. |
| `sending` | Telegram `sendMessage` call initiated. Outcome unknown. |
| `delivered` | Telegram API returned success. `telegram_message_id` recorded. |
| `error` | Telegram API returned a definitive error, or all retries exhausted. |
| `empty` | All modules succeeded, zero actionable items. No message sent. |
| `skipped` | User not linked, or reminders paused, or user inactive. |

### 11.4 Crash Ambiguity Window

> [!WARNING]
> **The `sending` state has inherent ambiguity.** If the server crashes after calling `sendMessage` but before recording the response, the delivery is stuck in `sending`. The message may or may not have been delivered to Telegram.

**Policy for stale `sending` deliveries:**

1. On startup recovery, do **not** automatically re-send deliveries stuck in `sending` state. The message may have already been delivered, and re-sending would produce a duplicate.
2. Instead, mark stale `sending` deliveries (older than 5 minutes) as `error` with `error_message = 'ambiguous: server crashed during send'`.
3. Log a `warn`-level message: `"Found {n} ambiguous deliveries from run {run_id}. Marked as error. Manual review recommended."`
4. The operator can inspect `reminder_deliveries` and decide whether to manually re-trigger for specific users.

**Rationale**: For an internal tool with ~30 users, a rare ambiguous delivery is better surfaced operationally than automatically creating duplicates. Users can also check Base directly if they didn't receive a reminder.

### 11.5 Recovery from Partial Failure

```
On startup:
  SELECT * FROM reminder_runs
  WHERE status IN ('started', 'collecting', 'delivering')
  AND run_date = CURRENT_DATE

  if (stale run found):
    1. Mark stale 'sending' deliveries as 'error' (ambiguous)
    2. Resume: re-collect and deliver for users with status = 'pending'
    3. Skip users with status IN ('delivered', 'empty', 'skipped', 'error')
```

### 11.6 Missed Run Detection

```
On startup (every time):
  Check if today is a weekday
  Check if current time > 08:15 Asia/Ho_Chi_Minh
  Check if reminder_runs has no entry for today

  if (all true):
    log.warn("Missed reminder run for today, executing now")
    Execute reminder run
```

> [!TIP]
> For ~30 users, a "late" reminder (e.g., sent at 09:00 instead of 08:15 due to server restart) is acceptable and far better than a missed reminder. The missed-run-on-startup check handles this gracefully.

---

## 12. Logging / Audit Strategy

### 12.1 Logging Levels

| Level | Usage |
|---|---|
| `fatal` | App cannot start (missing config, DB connection failure) |
| `error` | Individual operation failure (API call failed, delivery failed for user X) |
| `warn` | Degraded operation (retry succeeded, missed run detected, rate limit hit) |
| `info` | Normal operations (run started, run completed, user synced, OTP sent) |
| `debug` | Detailed operational data (API response times, per-user collection timing) |

### 12.2 What to Log

| Event | Level | Fields |
|---|---|---|
| Reminder run started | info | `{ run_id, run_date, users_total }` |
| Reminder run completed | info | `{ run_id, delivered, empty, error, partial, duration_ms }` |
| User sync completed | info | `{ total, created, updated, deactivated }` |
| API call timing | debug | `{ module, endpoint, status_code, duration_ms }` |
| API call failed | error | `{ module, endpoint, status_code, error_class, attempt }` |
| Per-user collection summary | debug | `{ base_user_id, wework_count, workflow_count, request_count, wework_status, workflow_status, request_status, duration_ms }` |
| OTP sent | info | `{ telegram_user_id, base_user_id }` — NO email address |
| OTP verification failed | warn | `{ telegram_user_id, base_user_id, attempts_remaining }` |
| Link created | info | `{ telegram_user_id, base_user_id, event: "LINK" }` |
| Unlink | info | `{ telegram_user_id, base_user_id, event: "UNLINK" }` |
| Relink | warn | `{ new_telegram_id, old_telegram_id, base_user_id, event: "RELINK" }` |
| Delivery per user | debug | `{ base_user_id, delivery_status, is_partial, duration_ms }` |

### 12.3 What NOT to Log — at ANY Level (Including Debug)

| Prohibited | Reason |
|---|---|
| Base API tokens | Secret. Could be scraped from log files. |
| OTP plaintext or hash | Security-sensitive. |
| User email addresses | PII. Base user ID is sufficient for correlation. |
| Task titles, job names, request names | Content from Base is business-sensitive and not needed for operations. Log IDs and counts only. |
| Digest content (formatted or structured) | Contains Base business data. Never log, even at debug level. |
| Telegram chat message content | Privacy. Log message IDs only. |

### 12.4 Structured Format

All logs output as JSON via `pino`:

```json
{
  "level": "info",
  "time": "2026-08-20T01:15:02.123Z",
  "msg": "Reminder run completed",
  "run_id": 42,
  "delivered": 28,
  "empty": 2,
  "error": 0,
  "partial": 1,
  "duration_ms": 15234
}
```

### 12.5 Persistent Audit Trail (Database)

The `audit_log` table captures security-relevant events that must survive log rotation. This is separate from application logs:

- Every link/unlink/relink
- Every OTP send/verify (success + failure)
- Rate limit triggers
- User sync events (summary only)

> [!NOTE]
> The `audit_log` table provides a **persistent audit trail** — it survives application log rotation and is suitable for post-incident review. It does not provide cryptographic tamper-evidence (e.g., hash chains). For this scale (~30 internal users), a persistent trail with DB-level access controls is sufficient.

Retention: Keep indefinitely for this scale (~30 users, low volume).

---

## 13. Race Conditions

### 13.1 Identified Race Conditions

| # | Scenario | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **RC1** | Two OTP verification requests arrive simultaneously for the same user | Low (user double-clicks) | Double link creation | Use `SELECT ... FOR UPDATE` on `otp_attempts` row during verification. Single transaction for verify + link. |
| **RC2** | User sends OTP while a new OTP is being generated (resend) | Low | Old OTP validated against new hash | Invalidate old OTP *before* inserting new one, in same transaction. Verify checks `consumed_at IS NULL AND invalidated_at IS NULL`. |
| **RC3** | Scheduler fires twice at 08:15 (e.g., timezone edge case, rapid restart) | Medium | Duplicate scheduler runs | `reminder_runs.run_key` unique constraint + INSERT ... ON CONFLICT DO NOTHING. Second run gets no row back and aborts. (Note: this prevents duplicate runs, not duplicate Telegram messages — see §11.4.) |
| **RC4** | User unlinks while a reminder delivery is in progress | Very Low | Delivery sent to unlinked user | Acceptable. Message was already composed. Next day, user won't receive. No data leak (it's their own data). |
| **RC5** | Two users try to link same Base account simultaneously | Very Low | Duplicate link entries | Unique partial index `idx_users_telegram_base_active` prevents this at DB level. Second INSERT fails. |
| **RC6** | User sync runs while onboarding verification is in progress | Very Low | User deactivated between username check and OTP verify | Re-verify `is_active` status at OTP verification time, not just at username entry. |
| **RC7** | Relink: old link deactivated but new link INSERT fails | Very Low | Base account left unlinked | Mitigated by verify-before-unlink: old link deactivation + new link creation happen atomically in a single DB transaction. If INSERT fails, the transaction rolls back and old link remains active. |

### 13.2 General Mitigation Patterns

1. **Database transactions** for all multi-step operations (OTP verify + link, relink deactivate + create, unlink + audit).
2. **Unique constraints** as the last line of defense (run_key, active telegram link).
3. **Optimistic concurrency** — don't lock unless needed. For ~30 users, contention is negligible.
4. **Delivery state machine** — `pending → sending → delivered` with ambiguous `sending` states surfaced operationally rather than auto-retried (see §11.4).

---

## 14. Health Checks & Failure Recovery

### 14.1 Health Check Endpoint

**`GET /health`** — bound to `127.0.0.1:${HEALTH_PORT}` (localhost only by default):

```json
{
  "status": "healthy",
  "timestamp": "2026-08-20T01:15:00Z",
  "checks": {
    "database": { "status": "up", "latency_ms": 3 },
    "base_api_account": { "status": "up", "last_success": "2026-08-20T01:10:00Z" },
    "base_api_wework": { "status": "up", "last_success": "2026-08-20T01:10:00Z" },
    "base_api_workflow": { "status": "up", "last_success": "2026-08-20T01:10:00Z" },
    "base_api_request": { "status": "up", "last_success": "2026-08-20T01:10:00Z" },
    "telegram_bot": { "status": "up" },
    "last_reminder_run": {
      "date": "2026-08-20",
      "status": "completed",
      "delivered": 28,
      "partial": 1,
      "ambiguous": 0
    }
  }
}
```

> [!NOTE]
> Base API health is checked passively — we record the last successful API call timestamp. No active health-check pings to Base APIs (they don't have a health endpoint, and unnecessary calls waste rate limit budget).

> [!IMPORTANT]
> The health endpoint binds to `127.0.0.1` by default — not `0.0.0.0`. This prevents external access to internal system status. If Docker health checks need access, use Docker's internal network. For external monitoring, explicitly set `HEALTH_BIND=0.0.0.0` with appropriate network controls.

### 14.2 Failure Scenarios & Recovery

| Failure | Detection | Recovery | User Impact |
|---|---|---|---|
| **PostgreSQL down** | Health check, connection error | Docker restart policy: `restart: unless-stopped`. App retries connection with backoff. | Onboarding fails temporarily. Reminder skipped if DB down at 08:15. |
| **Base API down (single module)** | HTTP error / timeout from collector | Retry 3× with exponential backoff + jitter. If all retries fail, mark that module as ERROR in the user's digest. Deliver partial digest with explicit warning. | User gets partial digest with warning message (e.g., "⚠️ Không thể tải dữ liệu Wework."). |
| **Base API down (all modules)** | All collectors fail for a user | All modules marked ERROR. Digest status = "all_failed". No message sent. Delivery marked as `error`. | User doesn't receive reminder. Logged for operational review. |
| **Base API token expired** | HTTP 401/403 | Log error at `fatal` level. Health check reports `token_expired`. Manual intervention required to rotate token. | All reminders fail for that module. System remains up, reports the issue. |
| **Telegram API down** | Send message fails | Retry 3× with backoff. Mark `reminder_deliveries.status = 'error'`. Resume `pending` deliveries on next startup if still today. | User doesn't receive message. |
| **SMTP down** | Email send fails | Retry 2×. If failed, inform user via Telegram: "Không gửi được email. Thử lại sau." | Onboarding blocked temporarily. |
| **App server crash** | Docker restart policy | `restart: unless-stopped`. On startup: check for stale runs, mark ambiguous `sending` deliveries, resume `pending` deliveries. | Late reminder (minutes delay). Some deliveries may be ambiguous. |
| **Full disk** | PostgreSQL write failure | Log to stderr. Alert via health check. | Reminders and onboarding fail. |

### 14.3 Docker Compose Restart Policy

```yaml
services:
  app:
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
  db:
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U base_reminder"]
      interval: 10s
      timeout: 5s
      retries: 5
    # No published ports — DB accessible only via Docker internal network
```

---

## 15. Simplification Opportunities

### 15.1 Removed Complexity

| Original Concern | Simplification | Rationale |
|---|---|---|
| Redis for rate limiting | PostgreSQL COUNT query | ~30 users. SQL `COUNT(*) WHERE created_at > NOW() - interval '15 min'` is fast enough. No Redis dependency. |
| Message queue for delivery | Direct loop with error handling | ~30 messages at 08:15. No need for async queue. Sequential delivery with per-user error isolation is sufficient. |
| Webhook mode for Telegram | Long polling | Internal tool with low message volume. Long polling is simpler to deploy (no TLS cert, no public URL needed). |
| Caching Base API responses | No cache | Data is fetched once at 08:15, used immediately, discarded. Caching adds stale-data risks for no benefit. |
| User roles / RBAC | None | All ~30 users are equivalent. No admin panel. System-level operations are via env vars or direct DB. |
| Separate API server | Single process | Bot + scheduler + health check in one Node.js process. HTTP server only for `/health`. No REST API needed. |
| Database connection pooling tuning | Default pool (10 connections) | ~30 users, single process, no concurrent HTTP requests. Default `pg.Pool` is more than sufficient. |
| Fixed token-bucket rate limiting | Bounded concurrency + backoff | Speculative fixed rate limits are fragile. Bounded concurrency (3) + exponential backoff + Retry-After handling adapts to actual API behavior. |
| Pre-creating M2 tables in M1 | Standard migrations | Each milestone owns its schema. Normal migration workflow avoids coupling. |
| Storing `raw_manager` / `raw_direct_reports` | Not stored | Not used by any MVP feature. Can be added later via migration. |

### 15.2 Complexity That Is Justified

| Component | Why It's Needed |
|---|---|
| OTP with bcrypt | User asked for OTP verification. Can't simplify to "just trust the username." |
| Persistent audit trail | Relinking risk requires audit trail for post-incident review. |
| Idempotency via run_key | Server restarts are realistic for a Docker Compose setup without HA. |
| Conversation state in DB | Bot restarts during onboarding flow would lose user progress otherwise. |
| Partial unique indexes | Critical for the "one Base ↔ one Telegram" invariant. Application logic alone is insufficient due to race conditions. |
| Delivery state machine (pending/sending/delivered) | Crash ambiguity window is real for Telegram sendMessage. Must be modeled explicitly. |
| Dual-axis OTP rate limiting | Prevents cross-Telegram email flooding attack that single-axis rate limiting misses. |

---

## 16. Security Risks (Severity-Ranked)

### CRITICAL

| # | Risk | Description | Mitigation |
|---|---|---|---|
| S1 | **Base API token exposure** | If any token is leaked (logs, error messages, Git), attacker gets full read access to all Base data for that module. | Never log tokens. `.env` in `.gitignore`. Docker secrets for production. Rotate immediately if exposed. |
| S2 | **Telegram Bot token exposure** | Attacker can impersonate the bot, send fake messages to all linked users. | Same as S1. Additionally, set bot commands via BotFather to prevent spoofing. |

### HIGH

| # | Risk | Description | Mitigation |
|---|---|---|---|
| S3 | **OTP brute force** | 6-digit OTP has 1M possibilities. Without limits, an attacker could guess in ~500K attempts on average. | 5 attempts per OTP. 5 OTPs per 15 minutes (both axes). 1-hour lockout after 3 exhausted OTPs. Effective window: 25 guesses max. |
| S4 | **Relink without notification** | Attacker with email access relinks victim's Base account to their Telegram, silently intercepting reminders. | Notify previous Telegram account on relink. Audit log. Verify-before-unlink ensures old link persists until new verification succeeds. |
| S5 | **Email channel security** | OTP sent via email. If email is not over TLS, OTP could be intercepted. | Enforce STARTTLS on SMTP connection (port 587: `secure: false`, `requireTLS: true`). For port 465: `secure: true` (implicit TLS). |
| S6 | **OTP/data leakage in group chats** | User accidentally interacts with bot in a group, exposing OTP or digest data to other group members. | Private-chat-only enforcement. Bot ignores and warns on non-private messages. |

### MEDIUM

| # | Risk | Description | Mitigation |
|---|---|---|---|
| S7 | **Username enumeration** | Attacker can discover valid Base usernames through the bot (different response for "not found" vs "found"). | Use ambiguous response: "Nếu username hợp lệ, OTP sẽ được gửi tới email đã đăng ký." — However, this hurts UX significantly for an internal tool. **Decision: Accept this risk** for ~30 internal users where usernames are already known to colleagues. |
| S8 | **Digest data in Telegram messages** | Reminders contain task/job/request titles visible in Telegram. If Telegram account is compromised, this data is exposed. | Minimize data in digest messages (titles + links only, no descriptions/attachments). This is inherent to the feature and accepted. |
| S9 | **PostgreSQL without encryption at rest** | Data in PostgreSQL is stored unencrypted on disk. | Acceptable for internal Docker Compose deployment on a controlled server. LUKS/full-disk encryption at OS level if needed. |
| S10 | **Cross-Telegram OTP email flooding** | Multiple Telegram accounts spam OTP requests for the same Base user. | Dual-axis rate limiting: per-base_user_id cap of 5 OTP requests per 15 minutes. |
| S11 | **Telegram HTML injection** | Base-originated text containing `<`, `>`, `&` could break or inject content in Telegram messages. | Mandatory HTML escaping of all Base-originated strings before Telegram rendering. |

### LOW

| # | Risk | Description | Mitigation |
|---|---|---|---|
| S12 | **Log injection** | Malicious task titles could inject log entries. | Structured JSON logging (pino) inherently prevents log injection. Additionally, task content is never logged (IDs/counts only). |
| S13 | **Denial of service on OTP** | Attacker spams OTP requests to fill up the user's email. | Dual-axis rate limiting: 5 OTP requests per 15 minutes per Telegram user AND per Base user. |
| S14 | **Stale user data** | Deactivated Base user continues receiving reminders until next sync. | Sync runs 5 minutes before reminder. Worst case: 24-hour stale window. Acceptable. |

---

---

## 18. Architecture Conformance Matrix (Items 1–50)

This matrix reconciles the original design baseline against the current production codebase across all 50 items specified in the architecture specification.

### 18.1 Conformance Classifications

- **`IMPLEMENTED`**: Fully implemented in code matching the original architectural specification.
- **`EVOLVED`**: Implemented with intentional architectural improvements, security hardening, or domain refinements.
- **`DEFERRED`**: Intentionally postponed to post-MVP milestones (e.g. M3+) or paused pending external upstream APIs.
- **`NOT_APPLICABLE`**: No longer relevant due to architectural simplifications.
- **`MISSING`**: Required in MUST scope but absent from codebase (Blocker if present).

---

### 18.2 Complete 1–50 Conformance Table

| # | Priority | Original Specification | Status | Implementation Location & Evolution Rationale |
|:---|:---|:---|:---|:---|
| **1** | MUST | PostgreSQL schema + migrations (M1 tables) | **EVOLVED** | `src/db/migrate.ts`, `src/db/migrations/001_base_users.sql`, `002_m1b_pipeline.sql`. Evolved from external `node-pg-migrate` to lightweight native transactional SQL runner using `schema_migrations`. |
| **2** | MUST | Base API client with retry + bounded concurrency + backoff with jitter | **IMPLEMENTED** | `src/base-api/client.ts`. Single unified retry policy (3 attempts, exponential backoff with ±25% jitter), `pLimit(3)` bounded concurrency, and 15s timeout. |
| **3** | MUST | HTTP 429 handling with Retry-After | **IMPLEMENTED** | `src/base-api/client.ts`. Detects HTTP 429 and dynamically honors `Retry-After` header with a conservative 5s fallback. |
| **4** | MUST | No retry on permanent 4xx errors (except 429) | **IMPLEMENTED** | `src/base-api/client.ts`. `classifyError()` categorizes HTTP 400, 401, 403, 404 as non-retryable permanent failures. |
| **5** | MUST | Base user sync (full refresh, upsert) | **IMPLEMENTED** | `src/sync/user-sync.ts`. Executes transactional full upsert matching canonical Base user `id`, soft-deactivating missing workspace accounts. |
| **6** | MUST | Wework collector (incomplete + overdue/due-today filter) | **EVOLVED** | `src/collectors/wework.ts`. Added `review=1` task exclusion to prevent reminder noise when tasks are submitted to managers for review. |
| **7** | MUST | Workflow collector (active jobs, username = current stage assignee) | **IMPLEMENTED** | `src/collectors/workflow.ts`. Filters active jobs where current stage `username` matches target user with timezone-aware deadline sorting. |
| **8** | MUST | Request collector (pending + `isRequestActionableForUser()`) | **IMPLEMENTED** | `src/collectors/request.ts`. Evaluates sequential (first unapproved owner) and parallel approvers; generates canonical deep links. |
| **9** | MUST | Channel-agnostic digest builder (structured output with per-module status) | **IMPLEMENTED** | `src/digest/builder.ts`. Assembles `UserDigest` with structured status (`ready`, `empty`, `partial`, `error`) and isolated module counts. |
| **10** | MUST | Per-module error tracking in digest (never silently treat error as empty) | **IMPLEMENTED** | `src/digest/builder.ts`, `src/scheduler/reminder-job.ts`. Preserves individual module error states; failed modules trigger partial warning banners. |
| **11** | MUST | Scheduler with idempotency (node-cron + run_key) | **EVOLVED** | `src/db/queries/runs.ts`, `src/scheduler/cron.ts`. Evolved `run_key` format to namespaced keys (`scheduled:YYYY-MM-DD`, `manual:...`, `test:...`) preventing collisions. |
| **12** | MUST | `GET /health` endpoint (localhost-bound) | **IMPLEMENTED** | `src/health/server.ts`. Native Node HTTP server bound to internal `127.0.0.1:3000` reporting DB latency, passive API timestamps, and run info. |
| **13** | MUST | Structured logging (pino, IDs/counts/status/timing only) | **IMPLEMENTED** | `src/logging/logger.ts`. Outputs structured JSON with ISO timestamps containing operational metadata only. |
| **14** | MUST | Docker Compose (app + PostgreSQL, no exposed DB port) | **EVOLVED** | `Dockerfile`, `docker-compose.yml`. Hardened with multi-stage Node 24 alpine build, non-root `appuser`, isolated `internal` bridge network, and `json-file` log size rotation limits (`10m`, `3` files). |
| **15** | MUST | Config validation at startup (fail fast) | **IMPLEMENTED** | `src/config/index.ts`. Validates required environment variables at boot with isolated subsystem loaders (`loadCoreConfig`, `loadTelegramConfig`, `loadSmtpConfig`). |
| **16** | MUST | Secret redaction in logs | **IMPLEMENTED** | `src/logging/logger.ts`. Serializer-level redaction censors all token variables, passwords, OTPs, emails, and authorization headers across all log levels. |
| **17** | MUST | Request module: fail closed on unknown workflow type | **IMPLEMENTED** | `src/collectors/request.ts`. Returns `false` for any workflow type other than `"sequential"` or `"parallel"`. |
| **18** | MUST | Missed run detection on startup | **IMPLEMENTED** | `src/scheduler/cron.ts`. `checkMissedRun()` catches up weekday runs if server boots between 08:15 and 10:00 ICT recovery cutoff. |
| **19** | MUST | PostgreSQL migrations for M2 tables | **EVOLVED** | `src/db/migrations/003_m2a_telegram_auth.sql`, `004_m2b_delivery_metadata.sql`. Created `telegram_links`, `otp_challenges`, `telegram_conversations`, `audit_log`, and `reminder_delivery_chunks`. |
| **20** | MUST | Telegram bot setup (grammy, long polling, private-chat-only) | **IMPLEMENTED** | `src/telegram/bot.ts`. grammY bot with long polling, `privateChatOnlyMiddleware` enforcement, and native menu commands. |
| **21** | MUST | Onboarding flow (username → OTP → link) | **IMPLEMENTED** | `src/telegram/handlers/text-dispatcher.ts`, `src/telegram/services/linking-service.ts`. Multi-step state machine orchestrating username validation, OTP dispatch, and linking. |
| **22** | MUST | OTP generation + bcrypt hashing + email send | **IMPLEMENTED** | `src/telegram/services/otp-service.ts`, `src/email/smtp-client.ts`. Generates 6-digit numeric OTP (`crypto.randomInt`), hashes with bcrypt (cost 10), and delivers via SMTP STARTTLS. |
| **23** | MUST | OTP verification with attempt limits | **IMPLEMENTED** | `src/db/queries/otp.ts`. `recordFailedOtpAttempt()` increments attempts with `FOR UPDATE` lock; invalidates challenge on 5th failure. |
| **24** | MUST | OTP dual-axis rate limiting (per telegram_user_id + per base_user_id) | **IMPLEMENTED** | `src/db/queries/otp.ts`. `createOtpChallengeAtomic()` serializes checks with advisory locks, enforcing max 5 OTPs per 15 min on both axes. |
| **25** | MUST | Telegram digest formatter (HTML escaping, message splitting) | **IMPLEMENTED** | `src/telegram/formatter.ts`. Formats HTML messages, escapes Base text, truncates titles at 180 chars, and splits into chunks ≤ 3,500 chars. |
| **26** | MUST | Telegram digest delivery with delivery state machine | **EVOLVED** | `src/delivery/delivery-service.ts`, `src/db/queries/chunks.ts`. Evolved to include persistent chunk-level delivery state machine in `reminder_delivery_chunks` table (`UNIQUE(delivery_id, chunk_index)`). |
| **27** | MUST | Partial digest delivery with explicit warning to user on module failure | **IMPLEMENTED** | `src/telegram/formatter.ts`. Appends warning banner (`⚠️ Không thể tải dữ liệu: ...`) for failed modules while delivering successful sections. |
| **28** | MUST | `/unlink` command | **EVOLVED** | `src/telegram/handlers/unlink.ts`. Hardened with corporate email OTP verification prior to link deactivation to prevent unauthorized unlinking. |
| **29** | MUST | Relinking with OTP re-verification (verify-before-unlink, atomic transaction) | **IMPLEMENTED** | `src/telegram/services/linking-service.ts`, `src/db/queries/telegram-links.ts`. Atomically deactivates old link and creates new link in a single SQL transaction. |
| **30** | MUST | Relink notification to previous Telegram | **IMPLEMENTED** | `src/telegram/services/linking-service.ts`. Sends post-commit security alert to previous Telegram account upon account transfer. |
| **31** | MUST | Conversation state persistence (DB) | **IMPLEMENTED** | `src/db/queries/conversations.ts`. `telegram_conversations` table persists onboarding state (`IDLE`, `AWAIT_USERNAME`, `AWAIT_OTP`, `AWAIT_UNLINK_OTP`, `LINKED`). |
| **32** | MUST | Audit log for all link/unlink/OTP events | **IMPLEMENTED** | `src/db/queries/audit.ts`. Persists structured security events in PostgreSQL `audit_log` table. |
| **33** | MUST | `reminder_deliveries` per-user tracking with per-module status | **IMPLEMENTED** | `src/db/queries/deliveries.ts`. Tracks run-level and user-level status, module counts, error messages, and delivery timestamps. |
| **34** | MUST | Stale `sending` delivery policy (mark ambiguous, do not auto-re-send) | **EVOLVED** | `src/delivery/delivery-service.ts`. `recoverStaleSending()` automatically marks unresolved `sending` records as `ambiguous` (`AMBIGUOUS_AFTER_CRASH`) on startup without auto-resend. |
| **35** | MUST | SMTP STARTTLS configuration (port 587: secure=false + requireTLS) | **IMPLEMENTED** | `src/email/smtp-client.ts`, `src/config/index.ts`. Enforces STARTTLS on port 587 (`requireTLS: true`) and SSL on port 465 (`secure: true`). |
| **36** | MUST | HTML escaping of all Base-originated text in Telegram messages | **IMPLEMENTED** | `src/telegram/utils/html.ts`. `escapeHtml()` escapes `<`, `>`, `&`, `"` across all task, job, request, and username fields. |
| **37** | MUST | Zero actionable items → no message sent (record as "empty" in DB) | **IMPLEMENTED** | `src/telegram/formatter.ts`, `src/delivery/delivery-service.ts`. Formatter returns `[]` when total items = 0; recorded cleanly as `empty` in DB. |
| **38** | SHOULD | `/status` command (show current link info + last reminder) | **IMPLEMENTED** | `src/telegram/handlers/status.ts`. Displays linked Base user, masked email, link date, and reminder state. |
| **39** | SHOULD | `/stop` and `/resume` commands | **IMPLEMENTED** | `src/telegram/handlers/stop-resume.ts`. Toggles `reminders_enabled` flag in database. |
| **40** | SHOULD | Graceful shutdown (finish in-progress deliveries before exit) | **IMPLEMENTED** | `src/index.ts`. Handles `SIGTERM`/`SIGINT` by sequentially stopping bot, cancelling cron, stopping health server, and draining DB pool. |
| **41** | SHOULD | Startup self-test (verify all 4 Base tokens are valid) | **EVOLVED** | `src/config/index.ts`. Token presence validated fail-fast at boot; active API pings avoided at boot to conserve quota per §14.1/§15.1; manual testing available via `npm run sync:users` / `npm run reminder:dry-run`. |
| **42** | SHOULD | OTP lockout after 3 exhausted OTPs in 1 hour | **IMPLEMENTED** | `src/db/queries/otp.ts`. Rejects OTP generation if 3 or more challenges reached max attempts in the past 60 minutes. |
| **43** | SHOULD | Timezone-aware deadline display (Asia/Ho_Chi_Minh in messages) | **IMPLEMENTED** | `src/telegram/formatter.ts`, `src/collectors/wework.ts`. All date grouping and formatting pinned to `Asia/Ho_Chi_Minh` (UTC+7). |
| **44** | SHOULD | Wework pagination handling (currently assumed single page) | **IMPLEMENTED** | `src/base-api/wework.ts`. `getAllUserTasks()` implements multi-page traversal with loop limits (max 20) and duplicate ID guards. |
| **45** | SHOULD | Workflow pagination handling (page_id cursor) | **IMPLEMENTED** | `src/base-api/workflow.ts`. `getAllActiveJobs()` iterates cursor pagination (`page_id`) with loop limits and duplicate ID guards. |
| **46** | LATER | Admin `/admin sync` command | **DEFERRED** | CLI equivalent `npm run sync:users` implemented in `src/sync/sync-cli.ts`; in-bot admin command deferred to M3+. |
| **47** | LATER | Delivery status dashboard | **DEFERRED** | Planned for M3+; basic operational visibility provided via `GET /health` and CLI `npm run reminder:dry-run`. |
| **48** | LATER | Alerting on consecutive failed runs | **DEFERRED** | Planned for M3+; failures logged at error level with Pino and reported in `/health`. |
| **49** | LATER | Webhook mode for Telegram | **DEFERRED** | Long polling is the standard for single-instance private EC2 deployment; webhook mode not required. |
| **50** | LATER | Database backup automation | **IMPLEMENTED** | Automated backup script (`backup-db.sh`), gzip compression, 14-day retention, S3 sync, and non-destructive restore drill validated in `docs/operations.md` and `docs/pre-production-risk-review.md`. |

---

### 18.3 Classification Metrics Summary

```text
MUST_IMPLEMENTED      = 29
MUST_EVOLVED          = 8
MUST_MISSING          = 0
SHOULD_IMPLEMENTED    = 7
SHOULD_EVOLVED        = 1
SHOULD_DEFERRED       = 0
LATER_IMPLEMENTED     = 1
LATER_DEFERRED        = 4
DEPLOYMENT_BLOCKER    = NO
```

### 18.4 Production Deployment Assessment

- **MUST Requirements**: 100% satisfied (29 IMPLEMENTED, 8 EVOLVED for enhanced security/correctness, 0 MISSING).
- **SHOULD Requirements**: 100% satisfied (7 IMPLEMENTED, 1 EVOLVED, 0 DEFERRED).
- **LATER Requirements**: 1 IMPLEMENTED (Item 50: Database backup automation), 4 DEFERRED to post-pilot M3+.
- **Zero Deployment Blockers**: No security risks or critical missing items identified.
- **Production Status**: **APPROVED FOR AWS EC2 DEPLOYMENT**.

---

## 19. Milestone Roadmap & Subsequent Phases

### Completed Milestones
- **M0 — Base API Probe**: Validated Account, Wework, Workflow, Request endpoints.
- **M0.1 — Deep Request Analysis**: Validated approval actionability logic and sequential/parallel chains.
- **M1 — Core Backend Infrastructure**: Implemented collectors, PostgreSQL persistence, digest engine, healthcheck.
- **M2A — Telegram Bot Auth & Linking**: Implemented Telegram bot, OTP service via corporate email, atomic linking, OTP-hardened `/unlink`.
- **M2B — Morning Reminder Pipeline**: Implemented chunk-level delivery state machine, crash recovery, 08:15 ICT cron scheduler, and operational preview/test tools.

### Current Milestone State
- **M2C — Base Sign Research Checkpoint (PAUSED)**:
  - Canonical numeric document IDs verified (`document.id`).
  - Canonical deep links verified (`https://sign.base.vn/detail/{id}`).
  - Scope `APP.ADMIN` token verified (`BASE_SIGN_TOKEN`).
  - ExtAPI server endpoints on `sign.base.vn` return unrouted 404; production collector is **PAUSED** pending Base.vn server-to-server API route publication ([`docs/sign-api-findings.md`](sign-api-findings.md)).

### Future Milestones (Post-Pilot)
- **M3 — Operations & Observability (LATER)**:
  - External monitoring dashboards.
  - Automated alerting on consecutive run failures.
  - In-bot `/admin` maintenance commands.

---

## Appendix A: Environment Variables

```dotenv
# === Database ===
DATABASE_URL=postgresql://base_reminder:password@db:5432/base_reminder

# === Base API Tokens (v2) ===
BASE_ACCOUNT_TOKEN=<token>
BASE_WEWORK_TOKEN=<token>
BASE_WORKFLOW_TOKEN=<token>
BASE_REQUEST_TOKEN=<token>

# === Telegram ===
TELEGRAM_BOT_TOKEN=<token from BotFather>

# === SMTP (for OTP emails) ===
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=noreply@example.com
SMTP_PASS=<password>
SMTP_FROM="Base Reminder <noreply@example.com>"

# === Scheduler ===
REMINDER_CRON="15 8 * * 1-5"         # 08:15 Mon-Fri
REMINDER_TIMEZONE=Asia/Ho_Chi_Minh

# === OTP ===
OTP_TTL_MINUTES=10
OTP_MAX_ATTEMPTS=5
OTP_RATE_LIMIT_WINDOW_MINUTES=15
OTP_RATE_LIMIT_MAX_REQUESTS=5

# === App ===
HEALTH_PORT=3000
HEALTH_BIND=127.0.0.1
LOG_LEVEL=info
NODE_ENV=production

# === Base API Client ===
BASE_API_CONCURRENCY=3
BASE_API_TIMEOUT_MS=15000
```

## Appendix B: Docker Compose Structure

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    env_file: .env
    # Health endpoint is localhost-bound inside container.
    # Use Docker healthcheck or internal network for monitoring.
    volumes:
      - ./logs:/app/logs

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: base_reminder
      POSTGRES_USER: base_reminder
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U base_reminder"]
      interval: 10s
      timeout: 5s
      retries: 5
    # No published ports — DB accessible only via Docker internal network.
    # Uncomment the following ONLY for local development:
    # ports:
    #   - "127.0.0.1:5432:5432"

volumes:
  pgdata:
```

## Appendix C: Request Module — Fail-Closed Decision Table

| `request.workflow` value | Behavior | Rationale |
|---|---|---|
| `"sequential"` | First `owners[]` element with `approved === 0` is current approver | Proven by M0.1 probe |
| `"parallel"` | All `owners[]` elements with `approved === 0` are actionable | Proven by M0.1 probe |
| Any other value (or missing) | Return `false` (not actionable) | Fail closed — unknown workflow type must not surface unverified items |

## Appendix D: SMTP TLS Configuration Reference

| Port | `secure` | `requireTLS` | Behavior |
|---|---|---|---|
| 587 (submission) | `false` | `true` | Connect plaintext, upgrade to TLS via STARTTLS. Fail if STARTTLS unavailable. **Recommended.** |
| 465 (implicit TLS) | `true` | N/A | Connect directly over TLS. Use if provider requires port 465. |
| 25 (relay) | `false` | `true` | Not recommended. Use only for internal relay servers. |

> [!WARNING]
> Never set both `secure: false` and `requireTLS: false` for OTP delivery. This would allow plaintext email transmission, exposing OTP codes in transit.

---

*End of architecture review. No implementation code included.*
