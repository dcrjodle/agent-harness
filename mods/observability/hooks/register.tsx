// The Observability mod: a pane over what the harness hooks push to bin/observe.
// It lists sessions, draws one session's agents as a graph of who spawned whom, shows a node's cost, time
// and status, and saves a session as JSON. It adds one thing the shell hooks cannot see: the engine's own
// token totals for every turn of every agent, pushed to the same endpoint.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, TurnCompleteInput } from 'claude-code'

import type { AgentNode, Detail, Session, View } from '../types'

import { clip, clock, count, day, duration, money, place, tone } from './format'
import { graph, tree } from './graph'

const PANE = 'observability'
const TITLE = 'Observability'
const PAGE = 30
const SELECTED = '#7aa2f7'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const sessions = atom({ plugin: 'observability', key: 'sessions' } as const, [])
const detail = atom({ plugin: 'observability', key: 'detail' } as const, null)
const view = atom({ plugin: 'observability', key: 'view' } as const, { session: null, node: null, limit: PAGE })
const notice = atom({ plugin: 'observability', key: 'notice' } as const, '')
const isOpened = atom({ plugin: 'observability', key: 'isOpened' } as const, false)

// What the store looked like and what the endpoint last answered, so an unchanged store redraws nothing.
let store: string | null = null
let stamp = ''
let lastList = ''
let lastDetail = ''

/** Runs the endpoint. Null when it fails: a broken store must never break a session. */
async function observe($: EngineInterface, args: readonly string[], stdin?: string): Promise<string | null> {
  try {
    const ran = await $.process.run([`${$.plugin.root}/bin/observe`, ...args], {
      timeoutMs: 20_000,
      ...(stdin === undefined ? {} : { stdin }),
    })

    return ran.exitCode === 0 ? ran.stdout : null
  } catch {
    return null
  }
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Reads the session list, and the open session's graph, into the values the pane draws from. */
async function load($: EngineInterface): Promise<void> {
  const shown = await read($, view)
  const listed = await observe($, ['list', String(shown.limit)])

  if (listed !== null && listed !== lastList) {
    const list = parse<Session[]>(listed)

    if (list !== null) {
      lastList = listed
      await update($, sessions, () => list)
    }
  }

  if (shown.session === null) return

  const exported = (await observe($, ['export', shown.session, '--no-events'])) ?? ''

  if (exported !== lastDetail) {
    lastDetail = exported
    await update($, detail, () => parse<Detail>(exported))
  }
}

/** True when the store changed since the last look: how many files, the newest write, the bytes in all. */
async function hasNews($: EngineInterface): Promise<boolean> {
  store ??= (await observe($, ['dir']))?.trim() ?? null

  if (store === null) return false

  const files = await $.fs.list(store).catch(() => [])
  const now = `${files.length}:${Math.max(0, ...files.map(file => file.mtimeMs))}:${files.reduce((sum, file) => sum + file.size, 0)}`

  if (now === stamp) return false

  stamp = now

  return true
}

/** Keeps a pane the person is looking at current; a hidden one costs one call. */
async function tick($: EngineInterface): Promise<void> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)

  if (pane?.isShown === true && pane.isPlaced && (await hasNews($))) await load($)
}

/** Asked for by the person, the pane takes the keyboard and, where it sits above the prompt, room for a graph. */
async function open($: EngineInterface, isAsked: boolean): Promise<void> {
  await $.ui.open(isAsked ? { id: PANE, title: TITLE, focus: true, rows: 28 } : { id: PANE, title: TITLE })
  await load($)
}

/** Opens the pane unasked once per session, so closing it by hand keeps it closed. */
async function openOnce($: EngineInterface): Promise<void> {
  if (await read($, isOpened)) return

  await update($, isOpened, () => true)
  await open($, false)
}

/** Shows one session's graph, or the list again for null. */
async function show($: EngineInterface, session: string | null): Promise<void> {
  lastDetail = ''
  await update($, notice, () => '')
  await update($, detail, () => null)
  await update($, view, shown => ({ ...shown, session, node: session === null ? null : 'main' }))
  await load($)
}

async function pick($: EngineInterface, node: string): Promise<void> {
  await update($, view, shown => ({ ...shown, node }))
}

async function more($: EngineInterface): Promise<void> {
  await update($, view, shown => ({ ...shown, limit: shown.limit + PAGE }))
  await load($)
}

/** Saves the whole session, raw events included, where downloads go. */
async function save($: EngineInterface, session: string): Promise<void> {
  const home = await $.env.get('HOME')
  const name = `Downloads/observability-${session}.json`
  const saved = await observe($, ['export', session, '-o', `${home ?? '.'}/${name}`])
  const said = saved === null ? 'Could not save the export.' : `Saved ${home === undefined ? name : `~/${name}`}`

  await update($, notice, () => said)
  $.ui.toast(said)
}

/** Pushes what the engine counted for one finished turn of any agent: exact tokens, duration and why it ended. */
async function report($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const usage = e.usage
  const cost = (await $.session.usage()).cost?.usd

  await observe(
    $,
    ['push'],
    JSON.stringify({
      session: await $.session.id(),
      event: 'turn',
      agent: e.agentId,
      cwd: await $.session.cwd(),
      turn_id: e.turnId,
      reason: e.reason,
      duration_ms: e.durationMs,
      usage:
        usage === undefined
          ? undefined
          : {
              model: usage.model,
              input: usage.input_tokens,
              output: usage.output_tokens,
              cache_read: usage.cache_read_input_tokens,
              cache_write: usage.cache_creation_input_tokens,
            },
      session_cost_usd: cost,
    }),
  )
}

function listScreen($: EngineInterface, { Box, Text, Button }: Kit, list: readonly Session[], shown: View, columns: number): RenderElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold>{TITLE}</Text>
        <Text dimColor>sessions, latest activity first</Text>
        <Button key="refresh" label="Refresh" onPress={() => void load($)} />
      </Box>
      {list.length === 0 && (
        <Text dimColor>No sessions recorded yet. The harness hooks report every session once ./setup.sh has wired them.</Text>
      )}
      {list.map(one => (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={tone(one.status)}>●</Text>
            <Button
              key={`session:${one.id}`}
              label={clip(one.title ?? place(one.cwd), Math.max(16, columns - 6))}
              plain
              onPress={() => void show($, one.id)}
            />
          </Box>
          <Text dimColor wrap="truncate-end">
            {`  ${day(one.last_at)} · ${place(one.cwd)} · ${one.agents} agent${one.agents === 1 ? '' : 's'} · ${money(one.cost_usd)} · ${one.status}`}
          </Text>
        </Box>
      ))}
      {list.length >= shown.limit && (
        <Box marginTop={1}>
          <Button key="more" label="Show more" onPress={() => void more($)} />
        </Box>
      )}
    </Box>
  )
}

function fact({ Box, Text }: Kit, name: string, value: string): RenderElement {
  return (
    <Box flexDirection="row">
      <Box width={8} flexShrink={0}>
        <Text dimColor>{name}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )
}

function nodeName(node: AgentNode): string {
  return node.kind === 'session' ? 'session' : node.type
}

/** Everything known about one agent: what a press on its node shows. */
function nodeCard(kit: Kit, node: AgentNode, nodes: readonly AgentNode[]): RenderElement {
  const { Box, Text } = kit
  const parent = nodes.find(one => one.id === node.parent)
  const { tokens } = node
  const cost = [
    money(node.cost_usd),
    node.output_exact ? 'estimate at list prices' : 'at least: this transcript lacks final output counts',
    ...(node.unpriced.length === 0 ? [] : [`no price for ${node.unpriced.join(', ')}`]),
  ].join(' · ')
  const tools = node.tool_uses === null ? `${node.tool_errors} failed` : `${node.tool_uses} calls · ${node.tool_errors} failed`

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text bold>{node.description === null ? nodeName(node) : `${nodeName(node)} · ${clip(node.description, 80)}`}</Text>
      {fact(kit, 'Status', node.runs > 1 ? `${node.status} · ${node.runs} runs` : node.status)}
      {fact(kit, 'Cost', cost)}
      {fact(kit, 'Time', `${duration(node.active_ms)} active · ${clock(node.started_at)} → ${node.ended_at === null ? 'now' : clock(node.ended_at)}`)}
      {fact(kit, 'Model', node.models.length === 0 ? 'not reported yet' : node.models.join(', '))}
      {fact(kit, 'Tokens', `${count(tokens.input)} in · ${count(tokens.cache_read)} cache read · ${count(tokens.cache_write)} cache write · ${count(tokens.output)} out`)}
      {fact(kit, 'Tools', tools)}
      {parent !== undefined && fact(kit, 'Parent', `spawned by ${nodeName(parent)}`)}
      {node.last_message !== null && fact(kit, 'Last', clip(node.last_message, 300))}
    </Box>
  )
}

function sessionScreen(
  $: EngineInterface,
  kit: Kit,
  one: Detail,
  shown: View,
  note: string,
  picture: RenderElement | null,
  columns: number,
): RenderElement {
  const { Box, Text, Button } = kit
  const { session, nodes } = one
  const selected = nodes.find(node => node.id === shown.node) ?? nodes[0]
  const who = (id: string): string => {
    const node = nodes.find(candidate => candidate.id === id)

    return node === undefined ? id : nodeName(node)
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text bold>{TITLE}</Text>
        <Button key="back" label="Sessions" onPress={() => void show($, null)} />
        <Button key="refresh" label="Refresh" onPress={() => void load($)} />
        <Button key="download" label="Download JSON" variant="primary" onPress={() => void save($, session.id)} />
      </Box>
      {note !== '' && <Text color={SELECTED}>{note}</Text>}
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="truncate-end">
          {session.title ?? place(session.cwd)}
        </Text>
        <Text dimColor wrap="truncate-end">{`${session.status} · ${day(session.started_at)} · ${place(session.cwd)}`}</Text>
        <Text>
          {`${money(session.cost_usd)}${session.cost_source === 'estimate' ? ' estimated' : ''} · ${duration(session.active_ms)} active · ${count(session.tokens.total)} tokens`}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{`Agents (${session.agents})`}</Text>
      </Box>
      {picture}
      {tree(nodes).map(({ node, lead }) => (
        <Box flexDirection="row">
          <Text dimColor>{lead}</Text>
          <Text color={tone(node.status)}>{'● '}</Text>
          <Button
            key={`node:${node.id}`}
            label={clip(node.description === null ? nodeName(node) : `${nodeName(node)} · ${node.description}`, Math.max(12, columns - lead.length - 24))}
            plain
            dimColor={node.id !== selected?.id}
            onPress={() => void pick($, node.id)}
          />
          <Text dimColor>{node.status === 'running' ? '  running' : `  ${money(node.cost_usd)} · ${duration(node.active_ms)}`}</Text>
          {node.id === selected?.id && <Text color={SELECTED}>{' ◀'}</Text>}
        </Box>
      ))}
      {selected !== undefined && nodeCard(kit, selected, nodes)}
      {one.messages.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{`Messages (${one.messages.length})`}</Text>
          {one.messages.slice(-20).map(message => (
            <Box flexDirection="column">
              <Text dimColor>{`${message.kind} · ${who(message.agent)} · ${clock(message.ts)}`}</Text>
              <Box paddingLeft={2}>
                <Text>{clip(message.text, 400)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      {one.errors.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{`Errors (${one.errors.length})`}</Text>
          {one.errors.slice(-20).map(failure => (
            <Box flexDirection="column">
              <Text dimColor>{`${failure.tool ?? 'turn'} · ${who(failure.agent)} · ${clock(failure.ts)}`}</Text>
              <Box paddingLeft={2}>
                <Text>{clip(failure.error, 300)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const opensInDesktop = options['openInDesktop'] !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'observability',
      description: 'Show sessions, their agents as a graph, cost and messages in a pane',
    })
    $.clock.every(4000, () => void tick($))

    if (opensInDesktop && (await $.session.surfaces()).includes('desktop')) await openOnce($)

    return next(e)
  })

  // The desktop app connects after the session starts: that is the moment its side pane can take the pane.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)

    if (opensInDesktop && e.surface === 'desktop' && e.viewport?.isFullscreen !== false) await openOnce($)

    return attached
  })

  on('command.run', { command: 'observability' }, async $ => {
    await open($, true)

    return { text: 'Observability pane opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    // Reporting must never cost the turn its answer.
    await report($, e).catch(() => undefined)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const { Box, Text, Button } = kit
    const shown = await read($, view)
    const columns = e.props.bodyColumns

    if (shown.session === null) return listScreen($, kit, await read($, sessions), shown, columns)

    const one = await read($, detail)

    if (one === null) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text bold>{TITLE}</Text>
            <Button key="back" label="Sessions" onPress={() => void show($, null)} />
          </Box>
          <Text dimColor>Nothing to show for this session yet.</Text>
        </Box>
      )
    }

    let picture: RenderElement | null = null

    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const drawn = graph(one.nodes, shown.node)

      picture = <Svg source={drawn.source} alt={drawn.alt} />
    }

    return sessionScreen($, kit, one, shown, await read($, notice), picture, columns)
  })
}
