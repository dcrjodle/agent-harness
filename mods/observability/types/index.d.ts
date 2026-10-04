// What `bin/observe list` and `bin/observe export` print, and the values the pane keeps for the session.

export type Tokens = { input: number; cache_read: number; cache_write: number; output: number; total: number }

export type Session = {
  id: string
  title: string | null
  cwd: string | null
  model: string | null
  status: 'active' | 'idle' | 'ended' | 'failed'
  started_at: string
  ended_at: string | null
  last_at: string
  wall_ms: number
  active_ms: number
  agents: number
  messages: number
  tool_errors: number
  tokens: Tokens
  cost_usd: number
  cost_source: 'engine' | 'estimate'
  unpriced: string[]
  transcript: string | null
}

export type AgentNode = {
  id: string
  parent: string | null
  kind: 'session' | 'agent'
  type: string
  description: string | null
  status: string
  started_at: string
  ended_at: string | null
  runs: number
  active_ms: number
  tool_uses: number | null
  tool_errors: number
  last_message: string | null
  models: string[]
  tokens: Tokens
  output_exact: boolean
  cost_usd: number
  unpriced: string[]
}

export type Message = { ts: string; agent: string; kind: string; text: string }

export type Failure = { ts: string; agent: string; tool: string | null; error: string }

export type Detail = {
  session: Session
  nodes: AgentNode[]
  edges: { from: string; to: string }[]
  messages: Message[]
  errors: Failure[]
}

export type View = { session: string | null; node: string | null; limit: number }

declare module 'claude-code' {
  interface PluginState {
    observability: {
      sessions: Session[]
      detail: Detail | null
      view: View
      notice: string
      isOpened: boolean
    }
  }
}
