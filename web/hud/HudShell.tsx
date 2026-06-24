// web/hud/HudShell.tsx — Lane C sole writer.
// Minimal HUD container for the State Spine + Dry Run increment.
// Mounts: DomMirror (accessible semantic projection) + HudLiveRegions (aria-live).
// Does NOT import scene/** — lint boundary enforced by eslint.config.mjs.
// Glass polish, ⌘K, inbox rail, trace drawer, toast → ponytail notes below.
"use client";

import { useRef, useState, useEffect } from "react";
import type { RunStore } from "@/lib/contract/store";
import type { RunState } from "@/lib/contract/types";
import { useRunState } from "@/lib/store/useRunState";
import { DomMirror } from "./a11y/DomMirror";
import { HudLiveRegions } from "./a11y/LiveRegion";
import {
  announcePhaseChange,
  announceGateRaised,
  announceGateResolved,
  gateUrgency,
} from "./a11y/announce";

interface HudShellProps {
  store: RunStore;
}

/** Track the previous RunState to diff phase/gate changes for announcements. */
function useAnnouncements(state: RunState) {
  const prev = useRef<RunState>(state);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  useEffect(() => {
    const cur = state;
    const p = prev.current;
    let nextPolite = "";
    let nextAssertive = "";

    // Phase changes
    for (const phase of cur.phases) {
      const prevPhase = p.phases.find((ph) => ph.id === phase.id);
      if (prevPhase && prevPhase.status !== phase.status) {
        const copy = announcePhaseChange(phase.id, phase.status);
        nextPolite = copy; // last change wins; queue not needed for v1
      }
    }

    // Gate changes
    for (const gate of cur.gates) {
      const prevGate = p.gates.find((g) => g.id === gate.id);
      if (!prevGate || prevGate.status !== gate.status) {
        if (gate.status === "raised") {
          const copy = announceGateRaised(gate.id, gate.severity, gate.summary);
          if (gateUrgency(gate.severity) === "assertive") {
            nextAssertive = copy;
          } else {
            nextPolite = copy;
          }
        } else if (gate.status === "resolved") {
          nextPolite = announceGateResolved(gate.id);
        }
      }
    }

    if (nextPolite)   setPolite(nextPolite);
    if (nextAssertive) setAssertive(nextAssertive);
    prev.current = cur;
  }, [state]);

  return { polite, assertive };
}

export function HudShell({ store }: HudShellProps) {
  const state = useRunState(store);
  const { polite, assertive } = useAnnouncements(state);

  return (
    <div data-testid="hud-shell">
      {/* Accessible semantic mirror — same facts as the 3D scene */}
      <DomMirror state={state} />

      {/* aria-live regions — polite for routine, assertive for critical gates only */}
      <HudLiveRegions politeMessage={polite} assertiveMessage={assertive} />

      {/*
        ponytail: glass HUD (InboxRail, GateDetail, ApprovalStep, CommandPalette,
        TraceDrawer, Toast) — add when glass/shadcn polish increment lands.
        ponytail: <Canvas> 3D scene placeholder — Lane B's scene/Canvas.tsx mounts here
        via a dynamic import after B merges; do NOT import scene/** now (lint forbidden).
        ponytail: PhaseRail 28px idle rows — add with the full HUD layout increment.
      */}
    </div>
  );
}
