/**
 * probe-request-deep.ts
 *
 * Focused probe M0.1 for Base Request:
 * 1. Fetch pending & recent requests across groups
 * 2. Find sequential & parallel requests with >= 2 approvers
 * 3. Inspect full request & group objects
 * 4. Test request/list with users=<username> for different approver positions (first pending vs next pending)
 * 5. Document findings & generate sanitized samples
 */

import * as fs from "fs";
import * as path from "path";
import axios, { AxiosResponse } from "axios";
import "dotenv/config";

const token = process.env["BASE_REQUEST_TOKEN"];
if (!token) {
  console.error("BASE_REQUEST_TOKEN is not set.");
  process.exit(1);
}

// Single deterministic sanitizer
class Sanitizer {
  private idMap = new Map<string | number, number>();
  private idCounter = 1000;
  private nameMap = new Map<string, string>();
  private nameCounter = 1;
  private emailCounter = 1;
  private usernameCounter = 1;

  anonymizeId(realId: string | number): number {
    if (!this.idMap.has(realId)) {
      this.idMap.set(realId, this.idCounter++);
    }
    return this.idMap.get(realId)!;
  }

  anonymizeUsername(value: string): string {
    if (!this.nameMap.has(`__u__${value}`)) {
      this.nameMap.set(`__u__${value}`, `[USERNAME_${this.usernameCounter++}]`);
    }
    return this.nameMap.get(`__u__${value}`)!;
  }

  anonymizeName(value: string): string {
    if (!value) return value;
    if (/^[\w.+-]+@[\w-]+\.[a-z]{2,}$/.test(value)) {
      if (!this.nameMap.has(`__e__${value}`)) {
        this.nameMap.set(`__e__${value}`, `[EMAIL_${this.emailCounter++}]`);
      }
      return this.nameMap.get(`__e__${value}`)!;
    }
    if (/^[A-ZÀ-Ỹa-zà-ỹ][\wÀ-ỹ]+([ ][A-ZÀ-Ỹa-zà-ỹ][\wÀ-ỹ]+)+$/.test(value)) {
      if (!this.nameMap.has(`__n__${value}`)) {
        this.nameMap.set(`__n__${value}`, `[NAME_${this.nameCounter++}]`);
      }
      return this.nameMap.get(`__n__${value}`)!;
    }
    return value;
  }

  sanitize(obj: unknown, depth = 0): unknown {
    if (depth > 15 || obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map((x) => this.sanitize(x, depth + 1));
    if (typeof obj !== "object") return obj;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = this.sanitizeField(k, v, depth + 1);
    }
    return out;
  }

  private sanitizeField(key: string, value: unknown, depth: number): unknown {
    if (value === null || value === undefined) return value;
    const lk = key.toLowerCase();

    const idKeys = ["id", "user_id", "request_id", "group_id", "template_id", "approver_id", "step_id"];
    if (idKeys.some((k) => lk === k || lk.endsWith(`_${k}`))) {
      if (typeof value === "number" || typeof value === "string") {
        return this.anonymizeId(value);
      }
    }

    const usernameKeys = ["username", "approvers", "rejecters", "creator_username"];
    if (usernameKeys.some((k) => lk === k)) {
      if (typeof value === "string") return this.anonymizeUsername(value);
      if (Array.isArray(value)) return value.map((v) =>
        typeof v === "string" ? this.anonymizeUsername(v) : this.sanitize(v, depth));
    }

    const nameKeys = ["name", "fullname", "full_name", "display_name", "title"];
    if (nameKeys.some((k) => lk === k) && typeof value === "string") {
      return this.anonymizeName(value);
    }

    if ((lk === "email" || lk.endsWith("_email")) && typeof value === "string") {
      return this.anonymizeName(value);
    }

    if (typeof value === "object") return this.sanitize(value, depth);
    return value;
  }
}

const sanitizer = new Sanitizer();

async function postForm(url: string, params: Record<string, string | number | undefined>): Promise<any> {
  const body = new URLSearchParams();
  body.append("access_token_v2", token!);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") body.append(k, String(v));
  }
  const res: AxiosResponse = await axios.post(url, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000,
  });
  return res.data;
}

async function run() {
  console.log("=== STEP 1: Fetch all groups & requests ===");

  // 1. List groups
  const groupsRes = await postForm("https://request.base.vn/extapi/v1/group/list", {});
  console.log(`Groups returned: ${groupsRes.groups?.length || 0}`);

  // 2. List pending requests
  const pendingRes = await postForm("https://request.base.vn/extapi/v1/request/list", {
    status: "pending",
  });
  const allPending = pendingRes.requests || [];
  console.log(`Total pending requests: ${allPending.length}`);

  // 3. List recent approved/all requests for broader structural analysis
  const recentRes = await postForm("https://request.base.vn/extapi/v1/request/list", {
    page: 0,
  });
  const allRecent = recentRes.requests || [];
  console.log(`Total recent requests (page 0): ${allRecent.length}`);

  const combined = [...allPending, ...allRecent];
  const uniqueReqMap = new Map<number, any>();
  for (const r of combined) {
    uniqueReqMap.set(r.id, r);
  }
  const allUnique = Array.from(uniqueReqMap.values());
  console.log(`Total unique requests inspected: ${allUnique.length}`);

  // Analyze workflows
  const workflows = new Set(allUnique.map((r) => r.workflow));
  console.log(`Observed workflow values:`, Array.from(workflows));

  // Find sequential requests with >= 2 approvers
  const sequentialMultiApprover: any[] = [];
  const parallelMultiApprover: any[] = [];

  for (const r of allUnique) {
    const owners = r.owners || [];
    if (r.workflow === "sequential" && owners.length >= 2) {
      sequentialMultiApprover.push(r);
    }
    if (r.workflow === "parallel" && owners.length >= 2) {
      parallelMultiApprover.push(r);
    }
  }

  console.log(`Sequential requests with >= 2 approvers: ${sequentialMultiApprover.length}`);
  console.log(`Parallel requests with >= 2 approvers: ${parallelMultiApprover.length}`);

  // Fetch full details for candidates
  let candidateSeqDetail: any = null;
  let candidateParDetail: any = null;

  for (const r of sequentialMultiApprover) {
    try {
      const detail = await postForm("https://request.base.vn/extapi/v1/request/get", { id: r.id });
      console.log(`\nInspecting Sequential Request ID ${r.id}:`);
      console.log(`  Name: ${r.name}`);
      console.log(`  Status: ${r.status}, State: ${r.state}`);
      console.log(`  Workflow: ${r.workflow}`);
      console.log(`  Owners count: ${r.owners?.length}`);
      console.log(`  Owners status:`, r.owners?.map((o: any) => `${o.username}:${o.approved}`));
      console.log(`  Approvals:`, r.approvals);
      console.log(`  Group approval_orders:`, detail.group?.approval_orders);
      console.log(`  Current block approver:`, r.current_block_approver);
      console.log(`  Block approvers:`, r.data?.block_approvers);

      if (!candidateSeqDetail || (r.status === "0" && r.owners.some((o: any) => o.approved === 0))) {
        candidateSeqDetail = detail;
      }
    } catch (e: any) {
      console.error(`Error getting detail for ${r.id}:`, e.message);
    }
  }

  // Also check parallel detail
  for (const r of parallelMultiApprover) {
    try {
      const detail = await postForm("https://request.base.vn/extapi/v1/request/get", { id: r.id });
      console.log(`\nInspecting Parallel Request ID ${r.id}:`);
      console.log(`  Name: ${r.name}`);
      console.log(`  Status: ${r.status}, State: ${r.state}`);
      console.log(`  Workflow: ${r.workflow}`);
      console.log(`  Owners status:`, r.owners?.map((o: any) => `${o.username}:${o.approved}`));
      candidateParDetail = detail;
      break;
    } catch (e: any) {
      console.error(`Error getting detail for ${r.id}:`, e.message);
    }
  }

  // === STEP 4: Test request/list with users=<username> for sequential approvers ===
  if (candidateSeqDetail) {
    const r = candidateSeqDetail.request;
    const owners: any[] = r.owners || [];
    console.log(`\n=== STEP 4: Testing request/list?users=<username> for Sequential Request ${r.id} ===`);
    console.log(`Workflow: ${r.workflow}, Status: ${r.status}, State: ${r.state}`);
    console.log(`Owners chain:`, owners.map((o: any, idx: number) => `[${idx}] ${o.username} (approved=${o.approved})`).join(" -> "));

    for (let i = 0; i < owners.length; i++) {
      const ownerUsername = owners[i].username;
      try {
        const queryRes = await postForm("https://request.base.vn/extapi/v1/request/list", {
          users: ownerUsername,
          status: "pending",
        });
        const matched = (queryRes.requests || []).some((req: any) => req.id === r.id);
        console.log(`  Query users=${ownerUsername} (position ${i}, approved=${owners[i].approved}): Found request ${r.id}? -> ${matched}`);
      } catch (err: any) {
        console.error(`  Query users=${ownerUsername} failed:`, err.message);
      }
    }
  }

  // Save sanitized samples
  fs.mkdirSync(path.join("docs", "sample-responses"), { recursive: true });

  if (candidateSeqDetail) {
    const sanitizedSeq = sanitizer.sanitize(candidateSeqDetail);
    const p = path.join("docs", "sample-responses", "request-sequential.sanitized.json");
    fs.writeFileSync(p, JSON.stringify(sanitizedSeq, null, 2), "utf-8");
    console.log(`\nSaved sanitized sequential request to ${p}`);
  }

  if (candidateParDetail) {
    const sanitizedPar = sanitizer.sanitize(candidateParDetail);
    const p = path.join("docs", "sample-responses", "request-parallel.sanitized.json");
    fs.writeFileSync(p, JSON.stringify(sanitizedPar, null, 2), "utf-8");
    console.log(`Saved sanitized parallel request to ${p}`);
  }
}

run().catch(console.error);
