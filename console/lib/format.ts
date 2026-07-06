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

// Path-leak guard (DOM rendering only): discovery ids are opaque slugs (never a
// path — see lib/server/discovery.ts's slugFor), but legacy/fixture data can still
// carry a pre-migration absolute-path projectId. Never render one raw.
function isPathShaped(id: string): boolean {
  return id.startsWith("/") || id.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(id);
}

/** A path-shaped id's basename; any other id passes through unchanged. */
export function sanitizeProjectId(id: string): string {
  if (!isPathShaped(id)) return id;
  const norm = id.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return base || id;
}

/** DOM-safe project label: the human name when we have one, else a sanitized
 * (never-a-raw-path) projectId. */
export function projectLabel(projectId: string, projectName?: string): string {
  if (projectName && projectName.trim()) return projectName;
  return sanitizeProjectId(projectId);
}
