// web/hud/a11y/LiveRegion.tsx — Lane C sole writer.
// Two aria-live regions, decisively split:
//   polite    → phase changes, gate raised (non-critical), subtask status
//   assertive → ONLY severity:"critical" gate escalations (WCAG 2.1 guideline)
// Never imports from scene/** (lint boundary enforced by eslint.config.mjs).
"use client";

import { useEffect, useRef } from "react";

interface LiveRegionProps {
  /** Text announced to assistive technology. Changing this value triggers announcement. */
  message: string;
  /** "polite" for routine updates; "assertive" ONLY for critical gate escalations. */
  politeness: "polite" | "assertive";
  /** Visual label for the region (sighted fallback); hidden by default. */
  label?: string;
}

/**
 * LiveRegion renders a visually-hidden aria-live container.
 * We clear then set the message so screen-readers reliably re-announce
 * identical consecutive messages (e.g. Gate D raised twice in a run).
 */
export function LiveRegion({ message, politeness, label }: LiveRegionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<string>("");

  useEffect(() => {
    if (!ref.current || message === prev.current) return;
    prev.current = message;
    // Clear first — forces AT to pick up the new value even if text is identical.
    ref.current.textContent = "";
    const id = setTimeout(() => {
      if (ref.current) ref.current.textContent = message;
    }, 50);
    return () => clearTimeout(id);
  }, [message]);

  return (
    <div
      ref={ref}
      role="status"
      aria-live={politeness}
      aria-atomic="true"
      aria-label={label}
      // Visually hidden but reachable by AT.
      style={{
        position: "absolute",
        width: "1px",
        height: "1px",
        padding: 0,
        margin: "-1px",
        overflow: "hidden",
        clip: "rect(0,0,0,0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    />
  );
}

// ── Composite: both regions from one component ────────────────────────────────

interface HudLiveRegionsProps {
  /** Latest polite announcement (phase changes, non-critical gates, subtask status). */
  politeMessage: string;
  /** Latest assertive announcement (critical gate escalations only). Empty string = no announcement. */
  assertiveMessage: string;
}

/**
 * HudLiveRegions mounts both live regions.
 * Callers pass the latest message; switching from "" to a real string triggers the read-out.
 * assertiveMessage must only be populated for severity:"critical" events.
 */
export function HudLiveRegions({ politeMessage, assertiveMessage }: HudLiveRegionsProps) {
  return (
    <>
      <LiveRegion
        politeness="polite"
        message={politeMessage}
        label="Pipeline status updates"
      />
      <LiveRegion
        politeness="assertive"
        message={assertiveMessage}
        label="Critical gate escalations"
      />
    </>
  );
}

// ponytail: merge LiveRegion into a proper announcer queue when rapid phase
// changes could drop messages; add when a11y audit flags missed announcements.
