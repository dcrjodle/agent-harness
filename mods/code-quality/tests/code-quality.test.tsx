import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { issueBody, sessionLink, sessionPrompt } from '../hooks/actions'
import { parseRepos } from '../hooks/repos'
import { fingerprint, parseReport, scanPrompt } from '../hooks/report'
import { scanMinute } from '../hooks/routines'
import type { Suggestion } from '../types'

const PLUGIN = 'code-quality'
const NOW = Date.parse('2026-10-04T10:00:00Z')
const HARNESS = 'dcrjodle/agent-harness'
const WIDGETS = 'acme/widgets'
const ROOT = '/work/harness'
const ISSUE = 'https://github.com/dcrjodle/agent-harness/issues/12'
const REPOS = `${WIDGETS}\t/work/widgets\t1789000000\n${HARNESS}\t${ROOT}\t1790000000\n`

const SHIP: Suggestion = {
  id: fingerprint('tests|Add tests for the ship gate'),
  dimension: 'tests',
  severity: 'high',
  title: 'Add tests for the ship gate',
  why: 'Nothing covers the refusal path, so a regression ships silently.',
  paths: ['bin/task-ship'],
}
const SETUP: Suggestion = {
  id: fingerprint('maintainability|Split setup.sh by tool'),
  dimension: 'maintainability',
  severity: 'low',
  title: 'Split setup.sh by tool',
  why: 'One script wires three tools; a change to one risks the others.',
  paths: ['setup.sh'],
}

const record = (suggestion: Suggestion, code: string): string =>
  JSON.stringify({ cq: 1, k: 'fix', d: code, v: suggestion.severity, t: suggestion.title, w: suggestion.why, p: suggestion.paths })

const LOG = [
  '(content from remote routine runs)',
  '[2026-10-03T04:19:00Z] tool_result: {"cq":1,"k":"scores","m":50,"r":50,"s":50,"t":50}',
  '[2026-10-03T04:19:01Z] tool_result: {"cq":1,"k":"fix","d":"m","v":"low","t":"Yesterday","w":"Old.","p":[]}',
  `[2026-10-04T04:12:30Z] user: ${scanPrompt(HARNESS).replace(/\s+/g, ' ')}`,
  '[2026-10-04T04:19:00Z] tool_use Bash: {"command":"cat > /tmp/cq.jsonl <<\'EOF\'\\n{\\"cq\\":1,\\"k\\":\\"scores\\",\\"m\\":1,\\"r\\":1,\\"s\\":1,\\"t\\":1}"}',
  '[2026-10-04T04:19:10Z] tool_result: {"cq":1,"k":"scores","m":78,"r":64,"s":80,"t":41}',
  `[2026-10-04T04:19:11Z] tool_result: ${record(SHIP, 't')}`,
  '[2026-10-04T04:19:12Z] tool_result: {"cq":1,"k":"fix","d":"s","v":"medium","t":"Quote paths in the guard","w":"Unquoted… [+120 chars]',
  '[2026-10-04T04:19:13Z] tool_result: {"cq":1,"k":"fix","d":"x","v":"medium","t":"Unknown dimension","w":"Dropped.","p":[]}',
  `[2026-10-04T04:19:14Z] tool_result: ${record(SETUP, 'm')}`,
  '[2026-10-04T04:19:20Z] result: success is_error=false turns=30 duration=400s — Scored.',
].join('\n')

const ROUTINES = {
  data: [
    { id: 'trig_other', name: 'Weekly Newsletter', enabled: true, job_config: { ccr: { environment_id: 'env_test' } } },
    {
      id: 'trig_harness',
      name: `code-quality: ${HARNESS}`,
      enabled: true,
      next_run_at: '2026-10-05T04:12:00Z',
      last_run: {
        session_id: 'cse_scan',
        status: 'ROUTINE_RUN_STATUS_SUCCEEDED',
        fired_at: '2026-10-04T04:12:00Z',
        finished_at: '2026-10-04T04:20:00Z',
      },
    },
  ],
}

const questionOf = (questions: unknown): string => {
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined

  return typeof first === 'object' && first !== null && 'question' in first && typeof first.question === 'string'
    ? first.question
    : ''
}

type World = { runs: string[][]; triggers: Record<string, unknown>[]; fills: string[]; answer: string; here: string | null }

function world(on: On): World {
  const seen: World = { runs: [], triggers: [], fills: [], answer: 'Schedule', here: null }

  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', (_$, e) => {
    const command = e.argv[0] ?? ''

    seen.runs.push([...e.argv])

    return {
      value: {
        exitCode: 0,
        stdout: command.endsWith('/bin/recent-repos') ? REPOS : command === 'gh' ? `${ISSUE}\n` : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', { tool: 'RemoteTrigger' }, (_$, e) => {
    seen.triggers.push({ ...e })
    if (e.action === 'get_run_log') return { result: { status: 200, json: '{}', summary: LOG } }

    return { result: { status: 200, json: JSON.stringify(e.action === 'list' ? ROUTINES : {}) } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({
    result: { questions: e.questions, answers: { [questionOf(e.questions)]: seen.answer } },
  }))
  on('session.repo', () => ({
    value: seen.here === null ? null : { root: seen.here, remote: null, internal: false, name: null },
  }))
  on('prompt.fill', (_$, e) => {
    seen.fills.push(e.text)

    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))

  return seen
}

const pane = (columns: number) => ({
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: PLUGIN,
  props: {
    title: 'Code quality',
    isFocused: false,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns, rows: 50 },
})

test('a report is the newest scan in the log, without what the log cut or the agent got wrong', () => {
  const report = parseReport(LOG, 'cse_scan@done', '2026-10-04T04:20:00Z')

  expect(report?.scores).toEqual({ maintainability: 78, reliability: 64, security: 80, tests: 41 })
  expect(report?.suggestions).toEqual([SHIP, SETUP])
  expect(parseReport(LOG.split('\n').slice(3, 5).join('\n'), 'run', null)).toBe(null)
})

test('recent repos come newest first and capped', () => {
  expect(parseRepos(REPOS, 5).map(repo => repo.slug)).toEqual([HARNESS, WIDGETS])
  expect(parseRepos(REPOS, 1)).toEqual([{ slug: HARNESS, root: ROOT, usedAt: 1790000000000 }])
})

test('an issue says why and where and nothing else', () => {
  expect(issueBody(SHIP)).toBe('Nothing covers the refusal path, so a regression ships silently.\n\n`bin/task-ship`')
  expect(issueBody({ ...SHIP, paths: [] })).toBe(SHIP.why)
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`${surface}: each repo is four squares with a bar, and a press opens its suggestions`, async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...pane(100), surface })

    await ui.press({ key: 'refresh' })
    for (const label of ['Maintainable', 'Reliable', 'Secure', 'Tested']) {
      expect(await ui.findAll({ type: 'Text', text: label })).toHaveLength(2)
    }
    for (const value of ['78', '64', '80', '41']) expect(await ui.find({ type: 'Text', text: value })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^█+$/ })).toHaveLength(4)
    expect((await ui.find({ key: `open:${HARNESS}` }))?.props['label']).toBe('agent-harness')
    expect(await ui.find({ type: 'Text', text: /2 suggestions/ })).toBeDefined()
    expect((await ui.find({ key: `schedule:${WIDGETS}` }))?.props['label']).toBe('Schedule daily scan')
    expect(await ui.find({ key: 'close' })).toBeUndefined()

    await ui.press({ key: `open:${HARNESS}` })
    expect((await ui.find({ key: 'close' }))?.props['label']).toBe('Close')
    expect(await ui.find({ key: `open:${WIDGETS}` })).toBeDefined()
    for (const suggestion of [SHIP, SETUP]) {
      expect(await ui.find({ type: 'Text', text: suggestion.title })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: suggestion.why })).toBeDefined()
      for (const action of ['issue', 'session', 'both']) expect(await ui.find({ key: `${action}:${suggestion.id}` })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: 'bin/task-ship' })).toBeDefined()

    await ui.press({ key: 'close' })
    expect(await ui.find({ key: 'close' })).toBeUndefined()
    await ui.unmount()
  })
}

test('a narrow pane shows the panel in place of the tiles, with a way back', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...pane(60), surface: 'desktop' })

  await ui.press({ key: 'refresh' })
  await ui.press({ key: `open:${HARNESS}` })
  expect((await ui.find({ key: 'close' }))?.props['label']).toBe('All repos')
  expect(await ui.find({ key: `open:${WIDGETS}` })).toBeUndefined()
  await ui.press({ key: 'close' })
  expect(await ui.find({ key: `open:${WIDGETS}` })).toBeDefined()
})

test('desktop: Issue files a terse issue, Session drafts a new session, Both links them', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ ...pane(100), surface: 'desktop' })

  await ui.press({ key: 'refresh' })
  await ui.press({ key: `open:${HARNESS}` })
  await ui.press({ key: `issue:${SHIP.id}` })
  expect(seen.runs).toContainEqual(['gh', 'issue', 'create', '--repo', HARNESS, '--title', SHIP.title, '--body', issueBody(SHIP)])
  expect((await ui.findAll({ type: 'Link' })).map(link => link.props['href'])).toContain(ISSUE)
  expect(await ui.find({ key: `issue:${SHIP.id}` })).toBeUndefined()
  expect(await ui.find({ key: `both:${SHIP.id}` })).toBeUndefined()

  await ui.press({ key: `session:${SHIP.id}` })
  expect(seen.runs).toContainEqual(['open', sessionLink(ROOT, sessionPrompt(SHIP, null))])

  await ui.press({ key: `both:${SETUP.id}` })
  expect(seen.runs.filter(run => run[0] === 'gh')).toHaveLength(2)
  expect(seen.runs.at(-1)).toEqual(['open', sessionLink(ROOT, sessionPrompt(SETUP, ISSUE))])
  expect(sessionPrompt(SETUP, ISSUE).endsWith(`Closes ${ISSUE}`)).toBe(true)
  expect(seen.fills).toEqual([])
})

test('terminal: Session fills the prompt box when the session is in that repo', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ ...pane(100), surface: 'terminal' })

  seen.here = ROOT
  await ui.press({ key: 'refresh' })
  await ui.press({ key: `open:${HARNESS}` })
  await ui.press({ key: `session:${SHIP.id}` })
  expect(seen.fills).toEqual([sessionPrompt(SHIP, null)])
  expect(seen.runs.some(run => run[0] === 'open')).toBe(false)
})

test('Schedule creates one daily routine per repo, only after a yes', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ ...pane(100), surface: 'desktop' })
  const created = (): Record<string, unknown>[] => seen.triggers.filter(call => call['action'] === 'create')

  await ui.press({ key: 'refresh' })
  seen.answer = 'Cancel'
  await ui.press({ key: `schedule:${WIDGETS}` })
  expect(created()).toHaveLength(0)

  seen.answer = 'Schedule'
  await ui.press({ key: `schedule:${WIDGETS}` })
  expect(created()).toHaveLength(1)
  expect(created()[0]?.['body']).toMatchObject({
    name: `code-quality: ${WIDGETS}`,
    cron_expression: `${scanMinute(WIDGETS)} 4 * * *`,
    enabled: true,
    job_config: {
      ccr: {
        environment_id: 'env_test',
        session_context: {
          model: 'claude-sonnet-5-5',
          sources: [{ git_repository: { url: `https://github.com/${WIDGETS}` } }],
        },
        events: [{ data: { type: 'user', message: { role: 'user', content: scanPrompt(WIDGETS) } } }],
      },
    },
  })
})

test('Scan now runs the routine the repo already has', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ ...pane(100), surface: 'desktop' })

  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: `schedule:${HARNESS}` })).toBeUndefined()
  await ui.press({ key: `open:${HARNESS}` })
  await ui.press({ key: `scan:${HARNESS}` })
  expect(seen.triggers.filter(call => call['action'] === 'run')).toMatchObject([{ trigger_id: 'trig_harness' }])
  expect(seen.triggers.some(call => call['action'] === 'create')).toBe(false)
  expect(await ui.findAll({ type: 'Text', text: 'Scanning…' })).toHaveLength(2)
})
