// console/lib/chime.ts
// Desk chime (§5/§6 alerting): a short Web-Audio synth tone fired client-side, from
// whichever tab is open, on the SAME edge-triggered alert conditions as the ntfy
// notifier — gate raised · run failed/stuck · run completed. `chimeKindsFor` reuses
// the shared, neutral `notificationsFor` (lib/contract/alerts.ts — no fs/
// child_process/env access, so it's safe in a client bundle) so the two channels
// can never drift out of sync on what counts as an alert. This file must never
// import lib/server/* directly — that's a Node-only boundary a client bundle can't
// cross; lib/contract/alerts.ts is the neutral module both sides share.
//
// No audio assets: three oscillator tones distinguished by pitch/duration. Mute is
// a user preference persisted in localStorage (MUTE_KEY); the FIRST-EVER default
// (no stored preference yet) respects `prefers-reduced-motion` (muted) per §5 a11y
// — once the operator flips the toggle, their explicit choice persists regardless
// of the media query.
import { useEffect, useRef, useState } from "react";
import type { FleetState } from "@/lib/contract/types";
import { notificationsFor, type NotifyKind } from "@/lib/contract/alerts";

const MUTE_KEY = "harness.chime.muted";

export function loadMutePref(storage: Pick<Storage, "getItem"> = window.localStorage): boolean | null {
  const v = storage.getItem(MUTE_KEY);
  return v === null ? null : v === "1";
}

export function saveMutePref(muted: boolean, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  storage.setItem(MUTE_KEY, muted ? "1" : "0");
}

export function prefersReducedMotion(
  mql: Pick<MediaQueryList, "matches"> = window.matchMedia("(prefers-reduced-motion: reduce)")
): boolean {
  return mql.matches;
}

/** Edge-triggered chime kinds for a fleet-state transition — same rule as the ntfy notifier. */
export function chimeKindsFor(before: FleetState | undefined, after: FleetState): NotifyKind[] {
  const out: NotifyKind[] = [];
  for (const runId of after.order) {
    const a = after.runs[runId];
    if (!a) continue;
    const b = before?.runs[runId];
    for (const n of notificationsFor(b, a)) out.push(n.kind);
  }
  return out;
}

const TONE: Record<NotifyKind, { freqs: number[]; dur: number }> = {
  "gate-raised": { freqs: [880], dur: 0.12 },
  "run-stuck": { freqs: [247, 185], dur: 0.22 },
  "run-failed": { freqs: [220, 165], dur: 0.24 },
  "run-completed": { freqs: [659, 880, 1319], dur: 0.09 },
};

let sharedCtx: AudioContext | null = null;

// A minimal structural type (not the full DOM `Window`) so a test double only
// needs to shape-match this, not the entire lib.dom.d.ts Window interface.
export interface AudioHost {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

// Acquire (or resume) the shared AudioContext. Browsers only let a context start
// truly running from within a real user-gesture call stack (autoplay policy) — so
// this is called both from the toggle's click handler (unlockChimeAudio, below)
// AND from playChime itself, which fires later from an async SSE event and just
// needs the already-unlocked context to still be usable.
function acquireCtx(win: AudioHost): AudioContext | null {
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) return null;
  const ctx = sharedCtx ?? (sharedCtx = new Ctor());
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Create/resume the shared AudioContext from within a user gesture (the unmute
 * click) so the browser's autoplay policy is satisfied before the first real
 * chime tries to play later, asynchronously, off an SSE event. No-op (never
 * throws) if Web Audio isn't available. */
export function unlockChimeAudio(win: AudioHost = window as unknown as AudioHost): void {
  acquireCtx(win);
}

/** Synthesize + play one chime. No-ops (never throws) if Web Audio isn't available. */
export function playChime(kind: NotifyKind, win: AudioHost = window as unknown as AudioHost): void {
  const ctx = acquireCtx(win);
  if (!ctx) return;
  const { freqs, dur } = TONE[kind];
  const t0 = ctx.currentTime;
  for (let i = 0; i < freqs.length; i++) {
    const start = t0 + i * dur;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freqs[i];
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}

/**
 * Owns the mute toggle's persisted state. Starts `true` (matches SSR — no window
 * yet) then, on mount, resolves the stored preference or falls back to
 * prefers-reduced-motion. Every explicit `setMuted` call persists immediately.
 */
export function useChimeMuted(): [boolean, (v: boolean) => void] {
  const [muted, setMutedState] = useState(true);
  useEffect(() => {
    const stored = loadMutePref();
    setMutedState(stored !== null ? stored : prefersReducedMotion());
  }, []);
  const setMuted = (v: boolean) => {
    setMutedState(v);
    saveMutePref(v);
  };
  return [muted, setMuted];
}

// Extracted as a pure predicate (not inlined in the effect) so the "no baseline →
// silent" guarantee is directly unit-testable: an SSR/fixture-seeded FleetState can
// ALREADY contain raised/failed/done runs on the very first render, and that must
// never be treated as a fresh edge-trigger — there's no prior snapshot to diff
// against, so nothing "just happened". Muting is the same kind of suppression.
export function shouldSuppressChime(muted: boolean, prev: FleetState | null): boolean {
  return muted || !prev;
}

/** Fires a chime for each alert edge-triggered since the previous render's state. */
export function useDeskChime(state: FleetState, muted: boolean): void {
  const prevRef = useRef<FleetState | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = state;
    if (shouldSuppressChime(muted, prev)) return; // no baseline on the first render — never chime on load
    for (const kind of chimeKindsFor(prev ?? undefined, state)) playChime(kind);
  }, [state, muted]);
}
