// console/components/run/virtualize.ts
// Pure windowing math for the live feed (§5 "virtualized"). Fixed row height,
// scrollTop-driven window + overscan, padded with spacer heights so scrollHeight
// stays correct without rendering every off-screen row. No dependency added —
// the feed is a plain list, this is the one calc that keeps its DOM bounded.

export interface FeedWindow {
  start: number; // first rendered index (inclusive)
  end: number; // last rendered index (exclusive)
  topPad: number; // px spacer above the rendered slice
  bottomPad: number; // px spacer below the rendered slice
}

export function computeWindow(total: number, itemH: number, scrollTop: number, viewportH: number, overscan = 6): FeedWindow {
  if (total <= 0 || itemH <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const visibleCount = Math.max(1, Math.ceil(viewportH / itemH)) + overscan * 2;
  const rawStart = Math.floor(scrollTop / itemH) - overscan;
  const start = Math.min(Math.max(0, rawStart), Math.max(0, total - visibleCount));
  const end = Math.min(total, start + visibleCount);
  return { start, end, topPad: start * itemH, bottomPad: (total - end) * itemH };
}

// Auto-follow / scroll-lock: true while the viewport is close enough to the bottom
// that new lines should keep pulling it down; false once the operator scrolls away
// (touch or wheel) — the lock releases auto-follow until they scroll back down.
export function isNearBottom(scrollTop: number, viewportH: number, contentH: number, thresholdPx = 48): boolean {
  return contentH - (scrollTop + viewportH) <= thresholdPx;
}
