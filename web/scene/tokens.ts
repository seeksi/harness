// web/scene/tokens.ts
// Locked color tokens (design package §A) as HSL strings consumable by three.Color.
// Base 6% cool near-black; five-stop indigo→violet accent hue-shifted by energy
// (focus ~258° → emission ~274°); four status hues with clear mutual hue distance.

export const BASE_SURFACE = "hsl(222, 11%, 6%)";

// Five-stop indigo→violet accent ramp, hue-shifted by energy.
export const ACCENT = {
  dimFill: "hsl(258, 30%, 14%)", // glass HUD tint
  restGlow: "hsl(258, 45%, 30%)", // low-energy idle pulse
  mid: "hsl(260, 60%, 50%)", // border / ring
  vivid: "hsl(264, 82%, 64%)", // active label / icon
  neon: "hsl(274, 95%, 70%)", // emissive burst
} as const;

// Four status hues — fill/glow values on the 6% base.
export const STATUS = {
  pass: "hsl(152, 58%, 46%)", // emerald/teal pass
  inProgress: "hsl(208, 88%, 58%)", // cyan-blue in-progress
  needs: "hsl(47, 90%, 55%)", // true/golden amber
  fail: "hsl(0, 75%, 56%)", // scarce red
} as const;

/** Map a normalized run/subtask/phase status to a scene color token. */
export function statusColor(status?: string): string {
  switch (status) {
    case "done":
    case "merged":
      return STATUS.pass;
    case "active":
    case "building":
    case "running":
      return STATUS.inProgress;
    case "reviewed":
      return ACCENT.vivid;
    case "blocked":
    case "failed":
      return STATUS.fail;
    case "pending":
      return ACCENT.restGlow;
    case "idle":
      return ACCENT.dimFill;
    default:
      return ACCENT.mid;
  }
}

/** Emissive burst color for an agent-fire of a given severity. */
export function fireColor(severity: string): string {
  switch (severity) {
    case "critical":
    case "high":
      return STATUS.fail;
    case "medium":
      return STATUS.needs;
    default:
      return ACCENT.neon;
  }
}
