// console/lib/sse/resume.ts
// Pure SSE resume helpers shared by the route handler and the client so a reconnect
// resumes at cursor+1 — gapless, no duplicate frames, no dropped frame 0. An absent,
// empty, or malformed cursor means "no cursor": start the stream from frame 0.

// Start index for a stream given a resume cursor (Last-Event-ID header or lastEventId
// query param). Only a validated non-negative integer resumes (at cursor+1); anything
// else — missing header (null), "", "abc", "3.5", "-1" — starts fresh at 0.
export function resumeStartIndex(cursor: string | null | undefined): number {
  if (cursor == null || cursor.trim() === "") return 0; // trim: Number(" ") is 0, a JS trap
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n + 1;
}

// Append the last received event id to a stream URL so the client's explicit reconnect
// resumes where it left off (native EventSource reconnect uses the Last-Event-ID header;
// this covers the recreate-the-source path). No id → the URL is returned unchanged.
export function withLastEventId(url: string, lastEventId: string | null | undefined): string {
  if (lastEventId == null || lastEventId === "") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}lastEventId=${encodeURIComponent(lastEventId)}`;
}
