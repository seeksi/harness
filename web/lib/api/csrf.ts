// web/lib/api/csrf.ts
// CSRF guard for mutating API routes. Requires:
//   1. Origin header matches Host (same-origin)
//   2. X-Umbrella-Request: 1 custom header
// Fail-closed: if either check fails, caller must 403 and stop.

export function csrfOk(request: Request): boolean {
  const customHeader = request.headers.get("x-umbrella-request");
  if (customHeader !== "1") return false;

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;

  try {
    const originUrl = new URL(origin);
    // host header may include port; origin always includes scheme.
    // Compare just host[:port].
    return originUrl.host === host;
  } catch {
    return false;
  }
}
