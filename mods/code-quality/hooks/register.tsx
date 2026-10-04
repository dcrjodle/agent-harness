import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderSurface, Timer } from 'claude-code'

import type { Board, Repo, Routine, Suggestion } from '../types'

import { OPENERS, issueCommand, issueNumber, issueUrlIn, sessionLink, sessionPrompt } from './actions'
import { parseRepos } from './repos'
import type { Found } from './repos'
import { parseReport } from './report'
import { answerOf, listingOf, routineBody, scanTime } from './routines'
import type { Answer, Listing, Schedule } from './routines'
import { DOCK_COLUMNS, dashboard, issueKey, runKey } from './view'
import type { Actions } from './view'

const PANE = 'code-quality'
const TITLE = 'Code quality'
const COMMAND = 'quality'
const FRESH_MS = 10 * 60_000
const POLL_MS = 30_000
const POLL_LIMIT = 60
const PENDING_MS = 45 * 60_000
const CLOCK_SLACK_MS = 60_000

type Settings = { opensInDesktop: boolean; limit: number; hourUtc: number; model: string; environment: string }

const EMPTY: Board = { repos: [], loadedAt: 0, isLoading: false, notice: '' }

const board = atom({ plugin: 'code-quality', key: 'board' } as const, EMPTY)
const selected = atom({ plugin: 'code-quality', key: 'selected' } as const, null)
const issues = atom({ plugin: 'code-quality', key: 'issues' } as const, {})
const busy = atom({ plugin: 'code-quality', key: 'busy' } as const, [])
const isOpened = atom({ plugin: 'code-quality', key: 'isOpened' } as const, false)

const pending = new Map<string, number>()
let environment: string | null = null
let poll: Timer | null = null

function settingsOf(options: PluginOptions): Settings {
  const whole = (key: string, fallback: number, min: number, max: number): number => {
    const value = options[key]

    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
  }
  const word = (key: string, fallback: string): string => {
    const value = options[key]

    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }

  return {
    opensInDesktop: options['openInDesktop'] !== false,
    limit: whole('repos', 6, 1, 12),
    hourUtc: whole('scanHourUtc', 4, 0, 23),
    model: word('model', 'claude-sonnet-5-5'),
    environment: word('environmentId', ''),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRepo(value: unknown): value is Repo {
  if (!isRecord(value) || typeof value['slug'] !== 'string' || typeof value['root'] !== 'string') return false
  const { routine, report } = value

  return (routine === null || isRecord(routine)) && (report === null || (isRecord(report) && isRecord(report['scores']) && Array.isArray(report['suggestions'])))
}

function liveIssues(filed: Readonly<Record<string, string>>, repos: readonly Repo[]): Record<string, string> {
  const live = new Map(repos.flatMap(repo => (repo.report === null ? [] : [[repo.slug, repo.report.suggestions.map(one => one.id)] as const])))

  return Object.fromEntries(
    Object.entries(filed).filter(([key]) => {
      const cut = key.lastIndexOf('#')
      const ids = live.get(key.slice(0, cut))

      return ids === undefined || ids.includes(key.slice(cut + 1))
    }),
  )
}

async function keep($: EngineInterface): Promise<void> {
  const held = await read($, board)
  const filed = liveIssues(await read($, issues), held.repos)

  await update($, issues, () => filed)
  await $.store.set('board', { repos: held.repos, loadedAt: held.loadedAt })
  await $.store.set('issues', filed)
}

async function hydrate($: EngineInterface): Promise<void> {
  await update($, busy, () => [])
  if ((await read($, board)).repos.length > 0) {
    await update($, board, one => ({ ...one, isLoading: false }))

    return
  }
  const stored = await $.store.get('board')
  const filed = await $.store.get('issues')

  if (isRecord(stored) && Array.isArray(stored['repos'])) {
    const repos = (stored['repos'] as unknown[]).filter(isRepo)
    const loadedAt = typeof stored['loadedAt'] === 'number' ? stored['loadedAt'] : 0

    await update($, board, () => ({ ...EMPTY, repos, loadedAt }))
  }
  if (isRecord(filed)) {
    const urls = Object.entries(filed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')

    await update($, issues, () => Object.fromEntries(urls))
  }
}

type Call =
  | { action: 'list' }
  | { action: 'create'; body: Record<string, unknown> }
  | { action: 'run'; trigger_id: string }
  | { action: 'get_run_log'; session_id: string }

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

function triggerFailure(error: unknown): string {
  const reason = reasonOf(error, 'cloud routines are unavailable')

  return reason.includes('no tool named') ? 'cloud routines need a claude.ai login in this session' : reason
}

async function trigger($: EngineInterface, call: Call, consent?: string): Promise<Answer> {
  try {
    const answer = await $.tool.call({ tool: 'RemoteTrigger', ...call, ...(consent === undefined ? {} : { consent }) })

    if (answer.deny !== undefined) return { isOk: false, reason: answer.deny }
    if (answer.isError === true) return { isOk: false, reason: answer.text ?? 'the routine API call failed' }

    return answerOf(answer.result)
  } catch (error) {
    return { isOk: false, reason: triggerFailure(error) }
  }
}

async function listRoutines($: EngineInterface): Promise<Listing | { error: string }> {
  const answer = await trigger($, { action: 'list' })

  return answer.isOk ? listingOf(answer.body) : { error: answer.reason }
}

async function createRoutine($: EngineInterface, slug: string, schedule: Schedule): Promise<string | null> {
  const answer = await trigger(
    $,
    { action: 'create', body: routineBody(slug, schedule, crypto.randomUUID()) },
    `The user pressed "Schedule daily scan" for ${slug} in the Code quality pane and confirmed creating its daily cloud routine.`,
  )

  return answer.isOk ? null : answer.reason
}

async function runRoutine($: EngineInterface, slug: string, id: string): Promise<string | null> {
  const answer = await trigger(
    $,
    { action: 'run', trigger_id: id },
    `The user pressed "Scan now" for ${slug} in the Code quality pane.`,
  )

  return answer.isOk ? null : answer.reason
}

async function runLog($: EngineInterface, session: string): Promise<string | null> {
  const answer = await trigger($, { action: 'get_run_log', session_id: session })

  return answer.isOk ? answer.summary : null
}

async function recentRepos($: EngineInterface, limit: number): Promise<Found[]> {
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/recent-repos`], { timeoutMs: 20_000 })

    return ran.exitCode === 0 ? parseRepos(ran.stdout, limit) : []
  } catch {
    return []
  }
}

async function fileIssue($: EngineInterface, slug: string, suggestion: Suggestion): Promise<{ url: string } | { error: string }> {
  try {
    const ran = await $.process.run(issueCommand(slug, suggestion), { timeoutMs: 60_000 })
    const url = issueUrlIn(ran.stdout)

    if (ran.exitCode === 0 && url !== null) return { url }

    return { error: ran.stderr.trim().split('\n')[0] || 'gh did not return an issue link' }
  } catch (error) {
    return { error: reasonOf(error, 'gh could not start') }
  }
}

async function openLink($: EngineInterface, link: string): Promise<boolean> {
  for (const opener of OPENERS) {
    try {
      const ran = await $.process.run([...opener, link], { timeoutMs: 10_000 })

      if (ran.exitCode === 0) return true
    } catch {
      continue
    }
  }

  return false
}

async function startSession(
  $: EngineInterface,
  repo: Repo,
  suggestion: Suggestion,
  issueUrl: string | null,
  surface: RenderSurface,
): Promise<string> {
  const prompt = sessionPrompt(suggestion, issueUrl)
  const isHere = (await $.session.repo())?.root === repo.root
  const fill = async (): Promise<string> =>
    (await $.prompt.fill({ text: prompt })).isFilled
      ? 'Suggestion placed in the prompt box'
      : 'Could not start a session from here'

  if (surface !== 'desktop' && isHere) return fill()
  if (await openLink($, sessionLink(repo.root, prompt))) return `New session drafted in ${repo.slug}`

  return isHere ? fill() : `Open a session in ${repo.root} to start this one`
}

function settle(slug: string, routine: Routine, now: number): Routine {
  const startedAt = pending.get(slug)

  if (startedAt === undefined) return routine
  const isSeen = routine.run !== null && Date.parse(routine.run.at ?? '') >= startedAt - CLOCK_SLACK_MS

  if ((isSeen && routine.run?.status !== 'running') || now - startedAt > PENDING_MS) {
    pending.delete(slug)

    return routine
  }

  return isSeen ? routine : { ...routine, run: { session: '', status: 'running', at: new Date(startedAt).toISOString() } }
}

async function scored($: EngineInterface, repo: Repo, listed: Routine | null, now: number): Promise<Repo> {
  const routine = listed === null ? null : settle(repo.slug, listed, now)
  const run = routine?.run ?? null

  if (run === null || run.status !== 'succeeded' || repo.report?.run === runKey(run)) return { ...repo, routine }
  const log = await runLog($, run.session)
  const report = log === null ? null : parseReport(log, runKey(run), run.at)

  return { ...repo, routine, report: report ?? repo.report }
}

async function load($: EngineInterface, settings: Settings, isForced: boolean): Promise<void> {
  const held = await read($, board)
  const now = await $.clock.now()

  if (held.isLoading || (!isForced && now - held.loadedAt < FRESH_MS)) return
  await update($, board, one => ({ ...one, isLoading: true }))
  let repos = held.repos
  let notice = ''

  try {
    const known = new Map(held.repos.map(repo => [repo.slug, repo]))
    const found = await recentRepos($, settings.limit)

    if (found.length > 0 || held.repos.length === 0) {
      repos = found.map(one => ({
        ...one,
        routine: known.get(one.slug)?.routine ?? null,
        report: known.get(one.slug)?.report ?? null,
      }))
      await update($, board, one => ({ ...one, repos }))
    }
    const listed = await listRoutines($)

    if ('error' in listed) {
      notice = `Scans unavailable: ${listed.error}`
    } else {
      environment = listed.environment
      repos = await Promise.all(repos.map(repo => scored($, repo, listed.routines.get(repo.slug) ?? null, now)))
    }
  } catch (error) {
    notice = reasonOf(error, 'Could not refresh')
  }
  await update($, board, () => ({ repos, loadedAt: now, isLoading: false, notice }))
  await keep($)
}

function watch($: EngineInterface, settings: Settings): void {
  let ticks = 0

  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => {
    ticks++
    void load($, settings, true).then(() => {
      if (pending.size > 0 && ticks < POLL_LIMIT) return
      poll?.cancel()
      poll = null
    })
  })
}

async function say($: EngineInterface, text: string): Promise<void> {
  if (text === '') return
  $.ui.toast(text)
  await update($, board, one => ({ ...one, notice: text }))
}

async function act($: EngineInterface, marker: string, work: () => Promise<string>): Promise<void> {
  if ((await read($, busy)).includes(marker)) return
  await update($, busy, list => [...list, marker])
  let outcome = ''

  try {
    outcome = await work()
  } catch (error) {
    outcome = reasonOf(error, 'Something went wrong')
  }
  await update($, busy, list => list.filter(one => one !== marker))
  await say($, outcome)
}

async function scheduleScan($: EngineInterface, settings: Settings, repo: Repo): Promise<string> {
  const listed = await listRoutines($)

  if ('error' in listed) return `Could not schedule ${repo.slug}: ${listed.error}`
  if (!listed.routines.has(repo.slug)) {
    const target = settings.environment === '' ? listed.environment : settings.environment

    if (target === null) {
      return 'No cloud environment known: set one under code-quality in /config, or create any routine at claude.ai/code/routines first'
    }
    const answer = await $.ui
      .ask(`Create a cloud routine that scans ${repo.slug} every day at ${scanTime(repo.slug, settings.hourUtc)}?`, ['Schedule', 'Cancel'])
      .catch(() => 'Cancel')

    if (answer !== 'Schedule') return ''
    const failure = await createRoutine($, repo.slug, { environment: target, hourUtc: settings.hourUtc, model: settings.model })

    if (failure !== null) return `Could not schedule ${repo.slug}: ${failure}`
  }
  await load($, settings, true)

  return `Daily scan scheduled for ${repo.slug}`
}

async function scanNow($: EngineInterface, settings: Settings, repo: Repo): Promise<string> {
  if (repo.routine === null) return ''
  const failure = await runRoutine($, repo.slug, repo.routine.id)

  if (failure !== null) return `Could not scan ${repo.slug}: ${failure}`
  pending.set(repo.slug, await $.clock.now())
  await load($, settings, true)
  watch($, settings)

  return `Scanning ${repo.slug}`
}

async function fileOnce($: EngineInterface, repo: Repo, suggestion: Suggestion): Promise<{ url: string } | { error: string }> {
  const key = issueKey(repo, suggestion)
  const held = (await read($, issues))[key]

  if (held !== undefined) return { url: held }
  const filed = await fileIssue($, repo.slug, suggestion)

  if ('error' in filed) return { error: `Could not create the issue: ${filed.error}` }
  await update($, issues, map => ({ ...map, [key]: filed.url }))
  await $.store.set('issues', await read($, issues))

  return filed
}

async function openPane($: EngineInterface, settings: Settings, isAsked: boolean): Promise<void> {
  await update($, isOpened, () => true)
  await $.ui.open({ id: PANE, title: TITLE, rows: 30, columns: DOCK_COLUMNS, ...(isAsked ? { focus: true as const } : {}) })
  void load($, settings, false)
}

function actionsOf($: EngineInterface, settings: Settings): Actions {
  const file = async (repo: Repo, suggestion: Suggestion, surface: RenderSurface | null): Promise<string> => {
    const filed = await fileOnce($, repo, suggestion)

    if ('error' in filed) return filed.error
    if (surface === null) return `Issue ${issueNumber(filed.url)} created in ${repo.slug}`

    return startSession($, repo, suggestion, filed.url, surface)
  }

  return {
    open: slug => void update($, selected, () => slug),
    refresh: () => void load($, settings, true),
    schedule: repo => void act($, `schedule:${repo.slug}`, () => scheduleScan($, settings, repo)),
    scan: repo => void act($, `scan:${repo.slug}`, () => scanNow($, settings, repo)),
    issue: (repo, suggestion) => void act($, `issue:${issueKey(repo, suggestion)}`, () => file(repo, suggestion, null)),
    session: (repo, suggestion, surface) =>
      void act($, `session:${issueKey(repo, suggestion)}`, () =>
        startSession($, repo, suggestion, null, surface),
      ),
    both: (repo, suggestion, surface) =>
      void act($, `issue:${issueKey(repo, suggestion)}`, () => file(repo, suggestion, surface)),
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Open the code quality dashboard' })
    await hydrate($)
    if (settings.opensInDesktop && !(await read($, isOpened)) && (await $.session.surfaces()).includes('desktop')) {
      await openPane($, settings, false)
    }

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)

    if (settings.opensInDesktop && e.surface === 'desktop' && e.viewport?.isFullscreen !== false && !(await read($, isOpened))) {
      await openPane($, settings, false)
    }

    return attached
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($, settings, true)

    return { text: 'Code quality pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const shown = await read($, board)
    const pick = await read($, selected)

    return dashboard(
      $.ui.resolve(e),
      {
        board: shown,
        repo: shown.repos.find(one => one.slug === pick) ?? null,
        issues: await read($, issues),
        busy: await read($, busy),
        now: await $.clock.now(),
        columns: e.props.bodyColumns,
      },
      actionsOf($, settings),
    )
  })
}
