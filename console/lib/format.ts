// console/lib/format.ts — tiny display formatters (tokens primary, $ garnish).

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function fmtPct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

// Absolute local hh:mm:ss (§6: timestamps absolute, local tz).
export function fmtClock(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
