export type Dimension = 'maintainability' | 'reliability' | 'security' | 'tests'

export type Scores = Record<Dimension, number>

export type Severity = 'high' | 'medium' | 'low'

export type Suggestion = {
  id: string
  dimension: Dimension
  severity: Severity
  title: string
  why: string
  paths: string[]
}

export type Report = {
  run: string
  scannedAt: string | null
  scores: Scores
  suggestions: Suggestion[]
}

export type Run = {
  session: string
  status: 'running' | 'succeeded' | 'failed'
  at: string | null
}

export type Routine = {
  id: string
  isEnabled: boolean
  nextRunAt: string | null
  run: Run | null
}

export type Repo = {
  slug: string
  root: string
  usedAt: number
  routine: Routine | null
  report: Report | null
}

export type Board = {
  repos: Repo[]
  loadedAt: number
  isLoading: boolean
  notice: string
}

declare module 'claude-code' {
  interface PluginState {
    'code-quality': {
      board: Board
      selected: string | null
      issues: Record<string, string>
      busy: string[]
      isOpened: boolean
    }
  }
}
