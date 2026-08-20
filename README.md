# Base Reminder

Internal Base.vn → Telegram morning reminder system for team productivity.

## Purpose

Base Reminder is an automated service that consolidates pending actionable items across corporate Base.vn modules (Wework, Workflow, Request) and delivers personalized morning digests directly to team members via Telegram.

---

## Production-Supported Base Modules

| Module | Scope / Actionable Criteria | Status |
|---|---|---|
| **Base Account** | User directory synchronization (`id`, `username`, `email`, `display_name`) | ✅ Production |
| **Base Wework** | Overdue tasks + tasks due today (`review=1` excluded) | ✅ Production |
| **Base Workflow** | Active jobs where user is the assigned executor of current stage | ✅ Production |
| **Base Request** | Pending requests where user is current actionable approver (sequential/parallel) | ✅ Production |

### Base Sign Status

- **Status**: ⏸️ **PAUSED** pending supported server-to-server API endpoint.
- Research checkpoint completed ([`docs/sign-api-findings.md`](docs/sign-api-findings.md)).
- Token capability, permissions, and canonical deep-link structure (`https://sign.base.vn/r/:id`) are verified.
- Production Sign collector is **NOT** implemented; zero unverified endpoints in production.

---

## Current Behavior & Features

### Telegram Bot & Self-Onboarding

- **Private-chat-only interaction**: Bot ignores group messages.
- **Corporate email OTP onboarding**: Users verify identity via 6-digit OTP sent to their workspace corporate email.
- **Commands**:
  - `/start`: Initiates onboarding or greets linked users.
  - `/status`: Displays linked Base username, email, reminder pause status, and last reminder run info.
  - `/stop`: Pauses daily morning reminders.
  - `/resume`: Resumes daily morning reminders.
  - `/unlink`: Unlinks Telegram account from Base user (protected with email OTP confirmation).
  - `/help`: Shows available commands and help guide.

### Morning Reminders

- **Schedule**: Monday through Friday at **08:15 (Asia/Ho_Chi_Minh)**.
- **Scheduler flag**: Disabled by default (`ENABLE_CRON_SCHEDULER=false`) until explicitly enabled in production.
- **Item Filtering**:
  - **Wework**: Incomplete tasks overdue or due today. Tasks in review (`review=1`) are excluded.
  - **Workflow**: Active jobs at current actionable stage.
  - **Request**: Pending requests where user is the current sequential or parallel approver.
- **Delivery Integrity**:
  - **Zero actionable items**: No spam messages sent; recorded as `empty` in database.
  - **Partial failure handling**: If one Base module encounters an error, available module digests are sent with an explicit warning notice.
  - **Canonical deep links**: Direct links to specific tasks, jobs, and requests on Base.vn.
  - **Multi-chunk delivery**: Messages exceeding Telegram character limits (4,096 chars) are intelligently split and tracked chunk-by-chunk.
  - **Delivery idempotency**: Runs and deliveries are tracked with unique run keys to prevent duplicate deliveries.

---

## Architecture

```text
               ┌───────────────────────────────────────────┐
               │           Scheduled Cron (08:15)          │
               └─────────────────────┬─────────────────────┘
                                     ▼
 ┌───────────────┐          ┌─────────────────┐          ┌─────────────────┐
 │ Base Account  │ ◄─────── │                 │ ───────► │   Base Wework   │
 ├───────────────┤          │  Base Reminder  │          ├─────────────────┤
 │ Base Workflow │ ◄─────── │  Digest Engine  │ ───────► │  Base Request   │
 └───────────────┘          └────────┬────────┘          └─────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
         ┌─────────────────────┐           ┌─────────────────────┐
         │ PostgreSQL 16 (DB)  │           │ Telegram Bot API    │
         │ (Internal Docker)   │           │ (Delivery & Auth)   │
         └─────────────────────┘           └─────────────────────┘
```

- **Runtime**: Node.js 24 LTS, TypeScript 5, native ESM.
- **Database**: PostgreSQL 16 (internal container network, persistent EBS-backed volume).
- **Telegram Framework**: grammY with long polling (strictly single process instance).
- **Email**: Nodemailer via STARTTLS / TLS SMTP.
- **Observability**: Pino structured JSON logger (strict secret and PII redaction), localhost-bound `/health` endpoint.

---

## Requirements

- **Node.js**: ≥ 24.0.0
- **Docker & Docker Compose**: v2+
- **PostgreSQL**: 16 (or managed via Docker Compose)
- **Base.vn Tokens**: 4 separate `access_token_v2` tokens for Account, Wework, Workflow, and Request
- **Telegram Bot Token**: Created via [@BotFather](https://t.me/BotFather)
- **SMTP Server**: Credentials for sending corporate OTP verification emails

---

## Local Setup

### 1. Clone & Install Dependencies

```bash
git clone <repo-url> base-reminder
cd base-reminder
npm ci
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and provide your credentials. See [Environment Variables](#environment-variables).

### 3. Start Local Database

For local development with PostgreSQL exposed on `127.0.0.1:5432`:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d db
```

### 4. Run Migrations

```bash
npm run migrate
```

### 5. Run Unit Tests & Build

```bash
npm test
npm run build
```

---

## Environment Variables

| Variable | Description | Default | Required |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` | Yes |
| `DB_PASSWORD` | PostgreSQL root password for container | - | Yes (Compose) |
| `BASE_ACCOUNT_TOKEN` | Base Account `access_token_v2` | - | Yes |
| `BASE_WEWORK_TOKEN` | Base Wework `access_token_v2` | - | Yes |
| `BASE_WORKFLOW_TOKEN` | Base Workflow `access_token_v2` | - | Yes |
| `BASE_REQUEST_TOKEN` | Base Request `access_token_v2` | - | Yes |
| `BASE_SIGN_TOKEN` | Base Sign token (currently paused) | - | No |
| `ENABLE_TELEGRAM_BOT` | Enable Telegram bot polling | `false` | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token from @BotFather | - | When bot enabled |
| `SMTP_HOST` | SMTP server hostname | `smtp.gmail.com` | When bot enabled |
| `SMTP_PORT` | SMTP port | `587` | When bot enabled |
| `SMTP_SECURE` | Use SSL direct connection (port 465) | `false` | When bot enabled |
| `SMTP_REQUIRE_TLS` | Enforce STARTTLS (port 587) | `true` | When bot enabled |
| `SMTP_USER` | SMTP username / email address | - | When bot enabled |
| `SMTP_PASS` | SMTP application password | - | When bot enabled |
| `SMTP_FROM` | Sender display name & address | `"Base Reminder" <...>` | No |
| `ENABLE_CRON_SCHEDULER` | Run automatic morning reminders | `false` | Yes |
| `REMINDER_CRON` | Cron schedule expression | `"15 8 * * 1-5"` | No |
| `REMINDER_TIMEZONE` | Cron timezone | `Asia/Ho_Chi_Minh` | No |
| `MISSED_RUN_CUTOFF_HOUR` | Cutoff hour for missed morning runs | `10` | No |
| `HEALTH_HOST` | Internal health check bind host | `127.0.0.1` | No |
| `HEALTH_PORT` | Internal health check port | `3000` | No |
| `LOG_LEVEL` | Pino log level (`info`, `debug`, etc.) | `info` | No |

---

## Database & Migrations

Migrations are stored in [`src/db/migrations/`](src/db/migrations/) and tracked in `schema_migrations`.

| Migration | Description |
|---|---|
| `001_base_users.sql` | Base users canonical directory synced from Account API |
| `002_m1b_pipeline.sql` | `reminder_runs` and `reminder_deliveries` tables |
| `003_m2a_telegram_auth.sql` | `telegram_links`, `otp_challenges`, `telegram_conversations`, `audit_log` |
| `004_m2b_delivery_metadata.sql` | Granular `reminder_delivery_chunks` and delivery metadata |

Run migrations manually:

```bash
npm run migrate
```

*Note: Application automatically runs pending migrations upon startup.*

---

## Useful CLI Commands

| Command | Purpose |
|---|---|
| `npm run sync:users` | Synchronize workspace users from Base Account into local DB (compiled) |
| `npm run digest:preview -- --username <user>` | Generate and print plain-text digest for a user (compiled) |
| `npm run reminder:dry-run` | Run digest generation for all users without sending (compiled) |
| `npm run reminder:send-preview -- --username <user>` | Send formatted reminder preview to linked Telegram user (compiled) |
| `npm run reminder:send-test -- --username <user>` | Send live test reminder, records in DB (compiled) |
| `npm run pipeline:run` | Execute complete manual reminder run for all linked users (compiled) |
| `npm test` | Run full automated test suite |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Start production service from compiled `dist/` |

> [!NOTE]
> Operational commands execute compiled JavaScript from `dist/src/` for production container compatibility (where `devDependencies` like `tsx` are excluded).
> For local TypeScript development without pre-building, use the `:dev` equivalents (e.g. `npm run sync:users:dev`, `npm run reminder:dry-run:dev`, `npm run probe`).

---

## Telegram User Onboarding Flow

1. User sends `/start` to the bot.
2. Bot prompts for Base username (e.g. `digital01`).
3. Bot generates a 6-digit numeric OTP and sends it to the user's corporate email.
4. User enters the OTP in Telegram.
5. Bot verifies OTP (bcrypt hash, 10-minute TTL, max 5 attempts) and activates the account link.
6. Daily morning reminders are now delivered automatically at 08:15 Mon-Fri.

---

## Production Deployment Overview

See detailed documentation:
- **Deployment Runbook**: [`docs/deployment.md`](docs/deployment.md)
- **Operations & Troubleshooting**: [`docs/operations.md`](docs/operations.md)

### Topology

```text
AWS EC2 (Ubuntu 24.04 LTS / t4g.small or t3.small)
 ├── App Container (base-reminder)
 │    └── dist/src/index.js (single instance)
 └── DB Container (PostgreSQL 16)
      └── Named Volume (pgdata) backed by EC2 EBS
```

### Key Production Invariants

1. **Single Poller Invariant**: NEVER run more than one app container with the same Telegram Bot Token (prevents Telegram `HTTP 409 Conflict`).
2. **Internal Network Isolation**: PostgreSQL port `5432` is NOT mapped to the host or internet.
3. **Localhost-Only Health**: `GET /health` binds to `127.0.0.1:3000` inside the container.
4. **Safety Defaults**: Start with `ENABLE_CRON_SCHEDULER=false`, verify manual delivery first, then enable scheduler.

---

## License

Private & Internal — All rights reserved.
