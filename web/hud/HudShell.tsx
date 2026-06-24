// web/hud/HudShell.tsx — Lane C sole writer.
// Glass HUD container. Mounts the accessible mirror + aria-live (unchanged), plus
// the inbox rail (single authoritative action line), ⌘K palette, trace drawer,
// inline approval detail, and the non-blocking toast. Orchestrates the
// "open-detail-is-sacred" rule (sacred.ts): a newly-raised gate surfaces only when
// no detail is open, else it queues and a toast is offered when the detail closes.
// Does NOT import scene/** — lint boundary enforced by eslint.config.mjs.
"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { RunStore } from "@/lib/contract/store";
import type { RunState } from "@/lib/contract/types";
import { useRunState } from "@/lib/store/useRunState";
import { DomMirror } from "./a11y/DomMirror";
import { HudLiveRegions } from "./a11y/LiveRegion";
import {
  announcePhaseChange,
  announceGateRaised,
  announceGateResolved,
  announceGateCleared,
  gateUrgency,
} from "./a11y/announce";
import { deriveInbox, type InboxItem } from "./inbox";
import { onGateArrival } from "./sacred";
import { InboxRail } from "./InboxRail";
import { CommandPalette } from "./CommandPalette";
import { TraceDrawer } from "./TraceDrawer";
import { Toast } from "./Toast";
import { ApprovalStep } from "./ApprovalStep";
import { glassSurface } from "./glass";
import type { Command } from "./commands";

interface HudShellProps {
  store: RunStore;
}

const SEV: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** Track the previous RunState to diff phase/gate changes for announcements. */
function useAnnouncements(state: RunState) {
  const prev = useRef<RunState>(state);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  useEffect(() => {
    const cur = state;
    const p = prev.current;
    // Accumulate every polite change in this flush; a single-slot last-wins would
    // drop a co-occurring transition (e.g. a Gate B "clear"/commit alongside another
    // gate change in the same frame). Critical escalations stay in the assertive slot.
    const politeLines: string[] = [];
    let nextAssertive = "";

    for (const phase of cur.phases) {
      const prevPhase = p.phases.find((ph) => ph.id === phase.id);
      if (prevPhase && prevPhase.status !== phase.status) {
        politeLines.push(announcePhaseChange(phase.id, phase.status));
      }
    }

    for (const gate of cur.gates) {
      const prevGate = p.gates.find((g) => g.id === gate.id);
      if (!prevGate || prevGate.status !== gate.status) {
        if (gate.status === "raised") {
          const copy = announceGateRaised(gate.id, gate.severity, gate.summary);
          if (gateUrgency(gate.severity) === "assertive") nextAssertive = copy;
          else politeLines.push(copy);
        } else if (gate.status === "resolved") {
          politeLines.push(announceGateResolved(gate.id));
        } else if (gate.status === "clear") {
          // Automated verify cleared the gate (e.g. a lane committed) — tell the operator.
          politeLines.push(announceGateCleared(gate.id, gate.summary));
        }
      }
    }

    if (politeLines.length) setPolite(politeLines.join(" · "));
    if (nextAssertive) setAssertive(nextAssertive);
    prev.current = cur;
  }, [state]);

  return { polite, assertive };
}

export function HudShell({ store }: HudShellProps) {
  const state = useRunState(store);
  const { polite, assertive } = useAnnouncements(state);

  const [openDetail, setOpenDetail] = useState<InboxItem | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; item: InboxItem | null } | null>(null);

  const inbox = useMemo(() => deriveInbox(state), [state]);

  // "Open detail is sacred": surface a newly-raised gate only when no detail is
  // open; otherwise queue it and offer a toast when the detail next closes.
  const seenRaised = useRef<Set<string>>(new Set());
  const queued = useRef<InboxItem[]>([]);

  useEffect(() => {
    // inbox is severity-ordered; the first new gate surfaces (if no detail open),
    // the rest queue — one surface per batch, no overwrite.
    let canSurface = openDetail === null;
    for (const item of inbox) {
      if (item.kind !== "gate" || seenRaised.current.has(item.id)) continue;
      seenRaised.current.add(item.id);
      const action = onGateArrival(item.id, !canSurface);
      if (action.type === "surface") {
        setOpenDetail(item);
        canSurface = false;
      } else {
        queued.current.push(item);
      }
    }
    // forget gates no longer raised (so a re-fire surfaces again) and drop them
    // from the queue so we never toast a resolved gate.
    const live = new Set(inbox.map((i) => i.id));
    for (const id of [...seenRaised.current]) if (!live.has(id)) seenRaised.current.delete(id);
    queued.current = queued.current.filter((q) => live.has(q.id));
  }, [inbox, openDetail]);

  // On close, offer a toast for the highest-severity still-queued gate — without
  // dropping the other queued items.
  useEffect(() => {
    if (openDetail !== null || queued.current.length === 0) return;
    const next = [...queued.current].sort((a, b) => SEV[b.severity] - SEV[a.severity])[0];
    queued.current = queued.current.filter((q) => q.id !== next.id);
    setToast({ message: `Queued: ${next.line}`, item: next });
  }, [openDetail]);

  const commands: Command[] = [
    { id: "trace", label: "Toggle trace drawer", hint: "logs", run: () => setTraceOpen((o) => !o) },
    { id: "close-detail", label: "Close detail", run: () => setOpenDetail(null) },
  ];

  // Resolve an awaiting approval's kind for the detail panel.
  const approvalKind = openDetail?.kind === "approval"
    ? state.phases.find((p) => `approval-${p.id}` === openDetail.id)?.approval?.kind
    : undefined;

  return (
    <div data-testid="hud-shell">
      <DomMirror state={state} />
      <HudLiveRegions politeMessage={polite} assertiveMessage={assertive} />

      <InboxRail state={state} onSelect={setOpenDetail} />
      <CommandPalette commands={commands} />
      <TraceDrawer state={state} open={traceOpen} />
      <Toast
        message={toast?.message ?? null}
        onAction={() => {
          if (toast?.item) setOpenDetail(toast.item);
          setToast(null);
        }}
        onDismiss={() => setToast(null)}
      />

      {openDetail && (
        <section
          aria-label="Detail"
          data-testid="detail-panel"
          style={{
            ...glassSurface(),
            position: "absolute",
            top: 16,
            left: 16,
            width: 360,
            padding: 14,
            borderRadius: 8,
          }}
        >
          <header style={{ fontWeight: 700 }} data-testid="detail-line">
            {openDetail.line}
          </header>
          <p style={{ opacity: 0.8, fontSize: 13 }}>{openDetail.summary}</p>
          {approvalKind === "promote-to-main" || approvalKind === "decompose-split" ? (
            <ApprovalStep runId={state.task.id} kind={approvalKind} onDone={() => undefined} />
          ) : null}
          <button type="button" data-testid="detail-close" onClick={() => setOpenDetail(null)}>
            Close
          </button>
        </section>
      )}
    </div>
  );
}
