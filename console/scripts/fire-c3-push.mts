// scripts/fire-c3-push.mts — C3 live smoke re-fire.
// Calls the REAL notifier.notify() (§5 code path) with the same env the live
// :3001 dry-daemon runs under, so the phone tap exercises the actual deep-link
// build (CONSOLE_BASE_URL -> /run/[id]) — not a hand-rolled curl.
import { notify } from "@/lib/server/notifier";

const runId = process.env.C3_RUN_ID ?? "e9e460ed64c2abb3dceaf19f";
const ok = await notify({
  kind: "run-failed",
  projectName: "HARNESS",
  detail: "C3 re-fire · tap to open the run page",
  runId,
});
console.log(JSON.stringify({
  posted: ok,
  topic: process.env.NTFY_TOPIC,
  url: process.env.NTFY_URL,
  base: process.env.CONSOLE_BASE_URL,
  runId,
}, null, 2));
process.exit(ok ? 0 : 1);
