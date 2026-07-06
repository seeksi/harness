import { describe, it, expect, vi } from "vitest";
import { newRun, type FleetState, type RunState, type Gate } from "@/lib/contract/types";
import {
  chimeKindsFor,
  loadMutePref,
  saveMutePref,
  prefersReducedMotion,
  playChime,
  shouldSuppressChime,
  type AudioHost,
} from "./chime";

function fleet(runs: RunState[]): FleetState {
  const out: FleetState = { runs: {}, order: [] };
  for (const r of runs) {
    out.runs[r.runId] = r;
    out.order.push(r.runId);
  }
  return out;
}
function run(over: Partial<RunState> = {}): RunState {
  return { ...newRun("r1", "proj", "vector", "a brief", 100), ...over };
}
const raised = (id: Gate["id"]): Gate => ({ id, status: "raised", severity: "high", summary: `block ${id}` });

describe("chimeKindsFor — edge-triggered, mirrors the ntfy notifier's rule", () => {
  it("fires gate-raised once when a gate first raises, not on a benign transition", () => {
    const before = fleet([run()]);
    const after = fleet([run({ gates: [raised("B")] })]);
    expect(chimeKindsFor(before, after)).toEqual(["gate-raised"]);
    expect(chimeKindsFor(after, after)).toEqual([]);
  });

  it("fires run-completed / run-failed for the matching runs across the whole fleet", () => {
    const before = fleet([run({ runId: "r1", status: "running" }), run({ runId: "r2", status: "running" })]);
    const after = fleet([run({ runId: "r1", status: "done" }), run({ runId: "r2", status: "failed" })]);
    expect(chimeKindsFor(before, after).sort()).toEqual(["run-completed", "run-failed"]);
  });

  it("has no baseline (before=undefined) → no chime kinds", () => {
    expect(chimeKindsFor(undefined, fleet([run()]))).toEqual([]);
  });
});

describe("shouldSuppressChime — useDeskChime's no-baseline guard", () => {
  it("suppresses when there is no prior snapshot, regardless of mute state", () => {
    expect(shouldSuppressChime(false, null)).toBe(true);
    expect(shouldSuppressChime(true, null)).toBe(true);
  });

  it("suppresses when muted even with a real prior snapshot", () => {
    expect(shouldSuppressChime(true, fleet([run()]))).toBe(true);
  });

  it("does not suppress once unmuted with a real prior snapshot", () => {
    expect(shouldSuppressChime(false, fleet([run()]))).toBe(false);
  });
});

describe("useDeskChime baseline (§5/§6 regression): pre-existing raised/failed/done state stays silent on first observation", () => {
  // Mirrors useDeskChime's own effect body exactly (prevRef starts at null; the
  // guard runs before chimeKindsFor is ever computed) without needing to mount a
  // component — this is the same shape the hook drives on every render.
  function simulateDeskChime() {
    let prev: FleetState | null = null;
    const played: string[] = [];
    return {
      played,
      observe(muted: boolean, state: FleetState) {
        const localPrev = prev;
        prev = state;
        if (shouldSuppressChime(muted, localPrev)) return;
        for (const kind of chimeKindsFor(localPrev ?? undefined, state)) played.push(kind);
      },
    };
  }

  it("an SSR/fixture-seeded fleet that's ALREADY raised+failed+done on mount never chimes", () => {
    const alreadyAlerting = fleet([
      run({ runId: "r1", gates: [raised("B")] }),
      run({ runId: "r2", status: "failed" }),
      run({ runId: "r3", status: "done" }),
    ]);
    const sim = simulateDeskChime();
    sim.observe(false, alreadyAlerting); // first-ever observation, unmuted
    expect(sim.played).toEqual([]);
  });

  it("a genuinely new transition on the NEXT observation still chimes normally", () => {
    const alreadyAlerting = fleet([
      run({ runId: "r1", gates: [raised("B")] }),
      run({ runId: "r2", status: "failed" }),
      run({ runId: "r3", status: "done" }),
    ]);
    const sim = simulateDeskChime();
    sim.observe(false, alreadyAlerting); // baseline established, silent
    const nextAlerting = fleet([
      run({ runId: "r1", gates: [raised("B")] }),
      run({ runId: "r2", status: "failed" }),
      run({ runId: "r3", status: "done" }),
      run({ runId: "r4", gates: [raised("C")] }), // NEW edge-trigger
    ]);
    sim.observe(false, nextAlerting);
    expect(sim.played).toEqual(["gate-raised"]);
  });
});

describe("mute preference — persisted, injectable storage", () => {
  it("round-trips through the given storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadMutePref(storage)).toBeNull();
    saveMutePref(true, storage);
    expect(loadMutePref(storage)).toBe(true);
    saveMutePref(false, storage);
    expect(loadMutePref(storage)).toBe(false);
  });
});

describe("prefersReducedMotion", () => {
  it("reads the given MediaQueryList's matches", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });
});

describe("playChime — Web Audio synth, no assets", () => {
  it("no-ops (never throws) when the host has no AudioContext", () => {
    expect(() => playChime("gate-raised", {})).not.toThrow();
  });

  it("creates one oscillator per tone frequency and starts/stops it", () => {
    const osc = { type: "", frequency: { value: 0 }, connect: vi.fn(() => gain), start: vi.fn(), stop: vi.fn() };
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    const ctx = {
      currentTime: 0,
      state: "running",
      createOscillator: vi.fn(() => ({ ...osc })),
      createGain: vi.fn(() => ({ ...gain })),
      destination: {},
    };
    const FakeAudioContext = vi.fn(function FakeAudioContext() {
      return ctx;
    }) as unknown as typeof AudioContext;
    const win: AudioHost = { AudioContext: FakeAudioContext };
    playChime("run-completed", win); // 3-tone chime
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
  });
});
