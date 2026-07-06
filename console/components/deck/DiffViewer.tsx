// console/components/deck/DiffViewer.tsx
// Per-worktree-commit diff viewer — read-only `git show` via the server route
// (§5/§6). Project is picked from the discovered registry (never free-typed — the
// server independently re-validates it against the same list, see api/diff/route.ts);
// the commit-ish is free text but the server rejects anything flag-shaped.
"use client";

import { useCallback, useState } from "react";
import { SectionTitle } from "./SectionTitle";

interface Project {
  id: string;
  name: string;
}

export function DiffViewer({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [sha, setSha] = useState("HEAD");
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback(async () => {
    if (!projectId || !sha) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/deck/api/diff?project=${encodeURIComponent(projectId)}&sha=${encodeURIComponent(sha)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setDiff(body.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : "diff failed");
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, sha]);

  return (
    <section aria-label="worktree commit diff" style={{ marginTop: 22 }}>
      <SectionTitle>Diff viewer — git show (read-only)</SectionTitle>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mono" style={inputStyle} aria-label="project">
          {projects.length === 0 && <option value="">no discovered projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          value={sha}
          onChange={(e) => setSha(e.target.value)}
          placeholder="commit sha / ref"
          aria-label="commit-ish"
          className="mono"
          style={{ ...inputStyle, minWidth: 160 }}
        />
        <button type="button" onClick={show} disabled={!projectId || !sha || loading} className="mono" style={pillBtn}>
          {loading ? "loading…" : "show"}
        </button>
      </div>
      {error && <div role="alert" style={{ color: "var(--fail)", fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {diff !== null && (
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 12,
            fontSize: 11,
            lineHeight: 1.5,
            maxHeight: 320,
            overflow: "auto",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--surface-1)",
            whiteSpace: "pre-wrap",
          }}
        >
          {diff.split("\n").map((line, i) => (
            <div key={i} style={{ color: line.startsWith("+") ? "var(--live)" : line.startsWith("-") ? "var(--fail)" : "var(--text-dim)" }}>
              {line || " "}
            </div>
          ))}
        </pre>
      )}
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text)",
  background: "var(--surface-2)",
  border: "1px solid var(--border-bright)",
};
const pillBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  color: "var(--text)",
  background: "var(--surface-2)",
  border: "1px solid var(--border-bright)",
};
