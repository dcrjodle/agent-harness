// How the pane writes money, time and counts. Pure: nothing here touches the engine.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const two = (n: number): string => String(n).padStart(2, '0')

export function money(usd: number): string {
  if (usd <= 0) return '$0'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${two(seconds % 60)}s` : `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`
}

export function count(n: number): string {
  if (n < 1000) return String(n)
  return n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`
}

/** `14:05:09` in this machine's time zone. */
export function clock(iso: string): string {
  const at = new Date(iso)
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}

/** `Oct 4 14:05` in this machine's time zone. */
export function day(iso: string): string {
  const at = new Date(iso)
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${two(at.getHours())}:${two(at.getMinutes())}`
}

export function clip(text: string, length: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > length ? `${line.slice(0, Math.max(1, length - 1))}…` : line
}

/** The repo a session ran in: the folder above a task or app worktree, else the working directory's own name. */
export function place(cwd: string | null): string {
  if (cwd === null) return 'unknown folder'
  const worktree = /([^/]+)\/\.claude\/worktrees\/[^/]+\/?$/.exec(cwd) ?? /\.agent-worktrees\/([^/]+)\/[^/]+\/?$/.exec(cwd)
  return worktree?.[1] ?? cwd.replace(/\/+$/, '').split('/').pop() ?? cwd
}

/** A color per status that reads on a light and on a dark background. */
export function tone(status: string): string {
  switch (status) {
    case 'running':
    case 'active':
      return '#3b82f6'
    case 'completed':
      return '#22a55b'
    case 'stopped':
      return '#d9822b'
    case 'failed':
    case 'refused':
      return '#e5484d'
    default:
      return '#8b949e'
  }
}
