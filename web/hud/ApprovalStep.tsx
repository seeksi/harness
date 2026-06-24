// web/hud/ApprovalStep.tsx — Lane C.
// Inline approval. POSTs to the CSRF-guarded approve route with the custom header.
// promote-to-main returns preview-only in this increment; the result line reflects
// that honestly (no mutation claimed).
"use client";

import { useState } from "react";

type ApprovalKind = "decompose-split" | "promote-to-main";

export function ApprovalStep({
  runId,
  kind,
  onDone,
}: {
  runId: string;
  kind: ApprovalKind;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Umbrella-Request": "1" },
        body: JSON.stringify({ kind }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        preview?: boolean;
      };
      if (!res.ok) setResult(data.error ?? `failed (${res.status})`);
      else setResult(data.preview ? "Preview only — no git mutation" : "Approved");
    } catch {
      setResult("request failed");
    } finally {
      setBusy(false);
      onDone?.();
    }
  }

  return (
    <div data-testid="approval-step" style={{ marginTop: 8 }}>
      <button
        type="button"
        data-testid="approval-confirm"
        disabled={busy}
        onClick={approve}
        style={{
          cursor: busy ? "default" : "pointer",
          padding: "6px 14px",
          borderRadius: 6,
          border: "1px solid var(--accent-mid)",
          background: busy
            ? "var(--accent-dim-fill)"
            : "linear-gradient(180deg, hsl(260,60%,50%) 0%, hsl(264,70%,42%) 100%)",
          color: busy ? "var(--text-dim)" : "hsl(0,0%,100%)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 600,
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? "Submitting…" : `Approve ${kind}`}
      </button>
      {result && (
        <p
          data-testid="approval-result"
          role="status"
          style={{
            marginTop: 6,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: "var(--status-info-text)",
          }}
        >
          {result}
        </p>
      )}
    </div>
  );
}
