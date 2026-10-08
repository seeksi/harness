export type Trajectory = { total: number; last: string; run: number }

declare module 'claude-code' {
  interface PluginState {
    'trajectory-guard': { trajectory: Trajectory }
  }
}
