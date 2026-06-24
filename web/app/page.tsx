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
      <main
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "calc(var(--space-unit) * 6)",
          // emissive indigo→violet glow over the cool near-black void
          background:
            "radial-gradient(120% 90% at 50% -10%, var(--accent-dim-fill) 0%, transparent 55%), var(--bg)",
        }}
      >
        <section
          aria-label="Start a run"
          style={{
            width: "min(560px, 100%)",
            padding: "calc(var(--space-unit) * 8)",
            borderRadius: 14,
            backgroundColor: "var(--glass-tint)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            border: "1px solid hsla(258, 40%, 50%, 0.28)",
            boxShadow:
              "0 0 0 1px hsla(258,45%,30%,0.18), 0 24px 80px -24px hsla(264,82%,40%,0.45)",
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--text)",
            }}
          >
            Umbrella
          </h1>
          <p
            style={{
              margin: "calc(var(--space-unit) * 2) 0 calc(var(--space-unit) * 6)",
              color: "var(--text-dim)",
              fontSize: 13,
            }}
          >
            HARNESS four-phase agent build pipeline.
          </p>

          <label
            htmlFor="brief"
            style={{
              display: "block",
              marginBottom: "calc(var(--space-unit) * 2)",
              color: "var(--text-dim)",
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Task brief
          </label>
          <textarea
            id="brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="What should the harness build?"
            style={{
              width: "100%",
              resize: "vertical",
              padding: "calc(var(--space-unit) * 3)",
              borderRadius: 8,
              background: "var(--surface-1)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              outline: "none",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "var(--accent-mid)";
              e.currentTarget.style.boxShadow = "0 0 0 3px hsla(260,60%,50%,0.22)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />

          <button
            onClick={startRun}
            type="button"
            disabled={starting}
            style={{
              marginTop: "calc(var(--space-unit) * 5)",
              width: "100%",
              padding: "calc(var(--space-unit) * 3)",
              borderRadius: 8,
              cursor: starting ? "default" : "pointer",
              border: "1px solid var(--accent-mid)",
              background: starting
                ? "var(--accent-dim-fill)"
                : "linear-gradient(180deg, hsl(260,60%,50%) 0%, hsl(264,70%,42%) 100%)",
              color: starting ? "var(--text-dim)" : "hsl(0,0%,100%)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: "0.01em",
              opacity: starting ? 0.7 : 1,
              transition: "filter 160ms ease-out, opacity 160ms ease-out",
            }}
            onMouseEnter={(e) => {
              if (!starting) e.currentTarget.style.filter = "brightness(1.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = "none";
            }}
          >
            {starting ? "Starting…" : "Start run"}
          </button>
          {error && (
            <p
              role="alert"
              style={{
                marginTop: "calc(var(--space-unit) * 3)",
                marginBottom: 0,
                color: "var(--status-crit-text)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
              }}
            >
              {error}
            </p>
          )}
        </section>
      </main>
    );
  }

  return (
    <main
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
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
