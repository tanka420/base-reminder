# Base API Findings

> Generated: 20:02:21 20/8/2026 (Asia/Ho_Chi_Minh)

## Summary

| Module | Collection | Adapter | Probed | PASS | FAIL | SKIP | NOT_CONFIGURED |
|---|---|---|---|---|---|---|---|
| account | T1Dv6u6m | configured | 4 | 4 | 0 | 0 | 0 |
| wework | SztA68Az | configured | 0 | 0 | 0 | 0 | 0 |
| workflow | SWE84Hd1 | configured | 0 | 0 | 0 | 0 | 0 |
| request | SzzheyWQ | configured | 0 | 0 | 0 | 0 | 0 |

---

## Account

- **Host**: `https://account.base.vn`
- **Collection**: `T1Dv6u6m`
- **Adapter status**: `configured`

### `Get All Users`

- **Status**: PASS
- **HTTP**: 200
- **URL**: `https://account.base.vn/extapi/v1/users`
- Identity fields found: users[].email, users[].username
- Rate limit: not observed in response headers

### `Search user by username [user=BaseAssistance]`

- **Status**: PASS
- **HTTP**: 200
- **URL**: `https://account.base.vn/extapi/v1/user/search.by.username`
- Identity fields found: user.email, user.username
- Rate limit: not observed in response headers

### `Search user by username [user=Digital01]`

- **Status**: PASS
- **HTTP**: 200
- **URL**: `https://account.base.vn/extapi/v1/user/search.by.username`
- Identity fields found: user.email, user.username
- Rate limit: not observed in response headers

### `Search user by username [user=Executive01]`

- **Status**: PASS
- **HTTP**: 200
- **URL**: `https://account.base.vn/extapi/v1/user/search.by.username`
- Identity fields found: user.email, user.username
- Rate limit: not observed in response headers

---

## Wework

- **Host**: `https://wework.base.vn`
- **Collection**: `SztA68Az`
- **Adapter status**: `configured`

_(not probed)_

---

## Workflow

- **Host**: `https://workflow.base.vn`
- **Collection**: `SWE84Hd1`
- **Adapter status**: `configured`

_(not probed)_

---

## Request

- **Host**: `https://request.base.vn`
- **Collection**: `SzzheyWQ`
- **Adapter status**: `configured`

_(not probed)_

---

## Open Questions

_(Fill in after reviewing sanitized responses)_

### Workflow
- [ ] Field name for current stage assignee: `___`
- [ ] Full field path in job object: `job.___`
- [ ] Cross-user visibility (1 token sees jobs for multiple users): yes / no

### Wework
- [ ] Task list endpoint: `___`
- [ ] Deadline field name: `___`
- [ ] Deadline format: `___`
- [ ] Deadline timezone: `___`
- [ ] Status value for "incomplete": `___`
- [ ] Status value for "overdue": `___`

### Request
- [ ] Request list endpoint: `___`
- [ ] Current approver field: `___`
- [ ] Field path: `request.___`

### Account
- [ ] User list endpoint: `___`
- [ ] user_id field: `___`
- [ ] username field: `___`
- [ ] fullname field: `___`
- [ ] email field: `___`

## Proposed Data Mapping

_(Fill in after probe)_

| System field | Base API field | Module | Notes |
|---|---|---|---|
| user_id | `___` | Account | |
| username | `___` | Account | |
| task_id | `___` | Wework | |
| task assignee | `___` | Wework | |
| task deadline | `___` | Wework | format: ___ |
| task status (incomplete) | `___` | Wework | value: ___ |
| task status (overdue) | `___` | Wework | value: ___ |
| job_id | `___` | Workflow | |
| job current stage assignee | `___` | Workflow | |
| request_id | `___` | Request | |
| request current approver | `___` | Request | |