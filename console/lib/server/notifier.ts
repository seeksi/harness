// console/lib/server/notifier.ts
// ntfy push notifier. Fires on the three alert conditions (§6): gate raised ·
// run failed/stuck · run completed. HTTP POST to `${NTFY_URL}/${NTFY_TOPIC}` with a
// deep-link (Click header) back to the item. NO-OP when either env var is unset —
// notification failures NEVER block a run (best-effort, swallow errors).
//
// Deep-link base: CONSOLE_BASE_URL (or its alias NTFY_DEEPLINK_BASE — either name
// works, first one set wins) instead of a hardcoded host assumption, so a phone's
// ntfy tap resolves to wherever the console is actually reachable (tailnet name,
// port, etc. — deploy-specific, never baked in).

import type { RunState } from "@/lib/contract/types";
import { runRoute } from "@/lib/routes";

export type NotifyKind = "gate-raised" | "run-failed" | "run-stuck" | "run-completed";

export interface NotifyInput {
  kind: NotifyKind;
  runId: string;
  projectName: string;
  detail?: string; // e.g. "Gate B raised on px-b"
  // Absolute or path deep-link to the item; combined with CONSOLE_BASE_URL if relative.
  link?: string;
}

const TITLES: Record<NotifyKind, string> = {
  "gate-raised": "Gate raised",
  "run-failed": "Run failed",
  "run-stuck": "Run stuck",
  "run-completed": "Run completed",
};

// ntfy priority + tags per kind (phone-side visual/urgency).
const META: Record<NotifyKind, { priority: string; tags: string }> = {
  "gate-raised": { priority: "high", tags: "warning" },
  "run-failed": { priority: "urgent", tags: "rotating_light" },
  "run-stuck": { priority: "high", tags: "warning" },
  "run-completed": { priority: "default", tags: "white_check_mark" },
};

function deepLink(link?: string, runId?: string): string | undefined {
  const base = (process.env.CONSOLE_BASE_URL ?? process.env.NTFY_DEEPLINK_BASE)?.replace(/\/$/, "");
  if (link && /^https?:\/\//.test(link)) return link;
  const suffix = link ?? (runId ? runRoute(runId) : "");
  if (base) return `${base}${suffix}`;
  return link; // relative; better than nothing for the ntfy Click header
}

// Returns true if a notification was POSTed, false when disabled or on failure.
export async function notify(input: NotifyInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = process.env.NTFY_URL?.replace(/\/$/, "");
  const topic = process.env.NTFY_TOPIC;
  if (!url || !topic) return false; // disabled — no-op

  const { kind, projectName, detail, runId, link } = input;
  const meta = META[kind];
  const title = `${TITLES[kind]} · ${projectName}`;
  const body = detail ?? `${projectName} — ${TITLES[kind].toLowerCase()}`;
  const click = deepLink(link, runId);

  const headers: Record<string, string> = {
    Title: title,
    Priority: meta.priority,
    Tags: meta.tags,
  };
  if (click) headers.Click = click;

  try {
    const res = await fetchImpl(`${url}/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body,
    });
    return res.ok;
  } catch {
    // Best-effort: a down ntfy server must never fail the run.
    return false;
  }
}

// Diff two successive run snapshots and emit the alert conditions that fired on THIS
// transition (§6: gate raised · run failed/stuck · run completed). Pure + edge-triggered
// (fires once when the condition first becomes true) so the daemon can call notify() for
// each without re-alerting on every event. Deep-link is the run route.
export function notificationsFor(before: RunState | undefined, after: RunState): NotifyInput[] {
  const out: NotifyInput[] = [];
  const base = { runId: after.runId, projectName: after.projectName, link: runRoute(after.runId) };

  // gate-raised: a gate now `raised` that was absent or not-raised before.
  for (const g of after.gates) {
    if (g.status !== "raised") continue;
    const prev = before?.gates.find((x) => x.id === g.id);
    if (!prev || prev.status !== "raised") {
      out.push({
        ...base,
        kind: "gate-raised",
        detail: `Gate ${g.id} raised${g.subtaskId ? ` on ${g.subtaskId}` : ""}: ${g.summary}`,
      });
    }
  }

  // run-completed: reached `done` this transition.
  if (after.status === "done" && before?.status !== "done") {
    out.push({ ...base, kind: "run-completed", detail: `${after.projectName} run completed` });
  }

  // run-failed / run-stuck: became failed OR the producer flagged a trajectory anomaly.
  const failedNow = after.status === "failed";
  const failedBefore = before?.status === "failed";
  const stuckNow = after.reportedHealth === "stuck";
  const stuckBefore = before?.reportedHealth === "stuck";
  if (failedNow && !failedBefore) {
    out.push({ ...base, kind: "run-failed", detail: `${after.projectName} run failed` });
  } else if (stuckNow && !stuckBefore && !failedNow) {
    out.push({ ...base, kind: "run-stuck", detail: `${after.projectName} run stuck (trajectory anomaly)` });
  }

  return out;
}
