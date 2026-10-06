export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { percent?: number; tokens?: number }
export type Snapshot = { limits: Limit[]; now: number; context?: Context }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: Snapshot | null
      lastResponseAt: number | null
      suggestions: { sid: string | null; list: string[] }
      handoffBusy: number | null
      handoffTick: number
      agentsRunning: number
    }
  }
}
