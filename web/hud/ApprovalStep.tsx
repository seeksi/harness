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
      <button type="button" data-testid="approval-confirm" disabled={busy} onClick={approve}>
        {busy ? "Submitting…" : `Approve ${kind}`}
      </button>
      {result && (
        <p data-testid="approval-result" role="status" style={{ marginTop: 6, fontSize: 12 }}>
          {result}
        </p>
      )}
    </div>
  );
}
