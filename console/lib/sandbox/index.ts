// console/lib/sandbox/index.ts
// Public surface of the safe agent sandbox. Consumers should import the entrypoint
// `runAgentInSandbox` from here; the lower-level primitives are also re-exported for
// the daemon's per-step orchestration (worktree/trace) and for the sandbox's own tests.
export {
  runAgentInSandbox,
  spawnAgent,
  buildAgentArgs,
  buildInvocation,
  laneUser,
  parseAgentUsage,
  validateLimits,
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
} from "./agent-runner";
export { worktreePathFor, containedWorktree, relocateTrace } from "./worktree";
