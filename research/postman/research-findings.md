# Research Findings — Base Postman Collections

## Research Date: 2026-08-20

## Collection Snapshots

| Module | Collection ID | Owner | Name | Snapshot saved |
|---|---|---|---|---|
| Account | T1Dv6u6m | 1623302 | Base Account Public API | `base-account.postman_collection.json` |
| Wework | SztA68Az | 1345096 | Wework Public API | `base-wework.postman_collection.json` |
| Request | SzzheyWQ | 1345096 | Request Public API | `base-request.postman_collection.json` |
| Workflow | SWE84Hd1 | 1345096 | Workflow Public API | *(fetched in previous session)* |

---

## CRITICAL FINDING: auth key divergence

| Module | Auth key in collection | Notes |
|---|---|---|
| Account | `access_token_v2` | Confirmed v2 key |
| Wework | `access_token` | Collection uses legacy key |
| Workflow | `access_token` | Collection uses legacy key |
| Request | `access_token` | Collection uses legacy key |

**Impact**: Base v2 token migration (Nov 2025) changes the *key name* to `access_token_v2`.  
The probe script sends `access_token_v2` for ALL modules (per project requirement — v2 only).  
This must be verified at runtime. If Wework/Workflow/Request still accept only `access_token`,  
that is a blocker requiring investigation with Base support.

---

## BASE ACCOUNT — T1Dv6u6m

**Host**: `https://account.base.vn`  
**API version**: `v1`  
**Auth key**: `access_token_v2`  
**Base URL**: `https://account.base.vn/extapi/v1/`

### All Endpoints

| # | Name | Method | Path | Req. params | Opt. params |
|---|---|---|---|---|---|
| 1 | **Get All Users** | POST | `/extapi/v1/users` | — | — |
| 2 | **Get All Groups (Units)** | POST | `/extapi/v1/units` | — | — |
| 3 | Get Group Detail By Path | POST | `/extapi/v1/group/get` | `path` | — |
| 4 | Search user by email | POST | `/extapi/v1/user/search.by.email` | `email` | — |
| 5 | Search user by username | POST | `/extapi/v1/user/search.by.username` | `username` | — |
| 6 | Deactivate Account | POST | `/extapi/v1/user/deactivate` | `username` | — |
| 7 | Create Account | POST | `/extapi/v1/user/create` | `last_name`, `first_name`, `username`, `email` | `title` |
| 8 | Set direct managers | POST | `/extapi/v1/user/manager` | `username`, `manager` | `overwrite` |
| 9 | Update Account | POST | `/extapi/v1/user/edit` | `username` | `last_name`, `first_name`, `title`, `address`, `image`, `dob_*` |
| 10 | Set application users | POST | `/extapi/v1/subscription/users` | `app`, `usernames` | `teams` |
| 11 | Create Group | POST | `/extapi/v1/network/create` | `path`, `name`, `leader` | `about`, `users` |
| 12 | Add member to group | POST | `/extapi/v1/network/members.add` | `usernames`, `network` | — |
| 13 | Deactivate Multiple Accounts | POST | `/extapi/v1/user/deactivate.multiple` | `usernames` or `emails` | — |
| 14 | Re-activate Multiple Accounts | POST | `/extapi/v1/user/reactivate.multiple` | `usernames` | — |
| 15 | Create Multiple Accounts | POST | `/extapi/v1/user/create.multiple` | `users` (base64 JSON) | `send_email` |
| 16 | Get System Logs | POST | `/extapi/v1/syslogs/get` | — | `action`, `label`, `user`, `page` |
| 17 | Remove User from Group | POST | `/extapi/v1/group/revoke` | `username`, `network` | — |
| 18 | Get login history by username | POST | `/extapi/v1/user/logins` | `username` | `start_date`, `end_date`, `page` |
| 19 | Get all login history | POST | `/extapi/v1/user/logins.all` | — | `start_date`, `end_date`, `page` |

### Endpoints for M0 Probe

| Priority | Name | Endpoint | Purpose |
|---|---|---|---|
| **PRIMARY** | Get All Users | `POST /extapi/v1/users` | Get all workspace users — id, username, fullname, email |
| Secondary | Search user by username | `POST /extapi/v1/user/search.by.username` | Lookup single user by username |
| Secondary | Search user by email | `POST /extapi/v1/user/search.by.email` | Lookup single user by email |

### Documented response fields
No response examples in collection. Probe required to discover:
- user id field name
- username field
- fullname / first_name / last_name
- email
- active status

### Pagination
`Get System Logs` uses `page` (int). `Get All Users` has **no documented pagination** — likely returns all users in one call (suitable for ~30 users).

---

## BASE WEWORK — SztA68Az

**Host**: `https://wework.base.vn`  
**API version**: `v3`  
**Auth key in docs**: `access_token` (legacy — verify `access_token_v2` at runtime)  
**Base URL**: `https://wework.base.vn/extapi/v3/`

### All Endpoints

**Project group**

| Name | Method | Path | Key params |
|---|---|---|---|
| Create new project | POST | `/extapi/v3/project/create` | `username`, `metatype`, `name`, `owners` |
| Edit project by ID | POST | `/extapi/v3/project/edit` | `id`, `username` |
| **List all projects** | POST | `/extapi/v3/project/list` | `page` (0-based), `items_per_page` (def 100), `include_private` |
| **Get summary info of project by ID** | POST | `/extapi/v3/project/get` | `id` |
| **Get detail of project by ID** | POST | `/extapi/v3/project/get.full` | `id`, `start`, `end` (date range for tasks) |
| Manager add list | POST | `/extapi/v3/project/manager/add.list` | `id`, `username`, `users` |
| Manager set list | POST | `/extapi/v3/project/manager/set.list` | `id`, `username`, `users` |
| Manager exchange single | POST | `/extapi/v3/project/manager/exchange.single` | `old_id`, `new_id`, `username`, `user` |
| Member add list | POST | `/extapi/v3/project/member/add.list` | `id`, `username`, `users` |
| Member set list | POST | `/extapi/v3/project/member/set.list` | `id`, `username`, `users` |
| Member exchange list | POST | `/extapi/v3/project/member/exchange.list` | `old_id`, `new_id`, `username`, `users` |
| Remove list users in project | POST | `/extapi/v3/project/user/remove.list` | `id`, `username`, `users` |

**Task group**

| Name | Method | Path | Key params |
|---|---|---|---|
| Create new task | POST | `/extapi/v3/task/create` | `username`, `id` (project), `name`, `assign`, `has_deadline`, `deadline` (dd/mm/YYYY), `status` (0/1) |
| Edit task by ID | POST | `/extapi/v3/task/edit` | `id`, `username` |
| **Get task info by ID** | POST | `/extapi/v3/task/get` | `id` |
| Mark done task | POST | `/extapi/v3/task/status/mark.done` | `id` |
| Load comments by task | POST | `/extapi/v3/task/comments` | `task_id`, `method` (page/prev/next), `position` |
| Get activity logs of task by ID | POST | `/extapi/v3/task/logs` | `id` |
| Get custom table data in a task | POST | `/extapi/v3/task/custom.table` | `id` |
| **Get tasks by project** | POST | `/extapi/v3/task/project` | `id` (project), `page`, `metatype` (task/subtask), `created_from/to`, `updated_from/to`, `limit` (def 20, max 500) |

**User group**

| Name | Method | Path | Key params |
|---|---|---|---|
| **List all tasks by user** | POST | `/extapi/v3/user/tasks` | `user` (@username, user_id, or email), `page` (100/page) |
| List all activities by user | POST | `/extapi/v3/user/activities` | `user`, `page`, `items_per_page` (def 100) |

**Department group** (not relevant for M0)

**Tasklist group**

| Name | Method | Path | Key params |
|---|---|---|---|
| Get tasklist by ID | POST | `/extapi/v3/tasklist/get` | `id` |
| Create new tasklist | POST | `/extapi/v3/tasklist/create` | `username`, `id` (project), `name` |

**Topic group** (not relevant for M0)

### Endpoints for M0 Probe

| Priority | Name | Endpoint | Purpose |
|---|---|---|---|
| **PRIMARY** | List all tasks by user | `POST /extapi/v3/user/tasks` | Get tasks assigned to a user (100/page) |
| **PRIMARY** | Get task info by ID | `POST /extapi/v3/task/get` | Task detail — inspect fields: assign, deadline, status |
| Secondary | Get tasks by project | `POST /extapi/v3/task/project` | Alternative if user/tasks doesn't filter by completion |

### Deadline format (from Create task docs)
- Input format: `deadline` = `dd/mm/YYYY`, `deadline-time` = `H:i`
- **Unknown**: response deadline format (Unix timestamp vs string — probe required)

### Status values (from Create task docs)
- `status`: `0` or `1` — likely 0=incomplete, 1=complete
- **Unknown**: overdue status (may be derived from deadline comparison, not a stored value)

### Pagination
- `user/tasks`: `page` param, 100 records/page
- `task/project`: `page` (0-based), `limit` default 20 max 500

### IMPORTANT: No cross-user filter on user/tasks
`user/tasks` takes a `user` param supporting `@username|user_id|email` — can query any user with the token. This supports the 30-user / 1-token architecture.

---

## BASE REQUEST — SzzheyWQ

**Host**: `https://request.base.vn`  
**API version**: `v1`  
**Auth key in docs**: `access_token` (legacy — verify `access_token_v2` at runtime)  
**Base URL**: `https://request.base.vn/extapi/v1/`

### All Endpoints

**Group group**

| Name | Method | Path | Key params |
|---|---|---|---|
| Get detail of group request by ID | POST | `/extapi/v1/group/get` | `id` |
| List all groups | POST | `/extapi/v1/group/list` | `page` (opt) |

**Request group**

| Name | Method | Path | Key params |
|---|---|---|---|
| Create a new request by direct group | POST | `/extapi/v1/request/direct/create` | `username`, `name`, `approvers` |
| Create a new request by custom group | POST | `/extapi/v1/request/create` | `username`, `group_id`, `name`, `direct_managers` |
| **Get detail of request by ID** | POST | `/extapi/v1/request/get` | `id` |
| **List all requests in system** | POST | `/extapi/v1/request/list` | `group` (opt), `status` (pending/approved/rejected/overdue), `users` (list usernames), `q`, `created_from/to`, `deadline_from/to`, `finish_from/to`, `updated_from/to`, `page` |
| Get detail request with custom table | POST | `/extapi/v1/request/custom.table` | `id` |
| Add follower to request | POST | `/extapi/v1/request/add.follower` | `id`, `username`, `followers` |
| Get posts of request | POST | `/extapi/v1/request/post/load` | `id`, `last_id` (opt) |
| Get comments of post | POST | `/extapi/v1/request/comment/load` | `hid`, `method`, `position` |

### Endpoints for M0 Probe

| Priority | Name | Endpoint | Purpose |
|---|---|---|---|
| **PRIMARY** | List all requests | `POST /extapi/v1/request/list` | Filter by `users` (assignee), `status=pending` |
| **PRIMARY** | Get detail of request | `POST /extapi/v1/request/get` | Inspect approval step / current approver fields |

### Status values (DOCUMENTED)
`status` param: `pending`, `approved`, `rejected`, `overdue`

### User filter on request/list
`users` param = list of usernames (comma-separated). Supports querying by assignee. Unclear if this means "requests where this user is the CURRENT approver" or "requests where user appears anywhere in the chain". **Probe required.**

### Pagination
`page` (0-based integer)

### IMPORTANT: No endpoint for "requests pending my approval"
`request/list` filter by `users` + `status=pending` is the best available option. Whether it isolates current-approver-step vs full chain is **unknown** — probe + detail response inspection required.

---

## Summary for M0 Probe — Endpoints to use

| Module | Endpoint | URL | Used for |
|---|---|---|---|
| Account | Get All Users | `POST https://account.base.vn/extapi/v1/users` | List all workspace users, discover field names |
| Account | Search by username | `POST https://account.base.vn/extapi/v1/user/search.by.username` | Lookup specific probe user |
| Wework | List all tasks by user | `POST https://wework.base.vn/extapi/v3/user/tasks` | Tasks per user, discover status/deadline fields |
| Wework | Get task info by ID | `POST https://wework.base.vn/extapi/v3/task/get` | Task detail with fixture ID |
| Workflow | Get all jobs | `POST https://workflow.base.vn/extapi/v1/jobs/get` | Jobs by assignee + status=active |
| Workflow | Get single job | `POST https://workflow.base.vn/extapi/v1/job/get` | Inspect current stage/assignee structure |
| Request | List all requests | `POST https://request.base.vn/extapi/v1/request/list` | Requests by user + status=pending |
| Request | Get detail of request | `POST https://request.base.vn/extapi/v1/request/get` | Inspect current approver fields |

---

## Unknowns — to be resolved by probe runtime

1. **Auth key**: Do Wework/Workflow/Request accept `access_token_v2` or still require legacy `access_token`?
2. **Wework deadline response format**: collection shows `dd/mm/YYYY` for input, but response format unknown (may be Unix timestamp).
3. **Wework status response**: `status=0/1` for input. Response status enum unknown.
4. **Workflow current stage assignee**: field name in `job/get` response unknown.
5. **Request current approver**: `request/list?users=X&status=pending` may not isolate current-step. Needs response inspection.
6. **Account user fields**: No response examples in collection. Field names unknown until probed.
