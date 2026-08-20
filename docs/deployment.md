# AWS EC2 Production Deployment Guide

This guide covers deploying **Base Reminder** to an AWS EC2 virtual machine using Docker Compose.

---

## 1. Architecture & Decision Record

### Database Topology Decision

- **Decision**: `DATABASE_TOPOLOGY = POSTGRESQL_16_ON_SAME_EC2`
- **Topology**:
  ```text
  AWS EC2 Instance (Ubuntu 24.04 LTS — t4g.small / t3.small, 20-30 GB gp3 EBS)
   ├── Docker Engine
   │    ├── App Container (`base-reminder:latest`)
   │    │    └── dist/src/index.js (single instance)
   │    └── DB Container (`postgres:16-alpine`)
   │         └── Named Volume `pgdata` (/var/lib/postgresql/data)
   └── Docker Bridge Network (`internal`)
  ```
- **Rationale**:
  - The system serves ~26 internal users with 1 morning reminder batch per workday.
  - Zero external database latency, low operational complexity, minimal AWS bill (~$15-20/month vs $40-60+ with RDS).
  - Data is durably persisted on AWS EBS via Docker named volumes.
  - PostgreSQL port 5432 is strictly internal to Docker network; never exposed to internet or host.

---

## 2. Server Prerequisites & AWS Security Hardening

### AWS EC2 Instance Specifications

- **AMI**: Ubuntu 24.04 LTS (x86_64 or ARM64)
- **Instance Type**: `t4g.small` (ARM64) or `t3.small` (x86_64) (2 GB RAM, 2 vCPU, 2 GB swap)
- **Storage**: 20–30 GB gp3 EBS root volume with **EBS default encryption enabled** (AWS KMS)
- **Metadata Service**: **IMDSv2 required** (`HttpTokens=required`, `HttpPutResponseHopLimit=1`)
- **IAM Role**: Attach EC2 Instance Profile with minimal S3 permissions (`s3:PutObject`) for off-server backups (no static AWS Access Keys in `.env`).

### AWS Security Group Rules

- **Inbound Rules**:
  - `SSH` (TCP 22): Restricted to company static IP / admin VPN only (`<ADMIN_IP>/32`).
  - **Do NOT open ports 80, 443, 3000, 5432 inbound** (no public inbound traffic required; bot uses long-polling, health check is internal localhost).
- **Outbound Rules**:
  - `HTTPS` (TCP 443): Allow to internet (for Base API `*.base.vn` and Telegram API `api.telegram.org`).
  - `SMTP/Submission` (TCP 587 / 465): Allow to corporate mail server (for OTP emails).
  - `DNS` (UDP/TCP 53): Allow for name resolution.

### OS Hardening & Security

- **SSH Configuration**: Disable root login (`PermitRootLogin no`) and disable password authentication (`PasswordAuthentication no`). Key-based authentication only.
- **Clock Synchronization**: Verified via `timedatectl status` (Amazon Time Sync Service active).
- **Automatic Security Updates**: Enable `unattended-upgrades`.

```bash
# Update packages
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg

# Add Docker official GPG key & repo
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine and Docker Compose Plugin
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Allow current user to run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

---

## 3. Deployment Steps

### Step 1: Clone Repository

```bash
mkdir -p /opt/base-reminder
cd /opt/base-reminder
git clone <YOUR_GIT_REPOSITORY_URL> .
```

### Step 2: Configure Production `.env`

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Set the production variables:

```dotenv
NODE_ENV=production

# Database
DB_PASSWORD=<STRONG_RANDOM_POSTGRES_PASSWORD>
DATABASE_URL=postgresql://base_reminder:<STRONG_RANDOM_POSTGRES_PASSWORD>@db:5432/base_reminder

# Base API Tokens (access_token_v2)
BASE_ACCOUNT_TOKEN=<PROD_BASE_ACCOUNT_TOKEN>
BASE_WEWORK_TOKEN=<PROD_BASE_WEWORK_TOKEN>
BASE_WORKFLOW_TOKEN=<PROD_BASE_WORKFLOW_TOKEN>
BASE_REQUEST_TOKEN=<PROD_BASE_REQUEST_TOKEN>
BASE_SIGN_TOKEN=

# Telegram Bot
ENABLE_TELEGRAM_BOT=true
TELEGRAM_BOT_TOKEN=<TELEGRAM_BOT_TOKEN_FROM_BOTFATHER>

# Corporate Email SMTP for OTP
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=noreply@company.com
SMTP_PASS=<SMTP_APP_PASSWORD>
SMTP_FROM="Base Reminder <noreply@company.com>"

# Scheduler (Start with FALSE during initial verification)
ENABLE_CRON_SCHEDULER=false
REMINDER_CRON="15 8 * * 1-5"
REMINDER_TIMEZONE=Asia/Ho_Chi_Minh
MISSED_RUN_CUTOFF_HOUR=10

# Health & Logging
LOG_LEVEL=info
HEALTH_HOST=127.0.0.1
HEALTH_PORT=3000
```

> [!IMPORTANT]
> Keep `ENABLE_CRON_SCHEDULER=false` on initial startup until manual tests and onboarding pass.

### Step 3: Build & Start Containers

```bash
# Build production image
docker compose build

# Start database and application
docker compose up -d
```

### Step 4: Verify Database & Migrations

The application runs migrations automatically on boot. To verify database status:

```bash
# Inspect application logs
docker compose logs -n 50 app

# Check running containers
docker compose ps
```

### Step 5: Check Health Endpoint

The health endpoint is internal to the container / localhost. Test from the host:

```bash
docker compose exec app wget -qO- http://127.0.0.1:3000/health
```

Expected output:

```json
{
  "status": "healthy",
  "checks": {
    "database": { "status": "up", "latency_ms": 2 },
    "base_api_account": { "status": "up", "last_success": null },
    "base_api_wework": { "status": "up", "last_success": null },
    "base_api_workflow": { "status": "up", "last_success": null },
    "base_api_request": { "status": "up", "last_success": null },
    "telegram_bot": { "status": "up" },
    "last_reminder_run": null
  }
}
```

### Step 6: Initial User Directory Sync

Run initial user sync to populate the canonical `base_users` table from Base Account:

```bash
docker compose exec app npm run sync:users
```

### Step 7: Test Telegram Onboarding & Manual Reminder

1. Open Telegram, start a chat with your bot (`/start`).
2. Complete corporate email OTP onboarding.
3. Send a test reminder preview to verify delivery end-to-end:

```bash
docker compose exec app npm run reminder:send-preview -- --username <your_base_username>
```

4. Confirm receipt in Telegram.

### Step 8: Enable Cron Scheduler for Pilot

Once verified, enable the automated morning scheduler in `.env`:

```bash
sed -i 's/ENABLE_CRON_SCHEDULER=false/ENABLE_CRON_SCHEDULER=true/' .env
docker compose restart app
```

Verify in logs that scheduler is active:

```bash
docker compose logs app | grep "scheduler"
```

---

## 4. Updates & Rollback Procedure

### Applying Application Updates

```bash
cd /opt/base-reminder
git pull origin main

# Rebuild image with cached layers
docker compose build app

# Recreate app container with zero DB downtime
docker compose up -d --no-deps app
```

### Rollback Procedure

```bash
cd /opt/base-reminder
git checkout <PREVIOUS_STABLE_COMMIT_OR_TAG>
docker compose build app
docker compose up -d --no-deps app
```
