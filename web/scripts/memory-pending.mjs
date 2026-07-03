#!/usr/bin/env node
// web/scripts/memory-pending.mjs
// Thin operator CLI over web/lib/memory/pendingLedger.ts.
//
//   node scripts/memory-pending.mjs list
//   node scripts/memory-pending.mjs confirm <update_id>
//   node scripts/memory-pending.mjs reject <update_id>
//
// Prints JSON to stdout. ponytail: loads the .ts module at runtime via `jiti`
// (already a resolved dependency here, pulled in transitively by vitest) rather
// than adding a build step — this project has no ts-node/tsx and this Node
// build isn't compiled with native TS-stripping support.
import { createJiti } from "jiti";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { listPending, confirm, reject } = await jiti.import(
  path.join(here, "..", "lib", "memory", "pendingLedger.ts")
);

const [cmd, id] = process.argv.slice(2);

function printAndExit(value, ok = true) {
  console.log(JSON.stringify(value, null, 2));
  process.exit(ok ? 0 : 1);
}

switch (cmd) {
  case "list":
    printAndExit(listPending());
    break;
  case "confirm": {
    if (!id) printAndExit({ error: "usage: memory-pending.mjs confirm <update_id>" }, false);
    const ok = confirm(id);
    printAndExit({ update_id: id, confirmed: ok }, ok);
    break;
  }
  case "reject": {
    if (!id) printAndExit({ error: "usage: memory-pending.mjs reject <update_id>" }, false);
    const ok = reject(id);
    printAndExit({ update_id: id, rejected: ok }, ok);
    break;
  }
  default:
    printAndExit({ error: "usage: memory-pending.mjs list|confirm <id>|reject <id>" }, false);
}
