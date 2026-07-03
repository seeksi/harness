// web/lib/memory/proposeFromHarness.ts
// Human-gated write wrapper — the ONLY write path from HARNESS into memory-os.
// Semantics (interface contract, Workstreams B/C):
//   - secret-like content     -> 'rejected' locally, NEVER reaches the CLI
//   - decision/constraint OK  -> 'provisional' (memory-os persists it, but we ledger
//     it in a local pending file; NOT surfaced as committed knowledge until an
//     operator confirms — memory-os audit_required is NOT a human gate, so the
//     human gate lives here on the HARNESS side)
//   - task/entity OK          -> 'committed'
//   - memory-os unreachable / timeout -> 'queued' (appended to a local retry file)
//   - this function NEVER throws.

import fs from "fs";
import path from "path";
import { isMemoryOsEnabled, runMemCli } from "./memoryOsClient";

export type ProposeStatus = "committed" | "provisional" | "queued" | "rejected";
export interface ProposeResult {
  status: ProposeStatus;
  reason?: string;
}
export type HarnessRecordType = "decision" | "constraint" | "entity" | "task";

// Ported 1:1 from memory-os SECRET_PATTERNS
// (/home/alter/claude/memory-os/memory_layer/engine/audit.py). Keep the two sets in
// lockstep: this local prefilter must reject at least everything the engine would.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-[A-Za-z0-9]{16,}\b/, "api token (sk-)"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "github token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws access key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "slack token"],
  [/\b(password|passwd|secret|api[ _-]?key|seed[ _-]?phrase|mnemonic|private[ _-]?key)\b\s*[:=]\s*\S+/i,
    "credential assignment"],
  // ponytail: labeled secrets only (same ceiling as audit.py) — detecting an
  // UNlabeled BIP39 seed phrase needs the 2048-word wordlist; add if raw
  // mnemonics become a real risk.
];

/** Return the names of matched secret patterns; [] = clean. */
export function scanSecretsLocal(text: string): string[] {
  const hits: string[] = [];
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

// Local ledger files. Same data-dir idiom as web/lib/store/persist.ts (DB_PATH
// "./data/umbrella.db" relative to the web cwd). JSONL, append-only.
// ponytail: plain appendFileSync JSONL, no locking/rotation — single daemon
// process writes these; move into the SQLite store if concurrent writers appear.
const PENDING_FILE = () =>
  process.env.MEMORY_PENDING_PATH ?? "./data/memory-pending-provisionals.jsonl";
const QUEUE_FILE = () =>
  process.env.MEMORY_QUEUE_PATH ?? "./data/memory-retry-queue.jsonl";

function appendJsonl(file: string, entry: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...entry }) + "\n");
    return true;
  } catch (err) {
    console.error(`[memory-os] failed to append ${file}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

interface CliProposeOutput {
  verdict?: string;
  reasons?: string[];
  update_id?: string;
  memory_updates_saved?: string[];
}

/**
 * Propose one record into the single `harness` memory-os project. Lane identity
 * travels as lane_id/subtask_slug fields ON the record — never one project per lane.
 */
export async function proposeFromHarness(
  slug: string,
  recordType: HarnessRecordType,
  record: Record<string, unknown>
): Promise<ProposeResult> {
  // 1. Secret prefilter — hard local block before anything leaves the process.
  //    Runs even when memory-os is disabled: a secret-bearing record must never
  //    be queued for a later retry either.
  const secrets = scanSecretsLocal(JSON.stringify(record));
  if (secrets.length > 0) {
    return { status: "rejected", reason: `secret-like content: ${secrets.join(", ")}` };
  }

  // 2. Feature gate. Disabled => report 'queued' but write nothing (importing and
  //    calling with the flag unset must stay side-effect free).
  if (!isMemoryOsEnabled()) {
    return { status: "queued", reason: "ENABLE_MEMORY_OS not set" };
  }

  // 3. Propose via the CLI. Exit 2 = structured rejection (JSON still on stdout);
  //    anything else unparseable = unreachable => queue locally for retry.
  let out: string;
  try {
    out = await runMemCli(["propose", slug, recordType, JSON.stringify(record), "--by", "harness"]);
  } catch (err) {
    const stdout = (err as { stdout?: string } | null)?.stdout ?? "";
    const parsed = tryParse(stdout);
    if (parsed?.verdict === "rejected") {
      return { status: "rejected", reason: (parsed.reasons ?? []).join("; ") || "rejected by memory-os audit" };
    }
    appendJsonl(QUEUE_FILE(), { slug, recordType, record });
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[memory-os] propose(${slug}/${recordType}) unreachable, queued: ${msg}`);
    return { status: "queued", reason: msg };
  }

  const result = tryParse(out);
  if (!result || result.verdict !== "approved") {
    // Defensive: exit 0 should mean approved; treat anything else as a rejection.
    return { status: "rejected", reason: (result?.reasons ?? []).join("; ") || "unexpected memory-os response" };
  }

  // 4. Human gate: memory-os persists approved decisions/constraints immediately
  //    (cli.py::propose), so ledger them locally as pending operator confirmation.
  if (recordType === "decision" || recordType === "constraint") {
    appendJsonl(PENDING_FILE(), {
      slug,
      recordType,
      update_id: result.update_id,
      saved_record_id: result.memory_updates_saved?.[0],
      record,
      operator_confirmed: false,
    });
    return { status: "provisional" };
  }
  return { status: "committed" };
}

function tryParse(text: string): CliProposeOutput | null {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? (v as CliProposeOutput) : null;
  } catch {
    return null;
  }
}
