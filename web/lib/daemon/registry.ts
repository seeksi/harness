// web/lib/daemon/registry.ts
// Server-owned provenance registry for harness args (threat model §7 / T1).
// A lane slug, trace session, or plan file may be passed to harness.sh ONLY if
// the server minted it here — matching a regex is NOT sufficient on its own.
//
// HARD CONTRACT: mint* must be called ONLY with server-generated/derived values
// (the lanes the daemon decomposed into, the session ids it generated, the plan
// files it wrote). NEVER pass client/browser input to mint* — doing so launders
// untrusted input into "provenance" and defeats the whole control. The mint-time
// regex is a shape check (defense in depth), not the trust boundary; provenance is.
//
// In-process Sets are sufficient: one operator, one slot, single Node process
// (threat model TB-2). _resetRegistry clears minted provenance between tests.

import { HarnessArgError } from "./errors";

const SLUG = /^[a-z][a-z0-9-]{0,30}$/; // worktree/lane slug: lowercase, no separators
const SESSION = /^[A-Za-z0-9_-]{1,64}$/; // trace session id: hex/alphanum
const PLAN_FILE = /^[A-Za-z0-9._-]+$/; // bare filename only — no path separators

const lanes = new Set<string>();
const sessions = new Set<string>();
const planFiles = new Set<string>();

function mint(set: Set<string>, pattern: RegExp, value: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) {
    throw new HarnessArgError(`invalid ${what} at mint: ${JSON.stringify(value)}`);
  }
  set.add(value);
  return value;
}

/** Record a lane slug the server decomposed into; only minted slugs reach harness.sh. */
export const mintLane = (slug: string): string => mint(lanes, SLUG, slug, "lane slug");
/** Record a trace session id the server generated; only minted ids reach harness.sh. */
export const mintSession = (id: string): string => mint(sessions, SESSION, id, "session id");
/** Record a plan file the server wrote; only minted plan files reach harness.sh. */
export const mintPlanFile = (name: string): string => mint(planFiles, PLAN_FILE, name, "plan file");

export const isLane = (slug: string): boolean => lanes.has(slug);
export const isSession = (id: string): boolean => sessions.has(id);
export const isPlanFile = (name: string): boolean => planFiles.has(name);

/** Test-only: clear minted provenance between cases. */
export function _resetRegistry(): void {
  lanes.clear();
  sessions.clear();
  planFiles.clear();
}
