# Subtask: cli (gantry usage text)

spec: In bin/gantry ONLY, update the two usage lines (header comment line 9 and usage())
so `--model auto` is documented as tier-routed per lane, e.g.:
  --model auto|haiku|sonnet|opus   (auto = tier routed per lane; named model forces all lanes)
Keep the synopsis one line per command; no behavior change, no new flags.

owns: bin/gantry

acceptance: node --check bin/gantry passes; `gantry run` with no args prints the updated
usage text; no other lines of the file change.
