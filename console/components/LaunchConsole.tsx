// console/components/LaunchConsole.tsx
// The one real form (§5). Deliberate, structured launch: project picker (from
// discovery) + REQUIRED non-empty brief + OPTIONAL model-routing override → commit.
// Inline validation, plain/technical error copy (no apology theater). The commit
// hands a validated payload up; wiring the real harness.sh spawn is Batch B+.
"use client";

import { useEffect, useRef, useState } from "react";

export interface LaunchPayload {
  projectId: string;
  projectName: string;
  brief: string;
  modelRouting: string; // "auto" | "haiku" | "sonnet" | "opus"
  decompose?: boolean; // ask the server to split the brief into disjoint lanes. Default OFF.
}
export interface LaunchProject {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  projects: LaunchProject[];
  onClose: () => void;
  onLaunch: (p: LaunchPayload) => void;
}

// Pure so it's unit-testable without a DOM (mirrors laneNowSec's pattern in
// RunLane.tsx). `decompose` is only present on the payload when true — omitted
// (not `false`) when off, matching the type's `?: boolean` default-OFF contract.
export function buildLaunchPayload(
  projectId: string,
  projects: LaunchProject[],
  brief: string,
  modelRouting: string,
  decompose: boolean
): LaunchPayload {
  const proj = projects.find((p) => p.id === projectId);
  return {
    projectId,
    projectName: proj?.name ?? projectId,
    brief: brief.trim(),
    modelRouting,
    ...(decompose ? { decompose: true } : {}),
  };
}

export function LaunchConsole({ open, projects, onClose, onLaunch }: Props) {
  const [projectId, setProjectId] = useState("");
  const [brief, setBrief] = useState("");
  const [routing, setRouting] = useState("auto");
  const [decompose, setDecompose] = useState(false);
  const [touched, setTouched] = useState(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setTouched(false);
      setDecompose(false); // a canceled "split" choice must not survive close→reopen
      setTimeout(() => briefRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const briefErr = !brief.trim() ? "Brief is required." : null;
  const projectErr = !projectId ? "Pick a project." : null;
  const valid = !briefErr && !projectErr;

  function submit() {
    setTouched(true);
    if (!valid) return;
    onLaunch(buildLaunchPayload(projectId, projects, brief, routing, decompose));
    setBrief("");
    setProjectId("");
    setRouting("auto");
    setDecompose(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Launch console"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.6)", zIndex: 50, padding: 16 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ width: "min(560px, 100%)", padding: 22, borderRadius: 12, background: "var(--surface-2)", border: "1px solid var(--amber-line)" }}>
        <h2 className="display" style={{ margin: 0, fontSize: 20, color: "var(--amber)" }}>Launch console</h2>
        <p style={{ margin: "6px 0 18px", fontSize: 12, color: "var(--text-dim)" }}>Pick a project, write the brief. Model routing is optional.</p>

        <Field label="Project" error={touched ? projectErr : null}>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            style={inputStyle}
          >
            <option value="">— select project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Task brief" error={touched ? briefErr : null}>
          <textarea
            ref={briefRef}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="What should the harness build?"
            style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-sans)" }}
          />
        </Field>

        <Field label="Model routing (optional)">
          <select value={routing} onChange={(e) => setRouting(e.target.value)} style={inputStyle}>
            <option value="auto">auto (tier routed per lane)</option>
            <option value="haiku">force haiku</option>
            <option value="sonnet">force sonnet</option>
            <option value="opus">force opus</option>
          </select>
        </Field>

        <Field label="Decompose (optional)">
          <button
            type="button"
            onClick={() => setDecompose((v) => !v)}
            aria-pressed={decompose}
            aria-label={decompose ? "decompose into lanes: on" : "decompose into lanes: off"}
            title="Ask the server to split the brief into disjoint parallel lanes."
            className="mono"
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 12,
              cursor: "pointer",
              color: decompose ? "var(--amber)" : "var(--text-dim)",
              background: "var(--surface-1)",
              border: `1px solid ${decompose ? "var(--amber-line)" : "var(--border)"}`,
            }}
          >
            {decompose ? "◉ split into lanes" : "◯ single lane"}
          </button>
        </Field>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
          <button
            type="button"
            onClick={submit}
            style={{ ...ghostBtn, color: "var(--bg)", background: valid ? "var(--amber)" : "var(--amber-rest)", border: "1px solid var(--amber)", cursor: valid ? "pointer" : "not-allowed", opacity: valid ? 1 : 0.7 }}
          >
            Commit — start run
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", marginBottom: 5, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-dim)" }}>{label}</label>
      {children}
      {error && <div role="alert" className="mono" style={{ marginTop: 4, fontSize: 11, color: "var(--fail)" }}>{error}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: 10,
  borderRadius: 6,
  background: "var(--surface-1)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  outline: "none",
  fontSize: 13,
};
const ghostBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  color: "var(--text)",
  background: "transparent",
  border: "1px solid var(--border-bright)",
};
