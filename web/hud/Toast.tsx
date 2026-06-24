// web/hud/Toast.tsx — Lane C.
// Non-blocking toast. Used by the "open detail is sacred" rule: when a gate is
// queued behind an open detail, a toast is offered on close. role="status" so it
// is announced politely, never interrupting.
"use client";

import { glassSurface } from "./glass";

export function Toast({
  message,
  actionLabel = "Open",
  onAction,
  onDismiss,
}: {
  message: string | null;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="status"
      data-testid="toast"
      style={{
        ...glassSurface(),
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: "8px 12px",
        borderRadius: 8,
        zIndex: 40,
      }}
    >
      <span>{message}</span>
      {onAction && (
        <button type="button" data-testid="toast-action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      <button type="button" aria-label="Dismiss" data-testid="toast-dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
