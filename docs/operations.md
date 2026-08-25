# Base Reminder — Operations & Runbook

This document provides day-to-day operational procedures, troubleshooting steps, and backup/restore runbooks for the Base Reminder production system.

---

## 1. Daily Operations & Status Checks

### Check Container Status

```bash
docker compose ps
```

Expected state:
- `base-reminder-app-1`: `Up`
- `base-reminder-db-1`: `Up (healthy)`

### Inspect Health Endpoint

```bash
docker compose exec app wget -qO- http://127.0.0.1:3000/health
```

### View Application Logs

```bash
# Follow live logs
docker compose logs -f app

# View last 100 lines with timestamps
docker compose logs -n 100 -t app

# Filter errors only
docker compose logs app | grep -E '"level":"error"|"level":"fatal"'
```

---

## 2. Service Management

### Restarting the Application

```bash
docker compose restart app
```

### Restarting the Database

```bash
docker compose restart db
```

### Emergency Scheduler Disable

If reminders need to be stopped immediately:

```bash
# Option A: Fast disable in .env and restart app
sed -i 's/ENABLE_CRON_SCHEDULER=true/ENABLE_CRON_SCHEDULER=false/' .env
docker compose restart app

# Option B: Stop app container completely
docker compose stop app
```

---

## 3. Manual Testing & CLI Operations

All CLI tools can be executed inside the running container:

### Manual User Directory Sync

```bash
docker compose exec app npm run sync:users
```

### Preview User Digest (Plain text output, does NOT send)

```bash
docker compose exec app npm run digest:preview -- --username <username>
```

### Send Preview Reminder (Sends to user's Telegram without recording as daily run)

```bash
docker compose exec app npm run reminder:send-preview -- --username <username>
```

### Send Test Reminder (Sends and records in database)

```bash
docker compose exec app npm run reminder:send-test -- --username <username>
```

### Dry Run Entire System (Evaluates all users without sending)

```bash
docker compose exec app npm run reminder:dry-run
```

---

## 4. Backup & Disaster Recovery

### Backup Strategy

- **Tool**: `pg_dump` compressed with gzip.
- **Frequency**: Daily cron at 02:00 UTC.
- **Retention**: 14 days locally; optional sync to private S3 bucket.

### Automated Local Backup Script

Create `/opt/base-reminder/scripts/backup-db.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/base-reminder/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/base_reminder_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

# Extract DB credentials from .env
source /opt/base-reminder/.env

# Execute pg_dump inside db container
docker compose -f /opt/base-reminder/docker-compose.yml exec -T db \
  pg_dump -U base_reminder -d base_reminder | gzip -9 > "${BACKUP_FILE}"

echo "[$(date)] Backup completed: ${BACKUP_FILE} ($(du -h "${BACKUP_FILE}" | cut -f1))"

# Prune backups older than retention window
find "${BACKUP_DIR}" -type f -name "base_reminder_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
```

Make executable and register in cron:

```bash
chmod +x /opt/base-reminder/scripts/backup-db.sh

# Crontab entry: daily at 02:00
# 0 2 * * * /opt/base-reminder/scripts/backup-db.sh >> /var/log/base-reminder-backup.log 2>&1
```

### Manual Backup Command

```bash
docker compose exec -T db pg_dump -U base_reminder -d base_reminder | gzip > /opt/base-reminder/backups/backup_manual_$(date +%F).sql.gz
```

### Non-Production Backup / Restore Validation Drill

To prove backup integrity without touching the live database:

```bash
# 1. Create a test compressed dump
docker compose exec -T db pg_dump -U base_reminder -d base_reminder | gzip > /tmp/restore_drill.sql.gz

# 2. Create an isolated temporary drill database
docker compose exec -T db psql -U base_reminder -d postgres -c "CREATE DATABASE restore_drill_temp;"

# 3. Restore dump into the temporary database
gunzip -c /tmp/restore_drill.sql.gz | docker compose exec -T db psql -U base_reminder -d restore_drill_temp

# 4. Verify table row counts in the restored database
docker compose exec -T db psql -U base_reminder -d restore_drill_temp -c "
  SELECT table_name, (xpath('/row/cnt/text()', xml_count))[1]::text::int as row_count
  FROM (
    SELECT table_name, query_to_xml(format('select count(*) as cnt from %I', table_name), false, true, '') as xml_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
  ) t ORDER BY table_name;"

# 5. Clean up temporary database and drill file
docker compose exec -T db psql -U base_reminder -d postgres -c "DROP DATABASE restore_drill_temp;"
rm -f /tmp/restore_drill.sql.gz
```

### Off-Server Storage (Private S3 Bucket)

For disaster recovery against EC2 instance loss, copy daily backups to a private S3 bucket using EC2 IAM Role authentication:

```bash
# Sync local backups to S3 (requires IAM Role attached to EC2 instance):
aws s3 sync /opt/base-reminder/backups/ s3://company-private-backups/base-reminder/ --delete
```

---

## 5. Storage & Disk Capacity Management

### Operational Disk Usage Thresholds

On the target 20 GB gp3 EC2 root disk:

| Usage Level | Threshold | Operational Classification | Action Required |
|:---|:---|:---|:---|
| **Normal** | `< 70%` | Healthy | Routine monitoring via daily checks |
| **Warning** | `70% - 79%` | Warning | Inspect build cache, prune dangling Docker images, check backup count |
| **Action Required** | `80% - 89%` | Elevated Risk | Execute safe Docker builder/image cleanup, verify old backup pruning |
| **Critical** | `>= 90%` | Critical Alert | Immediate cleanup: vacuum system logs, remove unused images, trigger alert |

### Check Disk Space & Docker Volumes

```bash
# Check host filesystem utilization
df -h /

# Check Docker disk consumption breakdown
docker system df -v
```

### Safe Cleanup Commands

```bash
# 1. Prune unused build cache
docker builder prune -f

# 2. Prune dangling/untagged Docker images
docker image prune -f

# 3. Prune old local backups (keep last 14 days)
find /opt/base-reminder/backups -name "base_reminder_*.sql.gz" -mtime +14 -delete

# 4. Truncate systemd journal logs older than 3 days
sudo journalctl --vacuum-time=3d
```

> [!CAUTION]
> **DANGEROUS COMMANDS — DO NOT RUN IN PRODUCTION:**
> - `docker compose down -v` → **DELETES THE DATABASE VOLUME (`pgdata`) AND DESTROYS ALL DATA!**
> - `docker system prune -a --volumes` → **DELETES ALL UNATTACHED VOLUMES AND IMAGES!**
> Always use `docker compose down` (WITHOUT `-v`) to stop containers safely.

---

## 6. Host Security, Clock & File Permissions

### Host Clock & NTP Verification

Accurate time synchronization is required for 08:00 ICT cron triggers and OTP token expiry calculations:

```bash
# Verify system clock and NTP synchronization
timedatectl status
```

Expected output:
- `NTP service: active`
- `System clock synchronized: yes`
- `Time zone: Asia/Ho_Chi_Minh` (or UTC with correct UTC time)

### File Permissions Audit

Production credentials and backups must have strict file permissions:

```bash
# Lock down .env (readable only by owner)
chmod 600 /opt/base-reminder/.env

# Lock down backup directory and files
chmod 700 /opt/base-reminder/backups
chmod 600 /opt/base-reminder/backups/* 2>/dev/null || true
```

---

## 7. Troubleshooting & Diagnostics

### Issue 1: Telegram 409 Conflict Error (`terminated by other getUpdates request`)

- **Symptom**: Logs show `TelegramError: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`.
- **Root Cause**: Two processes/containers are polling Telegram with the same `TELEGRAM_BOT_TOKEN`.
- **Invariant**: Exactly **ONE** process may poll Telegram with the production token.
- **Diagnosis**:
  1. Check if multiple containers are running on EC2: `docker ps | grep base-reminder`.
  2. Check if a developer's local machine is running `npm run start` or tests using the production bot token.
  3. Verify no `docker compose up --scale app=2` was executed.
- **Resolution**:
  - Terminate the extraneous local or secondary instance immediately.
  - Restart the production container: `docker compose restart app`.

### Issue 2: Delivery Error Investigation

- **Symptom**: User did not receive their morning reminder.
- **Diagnosis**:
  1. Check if user is linked and active:
     ```bash
     docker compose exec db psql -U base_reminder -d base_reminder -c "
       SELECT u.username, u.email, l.reminders_enabled, l.unlinked_at
       FROM base_users u
       JOIN telegram_links l ON u.id = l.base_user_id
       WHERE u.username = '<username>';"
     ```
  2. Check latest run status:
     ```bash
     docker compose exec db psql -U base_reminder -d base_reminder -c "
       SELECT run_key, status, users_total, users_delivered, users_empty, users_error, started_at
       FROM reminder_runs ORDER BY id DESC LIMIT 5;"
     ```
  3. Inspect user delivery row and chunks:
     ```bash
     docker compose exec db psql -U base_reminder -d base_reminder -c "
       SELECT d.id, d.status, d.wework_status, d.workflow_status, d.request_status, d.error_message, d.telegram_error_code
       FROM reminder_deliveries d
       JOIN base_users u ON d.base_user_id = u.id
       WHERE u.username = '<username>'
       ORDER BY d.id DESC LIMIT 3;"
     ```

### Issue 3: Ambiguous Delivery / Stale `sending` Status

- **Symptom**: Delivery row has status `sending` or chunks have status `ambiguous` after an unexpected crash or network timeout.
- **Policy**: The delivery service automatically runs crash recovery on startup and marks stale `sending` chunks (> 5 min) as `ambiguous`. It never blindly re-sends ambiguous deliveries to prevent double notifications.
- **Diagnosis & Fix**:
  ```bash
  # Check stuck sending deliveries
  docker compose exec db psql -U base_reminder -d base_reminder -c "
    SELECT * FROM reminder_deliveries WHERE status = 'sending' AND delivery_started_at < NOW() - INTERVAL '30 minutes';"
  ```
  - Mark stuck rows as `error` if needed:
    ```sql
    UPDATE reminder_deliveries SET status = 'error', error_message = 'Marked error after timeout' WHERE status = 'sending';
    ```

### Issue 4: Base API 401 / 403 Token Expiration

- **Symptom**: Collector logs show `401 Unauthorized` or `403 Forbidden` for a specific module.
- **Diagnosis**: Base API tokens expired or permissions changed.
- **Resolution**:
  1. Generate new `access_token_v2` in https://account.base.vn.
  2. Update the corresponding token variable (`BASE_WEWORK_TOKEN`, etc.) in `.env`.
  3. Restart app: `docker compose restart app`.
  4. Verify with dry-run: `docker compose exec app npm run reminder:dry-run`.
