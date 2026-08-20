# Base Sign — M2C Research Findings

> Generated: 2026-08-20 23:15 (Asia/Ho_Chi_Minh)  
> Milestone: M2C — Research Checkpoint (Paused)

---

## 1. M2C Status & Executive Summary

> [!IMPORTANT]
> **M2C STATUS:**  
> **PAUSED / BLOCKED PENDING BASE SIGN SUPPORTED API ENDPOINT**
>
> **Core Conclusion:**  
> **Base Sign supports creation of a v2 application token with `APP.ADMIN` scope, but a supported/documented server-to-server Sign API endpoint has not yet been verified.**
>
> In Base Account's third-party integration interface, Base Sign is officially recognized as an application module for v2 access token issuance with `APP.ADMIN` scope. However, unlike the 13 Base applications with publicly documented Postman collections, Base Sign's public server-to-server ExtAPI routes are not published in Base's developer catalog, and standard `/extapi/...` paths on `https://sign.base.vn` currently return unrouted responses (`<h1>File Not Found</h1>`).

---

## 2. Summary of Verified vs Not Yet Verified State

### Verified:
- **Base Account v2 Token UI:** Supports `Base Sign (sign)` application with `APP.ADMIN` scope (Grant administrative access to the app).
- **Canonical Document ID:** Numeric `document.id` (e.g., `209927`).
- **Verified Real Deep Link:** `https://sign.base.vn/detail/{document_id}`.
- **Completed Real Sample:** Document `209927` analyzed and sanitized in `docs/sample-responses/sign-completed-sample.sanitized.json`.
- **Verified Real Origin Sample:** Originates from Base Service with `client_key = "service"` and `origin_object.link = "base-service://services/tickets/8899?stage_id=1234"`.
- **Generic Origin Architecture:** Base Sign is an enterprise-wide shared signing layer and must be modeled generically (`originApp: service | workflow | request | standalone`), not restricted to Workflow/Request.
- **Workflow Job Field:** Workflow jobs expose a `to_sign_token` field when signing is attached.

### Not Yet Verified:
- Supported Base Sign ExtAPI endpoint(s).
- `access_token_v2` authentication contract for server-to-server Sign endpoints.
- Multi-user query behavior using one `APP.ADMIN` token.
- `CURRENT_SIGNER` exact machine-readable field semantics.
- `WAITING_SIGNER` exact machine-readable field semantics.
- `CURRENT_CONFIRMER` exact machine-readable field semantics.
- `WAITING_CONFIRMER` exact machine-readable field semantics.
- Per-user actionable Sign deadline / SLA timestamp in API payloads.
- Workflow ↔ Sign deterministic bidirectional relation.
- Request ↔ Sign deterministic bidirectional relation.
- Cross-app deduplication mechanism without title matching.

---

## 3. Base v2 Token Capability

- **Application Module:** `Base Sign` (`sign`)
- **Scope Available:** `APP.ADMIN` — *Grant administrative access to the app*
- **Token Parameter:** `access_token_v2`
- **Environment Variable:** `BASE_SIGN_TOKEN` (configured locally in `.env`, added as empty placeholder in `.env.example`)
- **Security Constraint:**
  - Production collectors must use strictly `BASE_SIGN_TOKEN`.
  - Never use browser session cookies, `Client.secureData`, viewer tokens, temporary document tokens, or session scraping.

**Status:**
- `SIGN_TOKEN_MODULE = VERIFIED`
- `SIGN_V2_SCOPE = APP.ADMIN`

---

## 4. ExtAPI Endpoint Discovery & Network Inspection

### Controlled Probe Results:
Using `BASE_SIGN_TOKEN` against `https://sign.base.vn`:

1. **`/extapi/...` Route Family (e.g., `/extapi/v1/document/get`, `/extapi/v1/documents`, `/extapi/v1/user/documents`):**
   - **Response:** HTTP 200 with HTML body `<h1>File Not Found</h1>` (`Content-Type: text/html`).
   - **Finding:** The web server on `sign.base.vn` is not routing `/extapi/` requests to an active backend handler.

2. **`/api/...` Route Family (e.g., `/api/v1/document/get`, `/api/document/get`):**
   - **Response:** HTTP 200 redirecting to Base ID Login HTML (`<!DOCTYPE HTML><html><head><title>Đăng nhập - Base.vn`).
   - **Finding:** These are internal web application endpoints guarded by browser session cookies, classified strictly as `INTERNAL_UNSUPPORTED`.

---

## 5. Real Completed Document Sample (Document 209927)

A real Base Sign document was inspected and sanitized into `docs/sample-responses/sign-completed-sample.sanitized.json`.

### Verified Structure:
```json
{
  "document": {
    "id": 209927,
    "name": "[NAME_SANITIZED] Bien ban nghiem thu va thanh ly",
    "client_key": "service",
    "status": "1",
    "sequential": true,
    "num_assigned": 2,
    "num_signed": 2,
    "signed_followers_id": [1001, 1002],
    "sequences": [
      {
        "id": 501,
        "user_id": 1001,
        "username": "[USERNAME_1]",
        "order": 1,
        "status": 1,
        "signed_at": "1774500000"
      },
      {
        "id": 502,
        "user_id": 1002,
        "username": "[USERNAME_2]",
        "order": 2,
        "status": 1,
        "signed_at": "1774503600"
      }
    ],
    "viewer_sign_status": "1",
    "is_confirmer": false,
    "confirm_status": 0,
    "origin_object": {
      "type": "service",
      "link": "base-service://services/tickets/8899?stage_id=1234"
    },
    "data": {
      "origin": {
        "app": "service",
        "ticket_id": "8899",
        "stage_id": "1234"
      },
      "priority": "0",
      "all_users_confirmed": 1
    }
  }
}
```

---

## 6. Canonical Deep Link

- **Verified Real URL:** `https://sign.base.vn/detail/209927`
- **Canonical Formula:** `https://sign.base.vn/detail/{document_id}`
- **Requirement:** Constructed purely from numeric canonical `document.id`.

**Status:**
- `REAL_SIGN_LINK = PASS`
- `SIGN_CANONICAL_DOCUMENT_ID = VERIFIED`

---

## 7. Generic Origin Model & Cross-App Relationships

### Origin Diversity:
The verified sample originated from Base Service (`client_key = "service"`), proving that Base Sign documents originate from multiple Base apps.

### Generic Model:
```typescript
interface SignOrigin {
  app?: string;          // "service" | "workflow" | "request" | "office" | "standalone"
  objectId?: string;     // ticket ID, job ID, request ID
  stageId?: string;      // stage ID if present
  label?: string;        // "từ Service", "từ Workflow", "từ Request"
}
```

### Relations:
- **Base Service:** `SIGN_SERVICE_RELATION = VERIFIED`
- **Base Workflow:** `SIGN_WORKFLOW_RELATION = PARTIAL` (`to_sign_token` present in Workflow job)
- **Base Request:** `SIGN_REQUEST_RELATION = UNKNOWN`

---

## 8. Actionability Semantics & Controlled Comparative Samples Needed

Because Document 209927 is completed (`status = "1"`, all sequences `status = 1`), comparative active test documents are needed once API access is verified:
1. **Sequential Sign Document:**
   - Signer 1 (`User A`), Signer 2 (`User B`).
   - Capture before Signer 1 signs: `User A` (Current) vs `User B` (Waiting).
   - Capture after Signer 1 signs: `User A` (Completed) vs `User B` (Current).
2. **Confirmer Document:**
   - Confirmer (`User C`) before Signer (`User A`).
   - Capture before confirm: `User C` (Current Confirmer) vs `User A` (Waiting Signer).
   - Capture after confirm: `User C` (Completed) vs `User A` (Current Signer).

---

## 9. Deadline / SLA & Recommended UX

- **Deadline Field:** No deterministic per-user actionable deadline field is emitted in API objects.
- **Layout Recommendation:** **Option B (Action-Grouped)**:
  ```
  ✍️ Sign
  
  🖊 Cần ký · N
  1. Hợp đồng phân phối VP Racing
     từ Service · Link
  
  🔎 Cần xác nhận · N
  1. Đề nghị thanh toán quý III
     từ Request · Link
  ```

---

## 10. Cross-App Deduplication Principle

- Base Sign is the source of truth for signing actions.
- Deduplication must rely on machine-readable identifiers (`origin_object.link`, `data.origin.ticket_id`, etc.).
- **Never dedupe using document titles or fuzzy text matching.**
- Status: `CROSS_APP_DEDUPE = UNSOLVED`.

---

## 11. Next Step / Blocker

> [!CAUTION]
> **Implementation Blocker:**  
> Production implementation of Milestone 2C Base Sign remains **BLOCKED** until Base.vn provides or confirms a supported server-to-server Base Sign API endpoint and schema.

### Questions Required from Base.vn Support:
1. **Endpoint(s):** What is the exact ExtAPI path for querying Base Sign documents (e.g. `https://sign.base.vn/extapi/...` or alternative host/gateway)?
2. **HTTP Method & Content-Type:** Is it `POST application/x-www-form-urlencoded`?
3. **Authentication Parameter:** Does it accept `access_token_v2` generated with `APP.ADMIN` scope?
4. **Pagination:** What parameters control pagination (e.g., `page`, `page_id`, `items_per_page`)?
5. **User Filter:** How to query actionable documents for a specific user (e.g., `user`, `username`, or `user_id`)?
6. **Cross-User Querying:** Does a single `APP.ADMIN` token have visibility across all workspace users?
7. **Current Signer Field:** Which field in the response indicates that it is currently the target user's turn to sign?
8. **Current Confirmer Field:** Which field indicates that it is currently the target user's turn to confirm?
9. **Sequential / Parallel Semantics:** How are sequential levels vs parallel signers represented in document items?
10. **Deadline / SLA Timestamp:** Is there an explicit Unix timestamp / ISO date for signer/confirmer deadlines?
11. **Origin / Source Fields:** Which fields link a Sign document back to its parent Workflow job, Request item, or Service ticket?

---

## 12. Final Research Scorecard

```
M2C_STATUS                       = PAUSED
SIGN_TOKEN_MODULE                = VERIFIED
SIGN_CANONICAL_DOCUMENT_ID       = VERIFIED
REAL_SIGN_LINK                   = PASS
SIGN_SUPPORTED_API_ENDPOINT      = BLOCKED/UNKNOWN
SIGN_ACTIONABILITY               = BLOCKED/UNKNOWN
SIGN_DEADLINE                    = UNKNOWN
CROSS_APP_DEDUPE                 = UNSOLVED
PRODUCTION_SIGN_IMPLEMENTATION   = NOT_STARTED
```
