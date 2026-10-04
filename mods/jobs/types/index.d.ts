// What the Jobs pane keeps for the session: the running sessions as jobs, the repos a job can start in, and what the person has open.

/** `plan`: a plan waits for approval. `needs`: another question or permission waits. `working`: a turn runs. `idle`: nothing runs. */
export type JobState = 'plan' | 'needs' | 'working' | 'idle'

/** `desktop`: the Claude app hosts it. `background`: `claude --bg` runs it. `terminal`: it runs in a terminal. */
export type JobKind = 'desktop' | 'background' | 'terminal'

/** One running session. A text field holds `''` when the session has no such value. */
export type Job = {
  id: string
  pid: number
  title: string
  cwd: string
  repo: string
  kind: JobKind
  state: JobState
  note: string
  hostId: string
  link: string
  bgId: string
  branch: string
  startedAt: number
  since: number
  isSelf: boolean
  planPath: string
  planText: string
}

export type Repo = { path: string; name: string; uses: number }

/** A job the app holds as a chip until the person starts it. */
export type Queued = { taskId: string; title: string; repo: string; isPlan: boolean; at: number }

export type Detail = { jobId: string; title: string; text: string }

export type View = {
  repo: string
  isRepoMenuOpen: boolean
  repoQuery: string
  isPlanFirst: boolean
  selected: string[]
  anchor: string
  menu: string
  detail: Detail | null
  draft: number
  notice: string
}

declare module 'claude-code' {
  interface PluginState {
    jobs: { jobs: Job[]; repos: Repo[]; queued: Queued[]; view: View; isOpened: boolean }
  }
}
