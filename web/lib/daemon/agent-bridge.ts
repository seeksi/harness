// web/lib/daemon/agent-bridge.ts
// COMPATIBILITY SHIM. The agent-isolation layer moved to lib/sandbox/ — the sole owner
// of every isolation primitive (tool allowlist, validated argv, privilege drop, minimal
// env, worktree confinement, default-OFF gate, timeout/kill, audit). This file re-exports
// the surface so existing consumers (the capabilities route, daemon, tests) keep working
// unchanged. New code should import from "@/lib/sandbox".
//
// Prefer the single entrypoint `runAgentInSandbox` for new consumers; the lower-level
// primitives below are exported for the daemon's per-step orchestration and the tests.

export {
  runAgentInSandbox,
  spawnAgent,
  buildAgentArgs,
  buildInvocation,
  parseAgentUsage,
  worktreePathFor,
  containedWorktree,
  relocateTrace,
  DEFAULT_TOOLS,
  AgentExecError,
  type AgentSpec,
  type AgentUsage,
  type AgentModel,
  type ResourceLimits,
  type SpawnAgentOptions,
  type SandboxAudit,
  type RunAgentInSandboxOptions,
  type RunAgentInSandboxResult,
} from "@/lib/sandbox";
