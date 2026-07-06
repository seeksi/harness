// console/lib/contract/alerts.ts
// Pure alert-transition logic shared by BOTH the server-side ntfy notifier
// (lib/server/notifier.ts) and the client-side desk chime (lib/chime.ts) — a
// neutral module with no fs/child_process/env access, so it's safe to import into
// a client bundle. Keeping this in one place means the two channels can never
// drift out of sync on what counts as an alert; the actual I/O (the ntfy POST,
// the Web Audio synth) stays in each channel's own module.

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

// Diff two successive run snapshots and emit the alert conditions that fired on THIS
// transition (§6: gate raised · run failed/stuck · run completed). Pure + edge-triggered
// (fires once when the condition first becomes true) so a caller can act on each without
// re-alerting on every event. Deep-link is the run route.
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
