// console/components/deck/DeckExplorer.tsx
// Observability deck — the analyst-dense deep-dive layer (§4/§5/§6). Trace forensics
// explorer: searchable, filtered (run/lane/agent/event type), virtualized list; a
// tool-call detail pane with everything the current data sources actually carry
// (never fabricated args/outputs — see NOTES.tracehook.md, the hook line format is
// frozen at {ts, tool, sig}). Deep-linkable via ?run=; SSR renders the fixture-folded
// state so `curl /deck` sees real rows, then the SSE stream + rAF store take over for
// the kinetic live view — same discipline as FleetHome. Loading a raw
// .claude/traces/<session>.jsonl file (RawSessionPanel) merges its lines into this
// same searchable/filterable event list as origin:"file" ToolCallEvents — that's what
// "full forensics searchable" means; they aren't stranded in their own panel.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { FleetState, RunState } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";
import { createFleetStore } from "@/lib/store/fleetStore";
import { createSseClient, type ConnectionStatus } from "@/lib/sse/client";
import { fmtTokens, fmtClock } from "@/lib/format";
import { deriveStoreEvents, deriveFileEvents, filterEvents, facetValues, sortByTs } from "@/app/deck/lib/filters";
import type { DeckFilters, ToolCallEvent } from "@/app/deck/lib/types";
import type { RawTraceLine } from "@/app/deck/lib/traceFile";
import { DeckCharts } from "./DeckCharts";
import { EvalPanel } from "./EvalPanel";
import { DiffViewer } from "./DiffViewer";
import { SectionTitle } from "./SectionTitle";

const ROW_H = 26; // px — the virtualized list's fixed row height
const LIST_H = 420; // px — the scrolling viewport height

export interface DeckProject {
  id: string;
  name: string;
}

interface Props {
  initial: FleetState;
  envelopes: Envelope[]; // SSR snapshot, ordered — feeds the burn-over-time chart
  projects: DeckProject[];
  sessions: string[];
  initialRunFilter?: string;
}

export function DeckExplorer({ initial, envelopes, projects, sessions, initialRunFilter }: Props) {
  const storeRef = useRef(createFleetStore(initial));
  const store = storeRef.current;
  const getServer = useCallback(() => initial, [initial]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, getServer);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEventMs, setLastEventMs] = useState<number>(Date.now());
  const router = useRouter();

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      store.flush();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  useEffect(() => {
    const client = createSseClient({ url: "/api/fleet/stream", store, onStatusChange: setStatus, onEventTime: setLastEventMs });
    return () => client.destroy();
  }, [store]);

  const [filters, setFilters] = useState<DeckFilters>({ runId: initialRunFilter });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A loaded raw session file (RawSessionPanel) is merged in here as origin:"file"
  // events so it's searchable/filterable in the same forensics floor as store events —
  // "full forensics searchable" per §6, not stranded in its own unpaginated panel.
  const [fileEvents, setFileEvents] = useState<ToolCallEvent[]>([]);
  const onSessionLoaded = useCallback((sessionId: string, lines: RawTraceLine[]) => {
    setFileEvents(deriveFileEvents(sessionId, lines));
  }, []);
  const onSessionClear = useCallback(() => setFileEvents([]), []);

  const setRunFilter = useCallback(
    (runId: string | undefined) => {
      setFilters((f) => ({ ...f, runId, laneId: undefined, agentId: undefined }));
      router.replace(runId ? `/deck?run=${encodeURIComponent(runId)}` : "/deck", { scroll: false });
    },
    [router]
  );

  const runs = useMemo(() => state.order.map((id) => state.runs[id]).filter(Boolean), [state]);
  const allEvents = useMemo(() => [...deriveStoreEvents(state), ...fileEvents], [state, fileEvents]);
  const runScoped = useMemo(
    () => (filters.runId ? allEvents.filter((e) => e.runId === filters.runId) : allEvents),
    [allEvents, filters.runId]
  );
  const filtered = useMemo(() => sortByTs(filterEvents(allEvents, filters), "desc"), [allEvents, filters]);
  const selected = useMemo(() => filtered.find((e) => e.id === selectedId) ?? null, [filtered, selectedId]);

  const selectedRun: RunState | undefined = filters.runId ? state.runs[filters.runId] : undefined;
  const feedStale = status === "reconnecting" || status === "closed";

  return (
    <main className="console-shell">
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <a href="/" className="mono" style={{ color: "var(--text-faint)", textDecoration: "none", fontSize: 11 }}>
            ← fleet
          </a>
          <span className="display" style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)", letterSpacing: "0.04em" }}>
            OBSERVABILITY DECK
          </span>
        </div>
        <ConnectionPill status={status} lastEventMs={lastEventMs} />
      </header>

      <RunChips runs={runs} activeRunId={filters.runId} onSelect={setRunFilter} />

      <FilterBar events={runScoped} filters={filters} onChange={setFilters} />

      <div className="deck-grid" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, marginTop: 12 }}>
        <TraceList events={filtered} selectedId={selectedId} onSelect={setSelectedId} />
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <DetailPane event={selected} />
          {selectedRun && <EvalPanel run={selectedRun} />}
        </div>
      </div>

      <DeckCharts envelopes={envelopes} runs={runs} selectedRun={selectedRun} />

      <DiffViewer projects={projects} />

      <RawSessionPanel sessions={sessions} onLoaded={onSessionLoaded} onClear={onSessionClear} />

      <style>{`
        @media (max-width: 1024px) {
          .deck-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </main>
  );
}

function ConnectionPill({ status, lastEventMs }: { status: ConnectionStatus; lastEventMs: number }) {
  // Green (`--live`) is reserved for the actually-live/healthy state — "connecting"
  // hasn't opened yet, so it gets the idle amber tone, not the live-signal green.
  if (status === "open") {
    return <span className="mono breathe" style={{ fontSize: 11, color: "var(--live)" }}>● live</span>;
  }
  if (status === "connecting") {
    return <span className="mono pulse" style={{ fontSize: 11, color: "var(--amber-rest)" }}>◐ connecting</span>;
  }
  if (status === "reconnecting") {
    return <span className="mono pulse" style={{ fontSize: 11, color: "var(--amber)" }}>◐ reconnecting · data as of {fmtClock(lastEventMs)}</span>;
  }
  return <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>○ closed · data as of {fmtClock(lastEventMs)}</span>;
}

function RunChips({ runs, activeRunId, onSelect }: { runs: RunState[]; activeRunId?: string; onSelect: (id: string | undefined) => void }) {
  return (
    <div role="tablist" aria-label="filter by run" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "4px 0 12px" }}>
      <Chip label="All runs" active={!activeRunId} onClick={() => onSelect(undefined)} />
      {runs.map((r) => (
        <Chip key={r.runId} label={`${r.projectName} · ${fmtTokens(r.usage.totalTokens)}tok`} active={activeRunId === r.runId} onClick={() => onSelect(r.runId)} />
      ))}
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="mono"
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        cursor: "pointer",
        color: active ? "var(--bg)" : "var(--text-dim)",
        background: active ? "var(--amber)" : "var(--surface-2)",
        border: `1px solid ${active ? "var(--amber)" : "var(--border-bright)"}`,
      }}
    >
      {label}
    </button>
  );
}

function FilterBar({ events, filters, onChange }: { events: ToolCallEvent[]; filters: DeckFilters; onChange: (f: DeckFilters) => void }) {
  const lanes = useMemo(() => facetValues(events, "laneId"), [events]);
  const agents = useMemo(() => facetValues(events, "agentId"), [events]);
  const tools = useMemo(() => facetValues(events, "tool"), [events]);
  const active = Boolean(filters.q || filters.laneId || filters.agentId || filters.tool);

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input
        value={filters.q ?? ""}
        onChange={(e) => onChange({ ...filters, q: e.target.value || undefined })}
        placeholder="search tool / sig / agent / lane…"
        aria-label="search trace forensics"
        className="mono"
        style={inputStyle}
      />
      <Select label="lane" value={filters.laneId} options={lanes} onChange={(v) => onChange({ ...filters, laneId: v })} />
      <Select label="agent" value={filters.agentId} options={agents} onChange={(v) => onChange({ ...filters, agentId: v })} />
      <Select label="event type" value={filters.tool} options={tools} onChange={(v) => onChange({ ...filters, tool: v })} />
      {active && (
        <button type="button" onClick={() => onChange({ runId: filters.runId })} className="mono" style={{ ...pillBtn, color: "var(--amber)" }}>
          clear filters
        </button>
      )}
    </div>
  );
}

function Select({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (v: string | undefined) => void }) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="mono"
      style={{ ...inputStyle, width: "auto", cursor: "pointer" }}
    >
      <option value="">{label}: any</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

// The trace-forensics floor: individual tool calls, virtualized so a multi-hour run's
// feed never grows the DOM unbounded (§6 performance budget).
function TraceList({ events, selectedId, onSelect }: { events: ToolCallEvent[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(events.length, 40) });

  useEffect(() => {
    const el = containerRef.current;
    const recompute = () => {
      if (!el) return;
      const start = Math.max(0, Math.floor(el.scrollTop / ROW_H) - 8);
      const visible = Math.ceil(LIST_H / ROW_H) + 16;
      setRange({ start, end: Math.min(events.length, start + visible) });
    };
    recompute();
    el?.addEventListener("scroll", recompute, { passive: true });
    return () => el?.removeEventListener("scroll", recompute);
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div style={{ padding: 16, borderRadius: 8, border: "1px dashed var(--border)", color: "var(--text-faint)", fontSize: 12 }}>
        no tool calls match these filters
      </div>
    );
  }

  const visible = events.slice(range.start, range.end);
  return (
    <div
      ref={containerRef}
      role="list"
      aria-label="trace forensics — tool calls"
      style={{
        height: LIST_H,
        overflowY: "auto",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        background: "var(--surface-1)",
        position: "relative",
      }}
    >
      <div style={{ height: events.length * ROW_H, position: "relative" }}>
        {visible.map((ev, i) => {
          const top = (range.start + i) * ROW_H;
          const isSelected = ev.id === selectedId;
          return (
            <button
              key={ev.id}
              type="button"
              role="listitem"
              onClick={() => onSelect(ev.id)}
              className="mono feed-line"
              style={{
                position: "absolute",
                top,
                left: 0,
                right: 0,
                height: ROW_H,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                fontSize: 11,
                textAlign: "left",
                cursor: "pointer",
                color: "var(--text)",
                background: isSelected ? "var(--surface-3)" : "transparent",
                border: "none",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ color: "var(--text-faint)", flexShrink: 0 }}>{fmtClock(ev.ts * 1000)}</span>
              <span style={{ color: "var(--amber-rest)", flexShrink: 0, minWidth: 60 }}>{ev.tool}</span>
              <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.sig}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-faint)", flexShrink: 0 }}>
                {ev.runId ?? "—"}
                {ev.laneId ? `/${ev.laneId}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DetailPane({ event }: { event: ToolCallEvent | RawTraceLine | null }) {
  if (!event) {
    return (
      <div style={{ padding: 14, borderRadius: "var(--radius)", border: "1px dashed var(--border)", color: "var(--text-faint)", fontSize: 12 }}>
        select a tool call to expand its detail
      </div>
    );
  }
  const isFull = "id" in event;
  return (
    <div role="region" aria-label="tool call detail" style={{ padding: 14, borderRadius: "var(--radius)", background: "var(--surface-1)", border: "1px solid var(--amber-line)" }}>
      <div className="mono" style={{ fontSize: 11, color: "var(--amber)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
        tool call detail
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", margin: 0, fontSize: 12 }}>
        <dt style={dtStyle}>time</dt>
        <dd className="mono" style={ddStyle}>{fmtClock(event.ts * 1000)} <span style={{ color: "var(--text-faint)" }}>({event.ts})</span></dd>
        <dt style={dtStyle}>tool</dt>
        <dd className="mono" style={ddStyle}>{event.tool}</dd>
        <dt style={dtStyle}>signature</dt>
        <dd className="mono" style={{ ...ddStyle, wordBreak: "break-all" }}>{event.sig}</dd>
        {isFull && (event as ToolCallEvent).runId && (
          <>
            <dt style={dtStyle}>run</dt>
            <dd className="mono" style={ddStyle}>{(event as ToolCallEvent).runId}</dd>
          </>
        )}
        {isFull && (event as ToolCallEvent).laneId && (
          <>
            <dt style={dtStyle}>lane</dt>
            <dd className="mono" style={ddStyle}>{(event as ToolCallEvent).laneId}</dd>
          </>
        )}
        {isFull && (event as ToolCallEvent).agentId && (
          <>
            <dt style={dtStyle}>agent</dt>
            <dd className="mono" style={ddStyle}>{(event as ToolCallEvent).agentId}</dd>
          </>
        )}
        {isFull && (event as ToolCallEvent).sessionId && (
          <>
            <dt style={dtStyle}>session</dt>
            <dd className="mono" style={ddStyle}>{(event as ToolCallEvent).sessionId}</dd>
          </>
        )}
      </dl>
      <div className="mono" style={{ marginTop: 10, fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
        args / output / duration: not captured — the PostToolUse hook logs only {"{ts, tool, sig}"} per call
        (see NOTES.tracehook.md; the line format is frozen). `sig` is a stable hash/label of the call&apos;s input.
      </div>
    </div>
  );
}

// A raw session file can be up to MAX_TRACE_BYTES (10MB, ~100k lines) — rendering
// every line as its own DOM node would freeze the tab. The full line set is always
// handed to `onLoaded` so it's merged into the (already-virtualized) TraceList above
// as searchable origin:"file" events; this panel's own inline preview is capped.
const RAW_PREVIEW_CAP = 300;

function RawSessionPanel({
  sessions,
  onLoaded,
  onClear,
}: {
  sessions: string[];
  onLoaded: (sessionId: string, lines: RawTraceLine[]) => void;
  onClear: () => void;
}) {
  const [session, setSession] = useState<string>("");
  const [lines, setLines] = useState<RawTraceLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string) => {
      if (!id) return;
      setLoading(true);
      setError(null);
      onClear();
      try {
        const res = await fetch(`/deck/api/traces?session=${encodeURIComponent(id)}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
        setLines(body.lines);
        onLoaded(id, body.lines);
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to load trace");
        setLines(null);
        onClear();
      } finally {
        setLoading(false);
      }
    },
    [onLoaded, onClear]
  );

  return (
    <section aria-label="raw hook traces" style={{ marginTop: 22 }}>
      <SectionTitle>Raw hook traces — .claude/traces/*.jsonl ({sessions.length} session{sessions.length === 1 ? "" : "s"})</SectionTitle>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <select value={session} onChange={(e) => setSession(e.target.value)} className="mono" style={{ ...inputStyle, width: "auto" }} aria-label="session id">
          <option value="">select a session…</option>
          {sessions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button type="button" onClick={() => load(session)} disabled={!session || loading} className="mono" style={pillBtn}>
          {loading ? "loading…" : "load"}
        </button>
      </div>
      {error && <div role="alert" style={{ color: "var(--fail)", fontSize: 12 }}>{error}</div>}
      {lines && (
        lines.length === 0 ? (
          <div style={{ color: "var(--text-faint)", fontSize: 12 }}>this session produced no tool calls</div>
        ) : (
          <>
            <div className="mono" style={{ fontSize: 11, maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
              {lines.slice(0, RAW_PREVIEW_CAP).map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 10, padding: "2px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ color: "var(--text-faint)" }}>{fmtClock(l.ts * 1000)}</span>
                  <span style={{ color: "var(--amber-rest)" }}>{l.tool}</span>
                  <span style={{ color: "var(--text-dim)" }}>{l.sig}</span>
                </div>
              ))}
            </div>
            {lines.length > RAW_PREVIEW_CAP && (
              <div className="mono" style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 6 }}>
                showing first {RAW_PREVIEW_CAP} of {lines.length} lines — the full session is merged into the trace
                forensics explorer above (searchable, filterable by event type)
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}

const dtStyle: React.CSSProperties = { color: "var(--text-faint)", fontWeight: 400 };
const ddStyle: React.CSSProperties = { margin: 0, color: "var(--text)" };
const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--text)",
  background: "var(--surface-2)",
  border: "1px solid var(--border-bright)",
  minWidth: 200,
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
