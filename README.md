# base-reminder — Milestone 0: Base API Probe

Hệ thống Telegram Reminder tích hợp Base.vn. Milestone này chỉ thực hiện API probe để xác minh endpoints, response structure, và data mapping trước khi build hệ thống thật.

---

## Prerequisites

- **Node.js ≥ 18**
- **4 Access Token v2** từ Base Account (xem hướng dẫn bên dưới)

---

## Setup

### 1. Cài dependencies

```bash
npm install
```

### 2. Tạo Access Tokens

Đăng nhập `https://account.base.vn` bằng tài khoản **Owner**. Vào **Tích hợp với bên thứ ba ver 2** → Thêm token:

| Token name gợi nhớ | App | Scope |
|---|---|---|
| `reminder-probe-account` | Base Account | Minimal read (ghi lại tên scope chính xác từ UI) |
| `reminder-probe-wework` | Base Wework | Minimal read (ghi lại tên scope chính xác từ UI) |
| `reminder-probe-workflow` | Base Workflow | Minimal read (ghi lại tên scope chính xác từ UI) |
| `reminder-probe-request` | Base Request | Minimal read (ghi lại tên scope chính xác từ UI) |

> **Lưu ý token v2**: Token phải gửi với key `access_token_v2` trong request body. Project này KHÔNG hỗ trợ token v1.

### 3. Tạo file `.env`

```bash
cp .env.example .env
```

Điền vào `.env`:

```dotenv
BASE_ACCOUNT_TOKEN=<token Account>
BASE_WEWORK_TOKEN=<token Wework>
BASE_WORKFLOW_TOKEN=<token Workflow>
BASE_REQUEST_TOKEN=<token Request>

# Tối thiểu 2 username để test cross-user visibility
BASE_PROBE_USERNAMES=username1,username2

# Optional fixture IDs (để test detail endpoints)
PROBE_WEWORK_TASK_ID=10084236
PROBE_WORKFLOW_JOB_ID=3515322
PROBE_REQUEST_ID=2750169
```

---

## Chạy probe

### Probe tất cả modules

```bash
npm run probe -- --all
```

### Probe từng module độc lập

```bash
npm run probe -- --module account
npm run probe -- --module wework
npm run probe -- --module workflow
npm run probe -- --module request
```

> **Missing token**: Nếu token của một module chưa được điền, module đó sẽ bị skip với trạng thái `[SKIP]`. Các module khác vẫn chạy bình thường.

---

## Output

| File | Mô tả |
|---|---|
| Console | `[PASS]` / `[FAIL]` / `[SKIP]` / `[BLOCKER]` cho mỗi endpoint |
| `docs/base-api-findings.md` | Findings tổng hợp (endpoints, field mapping, blockers) |
| `docs/sample-responses/*.sanitized.json` | Response mẫu đã sanitize — không chứa PII |

### Sanitization

Sample responses được sanitize theo các quy tắc:
- **Giữ nguyên**: field names, data types, nesting structure, enum values, status strings, deadline formats
- **Redact PII**: tên người, email cụ thể → `[NAME_1]`, `[EMAIL_1]`
- **Deterministic ID mapping**: cùng real ID → cùng anonymous placeholder trong tất cả files
- **Không log**: token, raw request body có token, stack trace có PII

---

## Kết quả probe

Xem [`docs/base-api-findings.md`](docs/base-api-findings.md) sau khi chạy.

---

## Tech stack (Milestone 0 only)

- **Runtime**: Node.js 18+, TypeScript 5, tsx
- **HTTP**: axios
- **Config**: dotenv
