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
docker compose exec -T db pg_dump -U base_reminder -d base_reminder | gzip > backup_manual_$(date +%F).sql.gz
```

### Database Restore Procedure

To restore a backup into a clean or existing database:

```bash
# 1. Stop app container to prevent write contention
docker compose stop app

# 2. Restore database from gzipped dump
gunzip -c backup_manual_YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U base_reminder -d base_reminder

# 3. Start app container
docker compose start app

# 4. Verify health
docker compose exec app wget -qO- http://127.0.0.1:3000/health
```

### Off-Server Storage (Next Resilience Layer)

For disaster recovery against EC2 instance loss, copy daily backups to a private S3 bucket with lifecycle rules:

```bash
# Example AWS CLI sync:
# aws s3 cp "${BACKUP_FILE}" "s3://company-private-backups/base-reminder/"
```

---

## 5. Storage & Disk Usage Monitoring

### Check Disk Space

```bash
# Check host filesystem
df -h /

# Check Docker volume sizes
docker system df -v
```

### Clean Docker Build Cache & Dangling Images

```bash
docker image prune -f
docker builder prune -f
```

---

## 6. Troubleshooting & Diagnostics

### Issue 1: Telegram 409 Conflict Error (`terminated by other getUpdates request`)

- **Symptom**: Logs show `TelegramError: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running`.
- **Root Cause**: Two processes/containers are polling Telegram with the same `TELEGRAM_BOT_TOKEN`.
- **Diagnosis**:
  1. Check if multiple containers are running: `docker ps | grep base-reminder`.
  2. Check if a local development server or second EC2 instance is running with the same token.
  3. Verify no `docker compose up --scale app=2` was executed.
- **Resolution**:
  - Terminate the extraneous process immediately.
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
- **Policy**: The delivery service never blindly re-sends ambiguous deliveries to prevent double notifications.
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
