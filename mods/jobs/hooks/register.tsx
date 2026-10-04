// The Jobs pane: every running Claude Code session as one centered list, with a prompt on top that starts more.
// Sessions come from `claude agents --json`; the Claude app's own session tools start, open, message and close them,
// and `claude --bg` stands in where the app is not the host.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Job, Queued, Repo, View } from '../types'

import type { AppRow, Pending } from './lib'
import {
  GROUPS,
  age,
  baseName,
  matchRepos,
  mergePrompt,
  parseAgents,
  parseAppSessions,
  parseRegistry,
  pendingTool,
  pieces,
  planPrompt,
  rankRepos,
  recentTalk,
  repoOf,
  revisePrompt,
  slug,
  sortJobs,
  span,
  stateOf,
  titleOf,
} from './lib'

const PANE = 'jobs'
const TITLE = 'Jobs'
const LIST_COLUMNS = 92
const SIDE_COLUMNS = 64
const SIDE_BY_SIDE = 128
const APP_EVERY = 20000
const QUEUED_FOR = 30 * 60000
const TAIL_BYTES = '400000'
const RETAKE = 300

/** The room the pane asks for: the list's width where it docks, most of the screen's height where it sits above the prompt. */
const OPEN = { id: PANE, title: TITLE, columns: LIST_COLUMNS + 4, rows: 30 } as const

const VIEW: View = {
  repo: '',
  isRepoMenuOpen: false,
  repoQuery: '',
  isPlanFirst: true,
  selected: [],
  anchor: '',
  menu: '',
  detail: null,
  draft: 0,
  notice: '',
}

const jobs = atom({ plugin: 'jobs', key: 'jobs' } as const, [])
const repos = atom({ plugin: 'jobs', key: 'repos' } as const, [])
const queued = atom({ plugin: 'jobs', key: 'queued' } as const, [])
const view = atom({ plugin: 'jobs', key: 'view' } as const, VIEW)
const isOpened = atom({ plugin: 'jobs', key: 'isOpened' } as const, false)

/** What the app's session list last said, kept between loads: it changes slowly and costs a call. */
const app: { rows: Map<string, AppRow>; at: number } = { rows: new Map(), at: 0 }
const pendingAt = new Map<string, { at: number; pending: Pending | null }>()
const hasGit = new Map<string, boolean>()
let isLoading = false

/** What the prompt field holds, as its last change said, and the last job started from it: one key press starts one job. */
const field = { text: '', started: '', at: 0 }
const SAME_PRESS = 1000

type Said = { isOk: boolean; isReached: boolean; text: string }

/** One call on the Claude app's own tools; unreached where the session is not hosted by the app. */
async function ask($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<Said> {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.map(block => block.text ?? '').join('\n')

    return { isOk: !result.isError, isReached: true, text }
  } catch {
    return { isOk: false, isReached: false, text: 'the Claude app hosts it, and this session cannot reach the app' }
  }
}

async function engine($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? 'claude'
}

async function configDir($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
}

async function say($: EngineInterface, notice: string): Promise<void> {
  $.ui.toast(notice)
  await update($, view, shown => ({ ...shown, notice }))
}

/**
 * Puts the keyboard in a field the next drawing brings: a click that opens a field means to type there.
 * A click on a row leaves the keys with the prompt, so the pane asks for them first (refused over a typed prompt).
 */
async function focus($: EngineInterface, key: string): Promise<void> {
  await $.ui.open({ ...OPEN, focus: true }).catch(() => undefined)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

/** Whether two values hold the same data: a load that found nothing new writes nothing, so nothing is drawn again. */
function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The end of a session's transcript: under its directory's folder, or wherever it sits when the session moved since. */
async function tailOf($: EngineInterface, cwd: string, id: string): Promise<string> {
  const projects = `${await configDir($)}/projects`
  const tail = async (file: string): Promise<string> => {
    const ran = await $.process.run(['tail', '-c', TAIL_BYTES, file]).catch(() => null)

    return ran === null || ran.exitCode !== 0 ? '' : ran.stdout
  }
  const direct = await tail(`${projects}/${slug(cwd)}/${id}.jsonl`)

  if (direct !== '') return direct

  const found = await $.process.run(['find', projects, '-maxdepth', '2', '-name', `${id}.jsonl`]).catch(() => null)
  const file = found?.stdout.split('\n')[0]?.trim() ?? ''

  return file === '' ? '' : tail(file)
}

async function isRepo($: EngineInterface, path: string): Promise<boolean> {
  const known = hasGit.get(path)

  if (known !== undefined) return known

  const found = await $.fs.exists(`${path}/.git`).catch(() => false)

  hasGit.set(path, found)

  return found
}

/** The app's sessions by its own id, asked for again only once the last answer is old. */
async function appSessions($: EngineInterface, now: number): Promise<Map<string, AppRow>> {
  if (now - app.at < APP_EVERY) return app.rows

  const listed = await ask($, 'ccd_session_mgmt', 'list_sessions', { limit: 50 })

  app.at = now
  if (listed.isOk) app.rows = parseAppSessions(listed.text)

  return app.rows
}

async function load($: EngineInterface): Promise<void> {
  if (isLoading) return

  isLoading = true

  try {
    const now = await $.clock.now()
    const dir = await configDir($)
    const self = await $.session.id()
    const ran = await $.process.run([await engine($), 'agents', '--json'], { timeoutMs: 15000 }).catch(() => null)
    const rows = ran === null || ran.exitCode !== 0 ? [] : parseAgents(ran.stdout)
    const known = await appSessions($, now)

    const found = await Promise.all(
      rows.map(async (row): Promise<Job> => {
        const registry = parseRegistry(await $.fs.read(`${dir}/sessions/${row.pid}.json`).catch(() => ''))
        const since = registry.statusAt || row.startedAt
        let pending: Pending | null = null

        if (row.status === 'waiting') {
          const kept = pendingAt.get(row.sessionId)

          pending = kept?.at === since ? kept.pending : pendingTool(await tailOf($, row.cwd, row.sessionId))
          pendingAt.set(row.sessionId, { at: since, pending })
        }

        let state = stateOf(row.status, pending)
        let note = state === 'needs' ? row.waitingFor : ''
        let planText = ''

        if (state === 'plan' && pending !== null) {
          planText = pending.planText
          if (planText === '' && pending.planPath !== '') planText = await $.fs.read(pending.planPath).catch(() => '')
        }

        // A background session that cannot go on says why in its own record (a login it needs, a prompt it lacks).
        if (row.kind === 'background' && row.bgId !== '' && state === 'idle') {
          const needs = await $.fs
            .read(`${dir}/jobs/${row.bgId}/state.json`)
            .then(text => (JSON.parse(text) as { needs?: unknown }).needs)
            .catch(() => undefined)

          if (typeof needs === 'string' && needs !== '') {
            state = 'needs'
            note = needs
          }
        }

        const hosted = known.get(registry.hostId)

        return {
          id: row.sessionId,
          pid: row.pid,
          title: clean(row.name || hosted?.title || baseName(row.cwd)),
          cwd: row.cwd,
          repo: repoOf(row.cwd),
          kind: registry.hostId !== '' ? 'desktop' : row.kind === 'background' ? 'background' : 'terminal',
          state,
          note: clean(note),
          hostId: registry.hostId,
          link: hosted?.link ?? '',
          bgId: row.kind === 'background' ? row.bgId : '',
          branch: clean(hosted?.branch ?? ''),
          startedAt: row.startedAt,
          since,
          isSelf: row.sessionId === self,
          planPath: pending?.planPath ?? '',
          planText: body(planText),
        }
      }),
    )

    const sorted = sortJobs(found)

    if (!isSame(await read($, jobs), sorted)) await update($, jobs, () => sorted)

    await settleQueued($, found, now)
    await rank($, found, known)

    // A job that ended leaves the highlight, the menu and the plan sidebar.
    const live = new Set(found.map(job => job.id))
    const shown = await read($, view)
    const kept = shown.selected.filter(id => live.has(id))

    if (kept.length !== shown.selected.length || (shown.menu !== '' && !live.has(shown.menu))) {
      await update($, view, was => ({ ...was, selected: kept, menu: live.has(was.menu) ? was.menu : '' }))
    }
  } finally {
    isLoading = false
  }
}

/** A queued job leaves the queue once its session runs, entering plan mode there when it was asked to plan first. */
async function settleQueued($: EngineInterface, found: readonly Job[], now: number): Promise<void> {
  const waiting = await read($, queued)
  const left: Queued[] = []

  for (const one of waiting) {
    // Its session is the one the app named after the chip, in that repo, started after the chip was queued.
    const started = found.find(
      job => job.kind === 'desktop' && job.title === one.title && job.repo === one.repo && job.startedAt >= one.at,
    )

    if (started === undefined) {
      if (now - one.at < QUEUED_FOR) left.push(one)

      continue
    }

    if (one.isPlan) {
      void ask($, 'ccd_session_mgmt', 'set_session_permission_mode', { session_id: started.hostId, mode: 'plan' })
    }
  }

  if (left.length !== waiting.length) await update($, queued, () => left)
}

async function rank($: EngineInterface, found: readonly Job[], known: ReadonlyMap<string, AppRow>): Promise<void> {
  const stored = await $.store.get('started').catch(() => undefined)
  const started: Record<string, number> = {}

  for (const [path, count] of Object.entries(typeof stored === 'object' && stored !== null ? stored : {})) {
    if (typeof count === 'number') started[path] = count
  }

  const seen = [...found.map(job => job.repo), ...[...known.values()].map(row => repoOf(row.cwd))]
  const ranked: Repo[] = []

  for (const repo of rankRepos(started, seen)) {
    if (await isRepo($, repo.path)) ranked.push(repo)
  }

  if (ranked.length === 0) {
    const root = repoOf(await $.session.root())

    ranked.push({ path: root, name: baseName(root), uses: 0 })
  }

  if (!isSame(await read($, repos), ranked)) await update($, repos, () => ranked)

  const shown = await read($, view)

  // The most used repo is the one a job starts in until the person picks another.
  if (shown.repo === '') await update($, view, was => ({ ...was, repo: ranked[0]?.path ?? '' }))
}

/** Text a surface draws: no control characters but tab and newline. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

function body(text: string): string {
  return clean(text.replace(/\r\n?/g, '\n'))
}

/**
 * Starts a job from the prompt field. `field`: Enter, in plan mode unless the person switched it off; `skip`: no plan.
 * In the app the job is a chip the person presses in the chat; elsewhere the engine runs it as a background session.
 */
async function start($: EngineInterface, prompt: string, how: 'field' | 'skip'): Promise<void> {
  const shown = await read($, view)
  const now = await $.clock.now()
  const isPlan = how === 'field' && shown.isPlanFirst

  if (prompt.trim() === '') return
  if (field.started === prompt.trim() && now - field.at < SAME_PRESS) return
  if (shown.repo === '') return say($, 'Pick a repo to start in first.')

  field.started = prompt.trim()
  field.at = now

  const title = titleOf(prompt)
  const asked = await ask($, 'ccd_session', 'spawn_task', {
    title,
    prompt: planPrompt(prompt, isPlan),
    tldr: `Started from the Jobs pane in ${baseName(shown.repo)}${isPlan ? ', planning first' : ''}.`,
    cwd: shown.repo,
  })

  if (asked.isReached && !asked.isOk) return say($, `The app did not take the job: ${asked.text}`)

  if (asked.isOk) {
    const taskId = /task_[0-9a-f]+/.exec(asked.text)?.[0] ?? ''

    await update($, queued, list => [...list, { taskId, title, repo: shown.repo, isPlan, at: now }])
    await say($, `"${title}" is ready: press its chip in the chat to start it.`)
  } else {
    // No app behind this session: the engine's own background sessions take the job.
    const ran = await $.process
      .run([await engine($), '--bg', ...(isPlan ? ['--permission-mode', 'plan'] : []), '-n', title, prompt.trim()], {
        cwd: shown.repo,
        timeoutMs: 60000,
      })
      .catch(() => null)

    if (ran === null || ran.exitCode !== 0) return say($, `Could not start the job: ${clean(ran?.stderr ?? 'claude --bg did not run').trim()}`)

    await say($, `"${title}" started in the background${isPlan ? ', planning first' : ''}.`)
  }

  const stored = await $.store.get('started').catch(() => undefined)
  const counts: Record<string, unknown> = typeof stored === 'object' && stored !== null ? { ...stored } : {}
  const before = counts[shown.repo]

  await $.store.set('started', { ...counts, [shown.repo]: (typeof before === 'number' ? before : 0) + 1 })
  field.text = ''

  // A new field replaces the one that held the prompt; the keyboard follows it.
  const next = await update($, view, was => ({ ...was, draft: was.draft + 1 }))

  await focus($, `prompt:${next.draft}`)
  await load($)
}

/**
 * Every change of the prompt field. Enter with a modifier held (cmd, option) reaches a field as a line break, not a
 * submit: a break added to the end of what was typed is that key, and starts the job without a plan.
 */
async function edited($: EngineInterface, value: string): Promise<void> {
  const before = field.text

  field.text = value

  if (before.trim() !== '' && value === `${before}\n`) await start($, before, 'skip')
}

async function withdraw($: EngineInterface, taskId: string): Promise<void> {
  if (taskId !== '') await ask($, 'ccd_session', 'dismiss_task', { task_id: taskId, reason: 'Withdrawn from the Jobs pane' })

  await update($, queued, list => list.filter(one => one.taskId !== taskId))
}

/** Shows the job's own chat: beside this one where the app allows it, else in the app's main view. */
async function open($: EngineInterface, job: Job): Promise<void> {
  if (job.isSelf) return say($, 'That is the session you are in.')

  if (job.kind === 'desktop') {
    const split = await ask($, 'ccd_window', 'open_session_in', { session_id: job.hostId, target: 'split' })

    // The app says in words what it did (opened it, or it was on screen already): the person reads that.
    if (split.isOk) return void $.ui.toast(clean(split.text.split('\n')[0] ?? '').slice(0, 160) || `Opened "${job.title}".`)
    if (job.link === '') return say($, `Open "${job.title}" from the app's session list.`)

    for (const opener of ['open', 'xdg-open']) {
      const ran = await $.process.run([opener, job.link]).catch(() => null)

      if (ran?.exitCode === 0) return
    }

    return say($, `Could not open "${job.title}".`)
  }

  if (job.kind === 'background') {
    const ran = await $.process
      .run([await engine($), '--desktop', '--resume', job.id], { cwd: job.cwd, timeoutMs: 20000 })
      .catch(() => null)

    if (ran?.exitCode === 0) return

    return say($, `Could not open "${job.title}" in the app: claude attach ${job.bgId} opens it in a terminal.`)
  }

  return say($, `"${job.title}" runs in a terminal (pid ${job.pid}): its chat is there.`)
}

/** Interrupts the job's turn. A plan or question it held open is dropped with it. */
async function halt($: EngineInterface, job: Job): Promise<Said> {
  if (job.kind === 'desktop') return ask($, 'ccd_session_mgmt', 'stop_session', { session_id: job.hostId })

  if (job.kind === 'background') {
    const ran = await $.process.run([await engine($), 'stop', job.bgId], { timeoutMs: 20000 }).catch(() => null)

    return { isOk: ran?.exitCode === 0, isReached: ran !== null, text: clean(ran?.stderr ?? '').trim() }
  }

  return { isOk: false, isReached: false, text: 'it runs in a terminal' }
}

/** Hands the job a prompt as its next turn. */
async function tell($: EngineInterface, job: Job, text: string, isPlan: boolean): Promise<Said> {
  if (job.isSelf) {
    await $.prompt.submit({ text })

    return { isOk: true, isReached: true, text: '' }
  }

  if (job.kind === 'desktop') return ask($, 'ccd_session_mgmt', 'send_message', { session_id: job.hostId, message: text })

  if (job.kind === 'background') {
    await halt($, job)

    const ran = await $.process
      .run([await engine($), '--bg', '--resume', job.id, ...(isPlan ? ['--permission-mode', 'plan'] : []), text], {
        cwd: job.cwd,
        timeoutMs: 60000,
      })
      .catch(() => null)

    return { isOk: ran?.exitCode === 0, isReached: ran !== null, text: clean(ran?.stderr ?? '').trim() }
  }

  return { isOk: false, isReached: false, text: 'it runs in a terminal' }
}

/** Sends the changes to the session that holds the plan: its approval is interrupted and the rewrite runs as its next turn. */
async function revise($: EngineInterface, jobId: string, changes: string): Promise<void> {
  const job = (await read($, jobs)).find(one => one.id === jobId)

  if (changes.trim() === '') return

  await update($, view, shown => ({ ...shown, detail: null, draft: shown.draft + 1 }))

  if (job === undefined) return say($, 'That job is no longer running.')

  if (job.kind === 'desktop') {
    const stopped = await halt($, job)

    if (!stopped.isOk) return say($, `Could not interrupt "${job.title}": ${stopped.text}`)
  }

  const sent = await tell($, job, revisePrompt(changes), true)

  if (!sent.isOk) return say($, `Could not send the changes to "${job.title}": ${sent.text}`)

  await update($, jobs, list =>
    sortJobs(list.map(one => (one.id === jobId ? { ...one, state: 'working', note: '', planText: '' } : one))),
  )
  await say($, `"${job.title}" is rewriting its plan.`)
}

async function stop($: EngineInterface, ids: readonly string[]): Promise<void> {
  const picked = (await read($, jobs)).filter(job => ids.includes(job.id) && !job.isSelf)
  const failed: string[] = []

  for (const job of picked) {
    if (!(await halt($, job)).isOk) failed.push(job.title)
  }

  await update($, view, shown => ({ ...shown, menu: '' }))
  await say($, failed.length === 0 ? `Stopped ${count(picked.length)}.` : `Could not stop ${failed.join(', ')}.`)
  await load($)
}

/** Closes a job: the app archives its session (and asks first), a background session is stopped. Nothing is deleted. */
async function shelve($: EngineInterface, job: Job, reason: string): Promise<Said> {
  if (job.kind !== 'desktop') return halt($, job)

  await halt($, job)

  return ask($, 'ccd_session_mgmt', 'archive_session', { session_id: job.hostId, reason })
}

async function archive($: EngineInterface, ids: readonly string[]): Promise<void> {
  const picked = (await read($, jobs)).filter(job => ids.includes(job.id) && !job.isSelf)
  const failed: string[] = []

  for (const job of picked) {
    if (!(await shelve($, job, 'Archived from the Jobs pane')).isOk) failed.push(job.title)
  }

  await update($, view, shown => ({ ...shown, menu: '', selected: [] }))
  await say($, failed.length === 0 ? `Archived ${count(picked.length)}.` : `Could not archive ${failed.join(', ')}.`)
  await load($)
}

/** Merges the highlighted jobs into one: the target reads what the others were doing, then the others are closed. */
async function merge($: EngineInterface, ids: readonly string[], targetId: string): Promise<void> {
  const picked = (await read($, jobs)).filter(job => ids.includes(job.id))

  if (picked.length < 2) return say($, 'Highlight two or more jobs to merge them.')

  // The session the person is in cannot be closed from its own pane, so it is the one that takes the others.
  const target = picked.find(job => job.isSelf) ?? picked.find(job => job.id === targetId) ?? picked[0]
  const others = picked.filter(job => job !== target)

  if (target === undefined) return

  const parts = await Promise.all(others.map(async job => ({ job, talk: clean(recentTalk(await tailOf($, job.cwd, job.id))) })))
  const sent = await tell($, target, mergePrompt(parts), false)

  if (!sent.isOk) return say($, `Could not merge into "${target.title}": ${sent.text}`)

  const failed: string[] = []

  for (const job of others) {
    if (!(await shelve($, job, `Merged into "${target.title}"`)).isOk) failed.push(job.title)
  }

  await update($, view, shown => ({ ...shown, menu: '', selected: [], anchor: '' }))
  await say(
    $,
    failed.length === 0
      ? `Merged ${count(others.length)} into "${target.title}".`
      : `Merged into "${target.title}"; still open: ${failed.join(', ')}.`,
  )
  await load($)
}

function count(jobs: number): string {
  return jobs === 1 ? '1 job' : `${jobs} jobs`
}

type RowPress = { id: string; button: string; isShift: boolean; isToggle: boolean }

/** A click on a row: right opens its menu, shift and the marker highlight, a plain one opens the job or its plan. */
async function press($: EngineInterface, hit: RowPress): Promise<void> {
  const all = await read($, jobs)
  const job = all.find(one => one.id === hit.id)

  if (job === undefined) return

  if (hit.button === 'right') {
    return void (await update($, view, shown => ({
      ...shown,
      selected: shown.selected.includes(job.id) ? shown.selected : [job.id],
      anchor: job.id,
      menu: shown.menu === job.id ? '' : job.id,
    })))
  }

  if (hit.isShift) {
    const order = all.map(one => one.id)

    return void (await update($, view, shown => ({
      ...shown,
      selected: [...new Set([...shown.selected, ...span(order, shown.anchor, job.id)])],
      menu: '',
    })))
  }

  if (hit.isToggle) {
    return void (await update($, view, shown => ({
      ...shown,
      selected: shown.selected.includes(job.id) ? shown.selected.filter(id => id !== job.id) : [...shown.selected, job.id],
      anchor: job.id,
      menu: '',
    })))
  }

  await update($, view, shown => ({ ...shown, menu: '', notice: '' }))

  if (job.state !== 'plan') return open($, job)

  const opened = await update($, view, shown => ({
    ...shown,
    detail: {
      jobId: job.id,
      title: job.title,
      text: job.planText === '' ? '_The plan could not be read from here: open the session to see it._' : job.planText,
    },
  }))

  await focus($, `reply:${opened.draft}`)
}

async function toggleRepoMenu($: EngineInterface): Promise<void> {
  const shown = await update($, view, was => ({ ...was, isRepoMenuOpen: !was.isRepoMenuOpen, repoQuery: '' }))

  if (shown.isRepoMenuOpen) await focus($, 'repo-search')
}

async function pickRepo($: EngineInterface, path: string): Promise<void> {
  const shown = await update($, view, was => ({ ...was, repo: path, isRepoMenuOpen: false, repoQuery: '' }))

  await focus($, `prompt:${shown.draft}`)
}

/** Enter in the repo search: the first match, or the directory itself when a path to a repo was typed. */
async function searchRepo($: EngineInterface, query: string): Promise<void> {
  const typed = query.trim().replace(/\/+$/, '')
  const first = matchRepos(await read($, repos), typed)[0]

  if (typed.startsWith('/') && (await isRepo($, typed))) {
    await update($, repos, list => (list.some(repo => repo.path === typed) ? list : [...list, { path: typed, name: baseName(typed), uses: 0 }]))

    return pickRepo($, typed)
  }

  if (first !== undefined) return pickRepo($, first.path)

  await say($, `No repo matches "${typed}".`)
}

async function show($: EngineInterface, isAsked: boolean): Promise<void> {
  await $.ui.open(isAsked ? { ...OPEN, focus: true } : { id: PANE, title: TITLE })
  await load($)

  // The prompt takes the keys back as a slash command returns: the pane asks for them again once it has.
  if (isAsked) $.clock.after(RETAKE, () => void retake($))
}

async function retake($: EngineInterface): Promise<void> {
  await focus($, `prompt:${(await read($, view)).draft}`)
}

/** Opens the pane unasked once per session, so closing it by hand keeps it closed. */
async function showOnce($: EngineInterface): Promise<void> {
  if (await read($, isOpened)) return

  await update($, isOpened, () => true)
  await show($, false)
}

/** Keeps a pane the person is looking at current; a hidden one costs one call. */
async function tick($: EngineInterface): Promise<void> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)

  if (pane?.isShown === true && pane.isPlaced) await load($)
}

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Markdown'> & {
  Input: Elements['terminal']['Input'] | undefined
  Client: Elements['terminal']['Client'] | undefined
  /** The modifier that turns Enter into "start without a plan" on this surface, as its keyboard labels it. */
  modifier: string
}

const LOOK: Record<Job['state'], { glyph: string; tone: string; word: string }> = {
  plan: { glyph: '⏸', tone: 'planMode', word: 'plan ready' },
  needs: { glyph: '!', tone: 'warning', word: 'waiting for you' },
  working: { glyph: '⏺', tone: 'claude', word: 'working' },
  idle: { glyph: '◯', tone: 'inactive', word: 'idle' },
}

function metaOf(job: Job, now: number): string {
  return [
    baseName(job.repo),
    job.branch,
    job.isSelf ? 'this session' : job.kind === 'desktop' ? '' : job.kind,
    job.note === '' ? LOOK[job.state].word : job.note,
    age(now - job.since),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** What can be done with the jobs named: the row's context menu and the highlight's bar draw the same buttons. */
function actions($: EngineInterface, kit: Kit, at: string, ids: readonly string[], target: Job | undefined): RenderElement[] {
  const { Button } = kit
  const drawn: RenderElement[] = []

  if (ids.length === 1 && target !== undefined) {
    drawn.push(
      <Button
        key={`${at}:open`}
        plain
        label={target.state === 'plan' ? 'Read plan' : 'Open'}
        onPress={() => void press($, { id: target.id, button: 'left', isShift: false, isToggle: false })}
      />,
    )
  }

  if (ids.length > 1) {
    drawn.push(
      <Button key={`${at}:merge`} plain label={`Merge ${ids.length} into one session`} onPress={() => void merge($, ids, target?.id ?? '')} />,
    )
  }

  drawn.push(
    <Button key={`${at}:stop`} plain label={ids.length > 1 ? `Stop ${ids.length}` : 'Stop'} onPress={() => void stop($, ids)} />,
    <Button key={`${at}:archive`} plain label={ids.length > 1 ? `Archive ${ids.length}` : 'Archive'} onPress={() => void archive($, ids)} />,
    <Button
      key={`${at}:clear`}
      plain
      dimColor
      label={at === 'bar' ? 'Clear highlight' : 'Close'}
      onPress={() => void update($, view, shown => ({ ...shown, menu: '', selected: at === 'bar' ? [] : shown.selected }))}
    />,
  )

  return drawn
}

function rowOf($: EngineInterface, kit: Kit, job: Job, shown: View, now: number): RenderElement {
  const { Box, Text, Button, Client } = kit
  const look = LOOK[job.state]
  const isSelected = shown.selected.includes(job.id)
  const isMenuOpen = shown.menu === job.id
  const ids = isSelected ? shown.selected : [job.id]

  return (
    <Box key={`job:${job.id}`} flexDirection="column" width="100%">
      {Client === undefined ? (
        <Box flexDirection="row" width="100%" gap={1}>
          <Button
            key={`mark:${job.id}`}
            plain
            label={isSelected ? '✓' : '·'}
            onPress={() => void press($, { id: job.id, button: 'left', isShift: false, isToggle: true })}
          />
          <Text color={look.tone}>{look.glyph}</Text>
          <Button
            key={`open:${job.id}`}
            plain
            label={job.title}
            onPress={() => void press($, { id: job.id, button: 'left', isShift: false, isToggle: false })}
          />
          <Text dimColor wrap="truncate-end">
            {metaOf(job, now)}
          </Text>
          <Button
            key={`more:${job.id}`}
            plain
            dimColor
            label="⋯"
            onPress={() => void press($, { id: job.id, button: 'right', isShift: false, isToggle: false })}
          />
        </Box>
      ) : (
        <Client
          key={`row:${job.id}`}
          module="./row.tsx"
          width="100%"
          props={{ id: job.id, title: job.title, meta: metaOf(job, now), glyph: look.glyph, tone: look.tone, isSelected, isMenuOpen }}
        />
      )}
      {isMenuOpen && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={4}>
          {actions($, kit, 'menu', ids, job)}
        </Box>
      )}
    </Box>
  )
}

function repoPicker($: EngineInterface, kit: Kit, shown: View, known: readonly Repo[]): RenderElement {
  const { Box, Text, Button, Input } = kit
  const top = known.slice(0, 3)
  const chips = top.some(repo => repo.path === shown.repo) || shown.repo === '' ? top : [...top, { path: shown.repo, name: baseName(shown.repo), uses: 0 }]
  const others = matchRepos(known, shown.repoQuery).slice(0, 8)

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text dimColor>Start in</Text>
        {chips.map(repo => (
          <Button
            key={`repo:${repo.path}`}
            label={repo.name}
            variant={repo.path === shown.repo ? 'primary' : 'secondary'}
            dimColor={repo.path !== shown.repo}
            onPress={() => void pickRepo($, repo.path)}
          />
        ))}
        <Button
          key="repos"
          dimColor
          label={shown.isRepoMenuOpen ? 'Close' : 'Other repo…'}
          onPress={() => void toggleRepoMenu($)}
        />
      </Box>
      {shown.isRepoMenuOpen && (
        <Box flexDirection="column" width="100%" borderStyle="round" borderColor="promptBorder" paddingX={1}>
          {Input !== undefined && (
            <Input
              key="repo-search"
              placeholder="Search repos, or paste a path"
              submitLabel="pick"
              autoFocus
              onInput={value => void update($, view, was => ({ ...was, repoQuery: value }))}
              onSubmit={value => void searchRepo($, value)}
            />
          )}
          {others.length === 0 && <Text dimColor>No repo matches.</Text>}
          {others.map(repo => (
            <Box key={`found:${repo.path}`} flexDirection="row" columnGap={1}>
              <Button key={`pick:${repo.path}`} plain label={repo.name} onPress={() => void pickRepo($, repo.path)} />
              <Text dimColor wrap="truncate-start">
                {repo.path}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

function composer($: EngineInterface, kit: Kit, shown: View): RenderElement {
  const { Box, Text, Button, Input } = kit
  const repo = shown.repo === '' ? 'a repo' : baseName(shown.repo)

  if (Input === undefined) return <Text dimColor>Jobs are started from the desktop app or a terminal.</Text>

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor="promptBorder" paddingX={1}>
        <Input
          key={`prompt:${shown.draft}`}
          placeholder={`Start a job in ${repo}…`}
          submitLabel={shown.isPlanFirst ? 'plan first' : 'start'}
          autoFocus
          onInput={value => void edited($, value)}
          onSubmit={value => void start($, value, 'field')}
        />
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        <Text dimColor>{shown.isPlanFirst ? `↵ plans first · ${kit.modifier}↵ skips the plan` : '↵ starts right away'}</Text>
        <Button
          key="plan-first"
          plain
          dimColor
          label={shown.isPlanFirst ? 'Plan mode: on' : 'Plan mode: off'}
          onPress={() => void update($, view, was => ({ ...was, isPlanFirst: !was.isPlanFirst }))}
        />
        {shown.isPlanFirst && <Button key="start-now" plain dimColor label="Start without a plan" onPress={() => void start($, field.text, 'skip')} />}
      </Box>
    </Box>
  )
}

function listScreen(
  $: EngineInterface,
  kit: Kit,
  all: readonly Job[],
  waiting: readonly Queued[],
  known: readonly Repo[],
  shown: View,
  now: number,
  columns: number,
): RenderElement {
  const { Box, Text, Button } = kit
  const plans = all.filter(job => job.state === 'plan').length
  const picked = shown.selected.filter(id => all.some(job => job.id === id))

  return (
    <Box flexDirection="column" width={columns} rowGap={1}>
      <Box flexDirection="row" columnGap={2} alignItems="center">
        <Text bold color="claude">
          ✻ Jobs
        </Text>
        <Text dimColor>
          {all.length === 1 ? '1 session running' : `${all.length} sessions running`}
          {plans === 0 ? '' : ` · ${plans === 1 ? '1 plan' : `${plans} plans`} to approve`}
        </Text>
        <Button key="refresh" plain dimColor label="Refresh" onPress={() => void load($)} />
      </Box>
      {repoPicker($, kit, shown, known)}
      {composer($, kit, shown)}
      {shown.notice !== '' && <Text color="warning">{shown.notice}</Text>}
      {picked.length > 0 && shown.menu === '' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold>{picked.length} highlighted</Text>
          {actions($, kit, 'bar', picked, all.find(job => job.id === (picked.includes(shown.anchor) ? shown.anchor : picked[0])))}
        </Box>
      )}
      {GROUPS.map(group => {
        const members = all.filter(job => job.state === group.state)

        return (
          <Box key={`group:${group.state}`} flexDirection="column" width="100%">
            {members.length > 0 && (
              <Text bold color={LOOK[group.state].tone}>
                {group.title} <Text dimColor>{members.length}</Text>
              </Text>
            )}
            {members.map(job => rowOf($, kit, job, shown, now))}
            {group.state === 'plan' && waiting.length > 0 && (
              <Box flexDirection="column" width="100%" marginTop={members.length > 0 ? 1 : 0}>
                <Text bold color="suggestion">
                  Ready to start <Text dimColor>press the chip in the chat</Text>
                </Text>
                {waiting.map(one => (
                  <Box key={`queued:${one.taskId}`} flexDirection="row" columnGap={1}>
                    <Text color="suggestion">◌</Text>
                    <Text wrap="truncate-end">{one.title}</Text>
                    <Text dimColor>
                      {baseName(one.repo)}
                      {one.isPlan ? ' · plans first' : ''}
                    </Text>
                    <Button key={`withdraw:${one.taskId}`} plain dimColor label="Withdraw" onPress={() => void withdraw($, one.taskId)} />
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )
      })}
      {all.length === 0 && waiting.length === 0 && <Text dimColor>No session is running. Start one above.</Text>}
    </Box>
  )
}

function planScreen($: EngineInterface, kit: Kit, shown: View, columns: number): RenderElement | null {
  const { Box, Text, Button, Markdown, Input } = kit
  const detail = shown.detail

  if (detail === null) return null

  return (
    <Box flexDirection="column" width={columns} borderStyle="round" borderColor="planMode" paddingX={1} rowGap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text bold color="planMode">
          ⏸ Plan
        </Text>
        <Text bold wrap="truncate-end">
          {detail.title}
        </Text>
        <Button key="plan-close" plain dimColor label="Close" onPress={() => void update($, view, was => ({ ...was, detail: null }))} />
      </Box>
      {pieces(detail.text).map(piece => (
        <Markdown text={piece} />
      ))}
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor="promptBorder" paddingX={1}>
        {Input !== undefined && (
          <Input
            key={`reply:${shown.draft}`}
            placeholder="Write changes to the plan…"
            submitLabel="send"
            autoFocus
            onSubmit={value => void revise($, detail.jobId, value)}
          />
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        <Text dimColor>↵ sends the changes</Text>
        <Button
          key="plan-open"
          plain
          label="Open to approve"
          onPress={async () => {
            const job = (await read($, jobs)).find(one => one.id === detail.jobId)

            if (job !== undefined) await open($, job)
          }}
        />
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const opensInDesktop = options['openInDesktop'] !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jobs',
      description: 'Show every running session as a list of jobs, and start more',
    })
    $.clock.every(4000, () => void tick($))

    if (opensInDesktop && (await $.session.surfaces()).includes('desktop')) await showOnce($)

    return next(e)
  })

  // The desktop app connects after the session starts: that is the moment its side pane can take the pane.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)

    if (opensInDesktop && e.surface === 'desktop' && e.viewport?.isFullscreen !== false) await showOnce($)

    return attached
  })

  on('command.run', { command: 'jobs' }, async $ => {
    await show($, true)

    return { text: 'Jobs pane opened.' }
  })

  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const data: Record<string, unknown> = typeof e.data === 'object' && e.data !== null ? { ...e.data } : {}

    if (data['kind'] === 'row' && typeof data['id'] === 'string') {
      await press($, {
        id: data['id'],
        button: data['button'] === 'right' ? 'right' : 'left',
        isShift: data['isShift'] === true,
        isToggle: data['isToggle'] === true,
      })
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const base = $.ui.resolve(e)
    const kit: Kit = {
      Box: base.Box,
      Text: base.Text,
      Button: base.Button,
      Markdown: base.Markdown,
      Input: 'Input' in base ? base.Input : undefined,
      Client: 'Client' in base ? base.Client : undefined,
      modifier: e.surface === 'terminal' ? '⌥' : '⌘',
    }
    const { Box } = kit
    const shown = await read($, view)
    const columns = e.props.bodyColumns

    // Too narrow for the list and a plan side by side: the plan takes the pane and Close returns to the list.
    if (shown.detail !== null && columns < SIDE_BY_SIDE) {
      return (
        <Box flexDirection="column" alignItems="center" width="100%">
          {planScreen($, kit, shown, Math.min(columns, LIST_COLUMNS))}
        </Box>
      )
    }

    const side = shown.detail === null ? 0 : Math.min(SIDE_COLUMNS, columns - 66)
    const width = Math.min(LIST_COLUMNS, columns - (side === 0 ? 0 : side + 2))
    const [all, waiting, known, now] = await Promise.all([read($, jobs), read($, queued), read($, repos), $.clock.now()])

    return (
      <Box flexDirection="column" alignItems="center" width="100%">
        <Box flexDirection="row" columnGap={2}>
          {listScreen($, kit, all, waiting, known, shown, now, width)}
          {planScreen($, kit, shown, side)}
        </Box>
      </Box>
    )
  })
}
