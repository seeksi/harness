// console/components/run/LiveFeed.tsx
// Streaming agent/tool events, newest at bottom, auto-follow w/ scroll-lock-on-
// touch, virtualized (§5). Per-line: timestamp (mono), agent, event, cost tick.
"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { RunState, TraceTick } from "@/lib/contract/types";
import { fmtClock, fmtUsd } from "@/lib/format";
import { computeWindow, isNearBottom } from "./virtualize";

const ITEM_H = 22;
const VIEWPORT_H = 320;

// Best-effort per-line cost tick: the lane's cumulative cost as currently known.
// ponytail: trace events don't carry a cost themselves (contract has no per-tick
// $ delta), so this reads the lane's latest reported usage rather than a true
// historical snapshot at that tick. Upgrade when usage payloads carry a tick ref.
function costTickFor(run: RunState, tick: TraceTick): string | null {
  const lane = tick.laneId ? run.usage.lanes[tick.laneId] : undefined;
  if (!lane) return null;
  return fmtUsd(lane.costUsd);
}

export function LiveFeed({ run }: { run: RunState }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trace = run.trace;
  const total = trace.length;

  // Default state simulates "scrolled to bottom" so SSR/first paint shows the
  // tail of the feed (the freshest lines) without waiting for a scroll measurement.
  const [scrollTop, setScrollTop] = useState(() => Math.max(0, total * ITEM_H - VIEWPORT_H));
  const [autoFollow, setAutoFollow] = useState(true);

  // New lines arrived: if the operator was following the tail, keep following it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (autoFollow) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [total, autoFollow]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // Scroll-lock-on-touch: moving away from the bottom releases auto-follow;
    // scrolling back down near the bottom re-engages it.
    setAutoFollow(isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
  }

  const win = computeWindow(total, ITEM_H, scrollTop, VIEWPORT_H);
  const visible = trace.slice(win.start, win.end);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", justifyContent: "space-between" }}>
        <span>Live feed</span>
        <span>{autoFollow ? "auto-follow" : "scroll-locked"} · {total} events</span>
      </div>
      <div
        ref={containerRef}
        role="log"
        aria-label="live feed"
        aria-live="polite"
        onScroll={onScroll}
        style={{
          height: VIEWPORT_H,
          overflowY: "auto",
          borderRadius: 6,
          background: "var(--surface-1)",
          border: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {total === 0 ? (
          <div style={{ padding: 12, fontSize: 12, color: "var(--text-faint)" }}>no events yet</div>
        ) : (
          <div style={{ paddingTop: win.topPad, paddingBottom: win.bottomPad }}>
            {visible.map((t, i) => (
              <FeedLine key={win.start + i} tick={t} cost={costTickFor(run, t)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedLine({ tick, cost }: { tick: TraceTick; cost: string | null }) {
  return (
    <div
      className="feed-line"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "baseline",
        height: ITEM_H,
        padding: "0 10px",
        fontSize: 11,
        color: "var(--text-dim)",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      <span style={{ color: "var(--text-faint)" }}>{fmtClock(tick.ts * 1000)}</span>
      <span style={{ color: "var(--amber)" }}>{tick.agentId}</span>
      <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }}>
        {tick.tool} <span style={{ color: "var(--text-faint)" }}>{tick.sig}</span>
      </span>
      {cost && <span style={{ marginLeft: "auto", color: "var(--text-faint)", flexShrink: 0 }}>{cost}</span>}
    </div>
  );
}
