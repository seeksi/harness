// web/app/page.tsx — Lane C sole writer.
// The two-state screen: idle submit ⇄ running pipeline.
//
// Running state mounts BOTH projections of the one store — the 3D <Canvas>
// (Lane B) and the semantic HUD (Lane C) — off the single RunStore created by
// the runtime composition root (useRunSession). A run is started server-side via
// POST /api/runs (CSRF-guarded); the returned id opens the SSE stream that feeds
// store.apply(), and the rAF flush (inside useRunSession) is the only notifier.
//
// app/** may not import the store implementation directly (eslint import-boundary);
// it reaches the store only through @/runtime/useRunSession. The scene is loaded
// via a client-only dynamic import (r3f needs the DOM; no SSR).
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { HudShell } from "@/hud/HudShell";
import { useRunSession } from "@/runtime/useRunSession";

// Client-only: r3f <Canvas> must not server-render.
const SceneCanvas = dynamic(() => import("@/scene/Canvas").then((m) => m.Canvas), {
  ssr: false,
});

export default function Page() {
  const [runId, setRunId] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One store for the whole session; the SSE stream drives it once runId is set.
  const store = useRunSession(runId);

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Umbrella-Request": "1", // CSRF custom-header guard (same-origin, no CORS)
        },
        body: JSON.stringify({ brief: brief.trim() || "Dry run" }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `start failed (${res.status})`);
      }
      const { id } = (await res.json()) as { id: string };
      setRunId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "start failed");
    } finally {
      setStarting(false);
    }
  }

  if (!runId) {
    return (
      <main>
        <h1>Umbrella — idle</h1>
        <p>Harness four-phase agent build pipeline.</p>
        <label htmlFor="brief">Task brief</label>
        <textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="What should the harness build?"
        />
        <button onClick={startRun} type="button" disabled={starting}>
          {starting ? "Starting…" : "Start run"}
        </button>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main>
      {/* Both pure projections of the same store, fed by the rAF flush. */}
      <SceneCanvas store={store} />
      <HudShell store={store} />
      {/*
        ponytail: glass HUD overlays (InboxRail, ⌘K, ApprovalStep, TraceDrawer,
        toast) — add with the glass/shadcn polish increment.
      */}
    </main>
  );
}
