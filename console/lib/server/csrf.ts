// console/lib/server/csrf.ts
// CSRF guard for mutating API routes (ported from web/lib/api/csrf.ts). Layered,
// fail-closed — any failing check means the caller must 403 and stop:
//   1. X-Harness-Request: 1 custom header (primary guard — a cross-origin page cannot
//      set a custom header without a CORS preflight, and there is no CORS, so the
//      preflight fails and the request never arrives).
//   2. Sec-Fetch-Site, when present, must be same-origin (modern browsers always send it).
//   3. Origin must match Host AND scheme (full same-origin, not just host).
//
// The network is the perimeter (tailnet-only, no in-app authn — DESIGN_SPEC §7 / threat
// model TB-1); this guard defends the realistic attacker: a malicious page in the
// operator's own browser (TB-5).

export const CSRF_HEADER = "x-harness-request";

export function csrfOk(request: Request): boolean {
  if (request.headers.get(CSRF_HEADER) !== "1") return false;

  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;

  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) return false;
    return originUrl.protocol === new URL(request.url).protocol;
  } catch {
    return false;
  }
}
