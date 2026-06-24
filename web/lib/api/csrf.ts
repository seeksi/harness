// web/lib/api/csrf.ts
// CSRF guard for mutating API routes. Layered, fail-closed — any failing check
// means the caller must 403 and stop:
//   1. X-Umbrella-Request: 1 custom header (the primary guard — a cross-origin
//      page cannot set a custom header without a CORS preflight, and there is no
//      CORS, so the preflight fails and the request never arrives).
//   2. Sec-Fetch-Site, when present, must be same-origin/same-site (modern
//      browsers always send it; rejects cross-site even if the above were bypassed).
//   3. Origin must match Host AND scheme (full same-origin, not just host — an
//      http origin must not satisfy an https host).

export function csrfOk(request: Request): boolean {
  if (request.headers.get("x-umbrella-request") !== "1") return false;

  // Sec-Fetch-Site is sent by all current browsers for fetch/XHR. When present it
  // must be exactly same-origin (no CORS, no subdomains in this single-origin tool).
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;

  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) return false;
    // Scheme must match what the server is actually serving on — otherwise an
    // http origin would pass against an https host.
    return originUrl.protocol === new URL(request.url).protocol;
  } catch {
    return false;
  }
}
