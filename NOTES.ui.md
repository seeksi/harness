# Subtask: ui (LaunchConsole auto label)

spec: In console/components/LaunchConsole.tsx, change the model-routing select's auto
option label from "auto (route-cost default)" to "auto (tier routed per lane)". Update
console/components/LaunchConsole.test.tsx ONLY if it asserts that string. No behavior,
prop, or payload change.

owns: console/components/LaunchConsole.tsx, console/components/LaunchConsole.test.tsx

acceptance: cd console && npx vitest run — green; npx eslint . clean.
