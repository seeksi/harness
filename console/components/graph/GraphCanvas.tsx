// console/components/graph/GraphCanvas.tsx
// The rendering surface. A single <canvas>, drawn via rAF (live) or on-demand
// (prefers-reduced-motion) — never per-tick React re-renders (§3, binding). Pan
// (drag) + zoom (wheel, centered on cursor) + touch pinch via raw Pointer Events so
// mouse and touch share one code path. Node click hit-tests in world space and
// reports up; the inspector panel itself is DOM, owned by GraphView.
"use client";

import { useEffect, useMemo, useRef } from "react";
import type { GraphEdge, GraphNode, Point } from "./model";

// Mirrors app/globals.css tokens (§3 CRT palette) — canvas fillStyle can't read CSS
// custom properties, so these are the same values restated as literals. Keep in
// sync if the palette in globals.css ever changes.
const COLOR = {
  bg: "hsl(40, 7%, 7%)",
  surface1: "hsl(40, 7%, 10%)",
  border: "hsl(40, 6%, 20%)",
  amber: "hsl(40, 96%, 62%)",
  amberBright: "hsl(42, 100%, 68%)",
  amberRest: "hsl(40, 55%, 55%)",
  amberFill: "hsla(40, 96%, 62%, 0.14)",
  live: "hsl(142, 58%, 62%)",
  liveFill: "hsla(142, 58%, 50%, 0.16)",
  text: "hsl(40, 10%, 92%)",
  textFaint: "hsl(40, 6%, 50%)",
};

const MIN_SCALE = 0.3;
const MAX_SCALE = 3.5;
const CLICK_SLOP_PX = 6;

interface Transform {
  x: number;
  y: number;
  scale: number;
}

function nodeRadius(n: GraphNode): number {
  if (n.kind === "group") return Math.min(30, 15 + 2 * Math.sqrt(n.memberCount));
  return n.activity === "active" ? 11 : 9;
}

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Map<string, Point>;
  reducedMotion: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  // Bumped by the parent whenever a phase completes anywhere in the project — the
  // canvas fires one quiet punctuation ring off it (§3: "phase-transition punctuation").
  punctuationSeq: number;
}

export function GraphCanvas({ nodes, edges, layout, reducedMotion, selectedId, onSelect, punctuationSeq }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ startScreen: Point; moved: number; pinchStartDist: number } | null>(null);
  const punctuationStartRef = useRef<number | null>(null);
  const lastSeqRef = useRef(punctuationSeq);
  const rafRef = useRef(0);

  // Fresh-each-render props/data captured in a ref so the (stable) rAF/draw closure
  // never goes stale without needing to restart the loop or re-bind listeners.
  const liveRef = useRef({ nodes, edges, layout, selectedId, reducedMotion });
  liveRef.current = { nodes, edges, layout, selectedId, reducedMotion };

  const draw = useMemo(
    () =>
      function draw(tMs: number) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const { w, h, dpr } = sizeRef.current;
        if (w === 0 || h === 0) return;
        const { nodes: ns, edges: es, layout: lay, selectedId: sel, reducedMotion: rm } = liveRef.current;
        const t = transformRef.current;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = COLOR.bg;
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.scale(t.scale, t.scale);

        // edges — quiet functional lines; brighter/thicker while the handoff is hot.
        for (const e of es) {
          const a = lay.get(e.from);
          const b = lay.get(e.to);
          if (!a || !b) continue;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = COLOR.border;
          ctx.lineWidth = Math.min(3, 1 + Math.log2(1 + e.weight));
          ctx.stroke();
        }

        // nodes
        for (const n of ns) {
          const p = lay.get(n.id);
          if (!p) continue;
          const r = nodeRadius(n);
          const pulsing = !rm && n.activity === "active";
          const breathe = pulsing ? 0.5 + 0.5 * Math.sin(tMs / 420 + hashPhase(n.id)) : 0;
          const drawR = r + (pulsing ? breathe * 4 : 0);

          if (pulsing) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, drawR + 6, 0, Math.PI * 2);
            ctx.fillStyle = COLOR.amberFill;
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(p.x, p.y, drawR, 0, Math.PI * 2);
          ctx.fillStyle =
            n.kind === "group"
              ? COLOR.surface1
              : n.activity === "active"
                ? COLOR.amber
                : n.activity === "recent"
                  ? COLOR.amberRest
                  : COLOR.surface1;
          ctx.fill();
          ctx.lineWidth = n.id === sel ? 2.5 : 1.25;
          ctx.strokeStyle = n.id === sel ? COLOR.amberBright : n.kind === "group" ? COLOR.border : COLOR.amberRest;
          ctx.stroke();

          // label — only at a legible zoom level, keeps the swarm view uncluttered.
          if (t.scale >= 0.55) {
            ctx.fillStyle = n.activity === "active" ? COLOR.amberBright : COLOR.textFaint;
            ctx.font = "10px var(--font-mono, monospace)";
            ctx.textAlign = "center";
            ctx.fillText(n.label, p.x, p.y + r + 12);
          }
        }

        // phase-transition punctuation — one quiet expanding ring, ~600ms, green
        // (healthy-progress signal only — §3 role reservation).
        if (!rm && punctuationStartRef.current !== null) {
          const age = tMs - punctuationStartRef.current;
          const dur = 600;
          if (age >= 0 && age <= dur) {
            const k = age / dur;
            const cx = w / 2 / t.scale - t.x / t.scale;
            const cy = h / 2 / t.scale - t.y / t.scale;
            ctx.beginPath();
            ctx.arc(cx, cy, 20 + k * Math.max(w, h) * 0.5, 0, Math.PI * 2);
            ctx.strokeStyle = COLOR.live;
            ctx.globalAlpha = 1 - k;
            ctx.lineWidth = 3;
            ctx.stroke();
            ctx.globalAlpha = 1;
          } else if (age > dur) {
            punctuationStartRef.current = null;
          }
        }

        ctx.restore();
      },
    []
  );

  const scheduleDraw = useMemo(
    () => () => {
      if (liveRef.current.reducedMotion) draw(performance.now());
      // else: the running rAF loop will pick up the change next frame — no-op.
    },
    [draw]
  );

  // resize — track container box in device pixels for crisp canvas rendering.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w: box.width, h: box.height, dpr };
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      scheduleDraw();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  // punctuation trigger — a prop bump starts a fresh ring.
  useEffect(() => {
    if (punctuationSeq !== lastSeqRef.current) {
      lastSeqRef.current = punctuationSeq;
      if (!reducedMotion) punctuationStartRef.current = performance.now();
    }
  }, [punctuationSeq, reducedMotion]);

  // rAF loop (skipped under reduced-motion — draw-on-change instead, see scheduleDraw).
  useEffect(() => {
    if (reducedMotion) {
      draw(0);
      return;
    }
    const loop = (tMs: number) => {
      draw(tMs);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [reducedMotion, draw]);

  // redraw immediately when data/selection changes under reduced-motion (no loop
  // running to pick it up on its own).
  useEffect(() => {
    scheduleDraw();
  }, [nodes, edges, layout, selectedId, scheduleDraw]);

  // --- pan / zoom / click — Pointer Events unify mouse + touch (incl. pinch) -----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const screenToWorld = (sx: number, sy: number): Point => {
      const t = transformRef.current;
      return { x: (sx - t.x) / t.scale, y: (sy - t.y) / t.scale };
    };

    const zoomAt = (sx: number, sy: number, factor: number) => {
      const t = transformRef.current;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
      const w = screenToWorld(sx, sy);
      t.scale = newScale;
      t.x = sx - w.x * newScale;
      t.y = sy - w.y * newScale;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.001);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
      scheduleDraw();
    };

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      pointersRef.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (pointersRef.current.size === 1) {
        dragRef.current = { startScreen: { x: e.clientX - rect.left, y: e.clientY - rect.top }, moved: 0, pinchStartDist: 0 };
      } else if (pointersRef.current.size === 2) {
        const pts = [...pointersRef.current.values()];
        dragRef.current = {
          startScreen: dragRef.current?.startScreen ?? pts[0],
          moved: (dragRef.current?.moved ?? 0) + 999, // 2-finger gesture is never a "click"
          pinchStartDist: dist(pts[0], pts[1]),
        };
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      const rect = canvas.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const prev = pointersRef.current.get(e.pointerId)!;
      pointersRef.current.set(e.pointerId, p);

      const pts = [...pointersRef.current.values()];
      if (pts.length === 1) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const t = transformRef.current;
        t.x += dx;
        t.y += dy;
        if (dragRef.current) dragRef.current.moved += Math.hypot(dx, dy);
        scheduleDraw();
      } else if (pts.length >= 2) {
        const d = dist(pts[0], pts[1]);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const start = dragRef.current;
        if (start && start.pinchStartDist > 0) {
          zoomAt(mid.x, mid.y, d / start.pinchStartDist);
          dragRef.current = { ...start, pinchStartDist: d };
        }
        scheduleDraw();
      }
    };

    const finishPointer = (e: PointerEvent) => {
      const wasSingleTap = pointersRef.current.size === 1 && (dragRef.current?.moved ?? Infinity) < CLICK_SLOP_PX;
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size === 0) {
        if (wasSingleTap) {
          const rect = canvas.getBoundingClientRect();
          const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          const hit = hitTest(liveRef.current.nodes, liveRef.current.layout, world);
          onSelect(hit);
        }
        dragRef.current = null;
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", finishPointer);
    canvas.addEventListener("pointercancel", finishPointer);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", finishPointer);
      canvas.removeEventListener("pointercancel", finishPointer);
    };
  }, [onSelect, scheduleDraw]);

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%", minHeight: 420, borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)", background: "var(--bg)" }}>
      <canvas ref={canvasRef} style={{ display: "block", touchAction: "none", cursor: "grab" }} role="img" aria-label="agent workflow graph" />
    </div>
  );
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hashPhase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

function hitTest(nodes: GraphNode[], layout: Map<string, Point>, world: Point): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const p = layout.get(n.id);
    if (!p) continue;
    const r = nodeRadius(n) + 6; // small hit-padding
    const d = dist(p, world);
    if (d <= r && d < bestDist) {
      best = n.id;
      bestDist = d;
    }
  }
  return best;
}

