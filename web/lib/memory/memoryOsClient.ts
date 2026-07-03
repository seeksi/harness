// web/lib/memory/memoryOsClient.ts
// Read-only enrichment client for memory-os. This module (plus proposeFromHarness.ts)
// is the ONLY code path between HARNESS and memory-os. Everything is gated behind
// ENABLE_MEMORY_OS=1 and fails OPEN: disabled / unreachable / timeout / bad output
// all yield null so Gates A-D are never blocked by the memory layer.
//
// Shells out to `python3 memory_layer/engine/cli.py` (stdlib-only, path-independent:
// store.py resolves its data dirs from __file__, so no cwd is required). Runs
// `index sync` before every read so the SQLite index reflects the JSON truth.
// Importing this module has zero side effects.

import { execFile } from "child_process";
import path from "path";

/** Master switch. Same pattern as ENABLE_AGENT_EXEC / ENABLE_PROMOTE_TO_MAIN. */
export function isMemoryOsEnabled(): boolean {
  return process.env.ENABLE_MEMORY_OS === "1";
}

// Read env at call time (not module load) so tests / late dotenv can set them.
function memoryOsDir(): string {
  return process.env.MEMORY_OS_DIR ?? "/home/alter/claude/memory-os";
}
function timeoutMs(): number {
  const n = Number(process.env.MEMORY_OS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/**
 * Run one mem CLI subcommand. Resolves stdout on exit 0, rejects otherwise
 * (including timeout). shell:false — argv is never shell-interpreted. The error
 * carries `stdout` (execFile attaches it) so callers can still parse a structured
 * refusal (e.g. `propose` exits 2 on a rejected verdict but prints its JSON result).
 */
export function runMemCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cli = path.join(memoryOsDir(), "memory_layer", "engine", "cli.py");
    execFile(
      "python3",
      [cli, ...args],
      { timeout: timeoutMs(), maxBuffer: 4 * 1024 * 1024, shell: false },
      (err, stdout) => {
        if (err) {
          // Preserve stdout for structured-refusal parsing (see proposeFromHarness).
          (err as NodeJS.ErrnoException & { stdout?: string }).stdout = stdout;
          reject(err);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

/** `index sync` before reads; a sync failure is treated like any read failure. */
async function syncIndex(): Promise<void> {
  await runMemCli(["index", "sync"]);
}

function logFailOpen(op: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[memory-os] ${op} failed open (skipping enrichment): ${msg}`);
}

/**
 * Ranked search over one project's memory. Returns the engine's result rows
 * verbatim (each row carries kind/id/score/freshness/label — staleness fields are
 * surfaced as returned, never filtered here). null = disabled or failed (fail-open).
 */
export async function memSearch(slug: string, query: string): Promise<unknown[] | null> {
  if (!isMemoryOsEnabled()) return null;
  try {
    await syncIndex();
    const out = await runMemCli(["search", slug, query]);
    const parsed = JSON.parse(out) as { results?: unknown[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch (err) {
    logFailOpen(`search(${slug})`, err);
    return null;
  }
}

/**
 * Build a dispatch packet (BM25-trimmed context bundle) for a task. Returned as
 * the engine emits it, freshness metadata included. null = disabled or failed.
 */
export async function memPacket(slug: string, task: string, objective: string): Promise<unknown | null> {
  if (!isMemoryOsEnabled()) return null;
  try {
    await syncIndex();
    const out = await runMemCli(["packet", slug, "--task", task, "--objective", objective]);
    return JSON.parse(out) as unknown;
  } catch (err) {
    logFailOpen(`packet(${slug})`, err);
    return null;
  }
}
