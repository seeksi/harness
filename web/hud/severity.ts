// web/hud/severity.ts
// Locked status hues (design package §A) for HUD severity accents. Mirrors the
// scene's status tokens — both lanes encode the same locked values independently,
// since the import boundary keeps scene/** and hud/** decoupled.
// ponytail: promote to a shared lib/ design-tokens module if the two copies drift.
import type { Severity } from "@/lib/contract/types";

export function statusColorForSeverity(severity: Severity): string {
  switch (severity) {
    case "critical":
    case "high":
      return "hsl(0, 75%, 56%)"; // scarce red
    case "medium":
      return "hsl(47, 90%, 55%)"; // true/golden amber
    case "low":
      return "hsl(208, 88%, 58%)"; // cyan in-progress
    default:
      return "hsl(258, 45%, 45%)"; // accent rest-glow
  }
}
