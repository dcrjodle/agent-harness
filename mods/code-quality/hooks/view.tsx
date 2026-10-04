import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Board, Dimension, Repo, Run, Scores, Severity, Suggestion } from '../types'

import { isIssueUrl, issueNumber } from './actions'
import { DIMENSIONS, overall } from './report'
import { ROUTINES_URL } from './routines'

const SQUARE = 16
const TILE = SQUARE * 2
const GAP = 2
const PANEL_MIN = 44

export const DOCK_COLUMNS = TILE + GAP + PANEL_MIN + 2

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'>

export type View = {
  board: Board
  repo: Repo | null
  issues: Readonly<Record<string, string>>
  busy: readonly string[]
  now: number
  columns: number
}

export type Actions = {
  open: (slug: string | null) => void
  refresh: () => void
  schedule: (repo: Repo) => void
  scan: (repo: Repo) => void
  issue: (repo: Repo, suggestion: Suggestion) => void
  session: (repo: Repo, suggestion: Suggestion, surface: RenderSurface) => void
  both: (repo: Repo, suggestion: Suggestion, surface: RenderSurface) => void
}

type Phase = 'unscheduled' | 'waiting' | 'scanning' | 'failed' | 'unread' | 'scored'

export function runKey(run: Run): string {
  return `${run.session}@${run.at ?? ''}`
}

export function issueKey(repo: Repo, suggestion: Suggestion): string {
  return `${repo.slug}#${suggestion.id}`
}

function phaseOf(repo: Repo, busy: readonly string[]): Phase {
  const run = repo.routine?.run ?? null

  if (repo.routine === null) return 'unscheduled'
  if (busy.includes(`scan:${repo.slug}`) || run?.status === 'running') return 'scanning'
  if (run === null) return 'waiting'
  if (run.status === 'failed') return 'failed'

  return repo.report?.run === runKey(run) ? 'scored' : 'unread'
}

function tone(value: number | null): { color: string } | { dimColor: true } {
  if (value === null) return { dimColor: true }

  return { color: value >= 80 ? 'success' : value >= 60 ? 'warning' : 'error' }
}

function severityTone(severity: Severity): { color: string } | { dimColor: true } {
  return severity === 'high' ? { color: 'error' } : severity === 'medium' ? { color: 'warning' } : { dimColor: true }
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

function span(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000)

  if (minutes < 1) return 'moments'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)}h`

  return `${Math.round(minutes / (60 * 24))}d`
}

function ago(now: number, at: string | null): string {
  const time = at === null ? Number.NaN : Date.parse(at)

  return Number.isNaN(time) ? 'Scanned' : `Scanned ${span(now - time)} ago`
}

function until(now: number, at: string | null): string {
  const time = at === null ? Number.NaN : Date.parse(at)

  return Number.isNaN(time) || time < now ? 'First scan pending' : `First scan in ${span(time - now)}`
}

function bar(kit: Kit, value: number | null, width: number): RenderElement {
  const { Box, Text } = kit
  const filled = value === null ? 0 : Math.round((value / 100) * width)

  return (
    <Box>
      {filled > 0 && <Text {...tone(value)}>{'█'.repeat(filled)}</Text>}
      {filled < width && <Text dimColor>{'░'.repeat(width - filled)}</Text>}
    </Box>
  )
}

function square(kit: Kit, dimension: { key: Dimension; label: string }, scores: Scores | null): RenderElement {
  const { Box, Text } = kit
  const value = scores === null ? null : scores[dimension.key]

  return (
    <Box
      flexDirection="column"
      justifyContent="space-between"
      width={SQUARE}
      height={7}
      borderStyle="round"
      borderDimColor
      paddingX={1}
    >
      <Text dimColor>{dimension.label}</Text>
      <Text bold {...tone(value)}>
        {value === null ? '–' : String(value)}
      </Text>
      {bar(kit, value, SQUARE - 4)}
    </Box>
  )
}

function scanButton(kit: Kit, repo: Repo, actions: Actions, place: 'tile' | 'panel'): RenderElement {
  const { Button } = kit

  return <Button key={`${place === 'tile' ? 'tile-scan' : 'scan'}:${repo.slug}`} label="Scan now" onPress={() => actions.scan(repo)} />
}

function scheduleButton(kit: Kit, view: View, repo: Repo, actions: Actions): RenderElement {
  const { Button } = kit

  return (
    <Button
      key={`schedule:${repo.slug}`}
      label={view.busy.includes(`schedule:${repo.slug}`) ? 'Scheduling…' : 'Schedule daily scan'}
      onPress={() => actions.schedule(repo)}
    />
  )
}

function footer(kit: Kit, view: View, repo: Repo, actions: Actions): RenderElement {
  const { Box, Text } = kit
  const phase = phaseOf(repo, view.busy)
  const count = repo.report?.suggestions.length ?? 0

  if (phase === 'unscheduled') return scheduleButton(kit, view, repo, actions)
  if (phase === 'scanning') return <Text dimColor>Scanning…</Text>
  if (phase === 'scored') {
    return (
      <Text dimColor wrap="truncate">
        {`${ago(view.now, repo.report?.scannedAt ?? null)} · ${count} suggestion${count === 1 ? '' : 's'}`}
      </Text>
    )
  }

  return (
    <Box justifyContent="space-between">
      {phase === 'waiting' && <Text dimColor>{until(view.now, repo.routine?.nextRunAt ?? null)}</Text>}
      {phase === 'failed' && <Text color="error">Last scan failed</Text>}
      {phase === 'unread' && <Text color="warning">No report in last scan</Text>}
      {scanButton(kit, repo, actions, 'tile')}
    </Box>
  )
}

function tile(kit: Kit, view: View, repo: Repo, actions: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const scores = repo.report?.scores ?? null
  const total = scores === null ? null : overall(scores)
  const name = clip(repo.slug.slice(repo.slug.indexOf('/') + 1), TILE - 10)
  const [first, second, third, fourth] = DIMENSIONS

  return (
    <Box flexDirection="column" width={TILE}>
      <Box justifyContent="space-between">
        <Button
          key={`open:${repo.slug}`}
          label={name}
          variant={view.repo?.slug === repo.slug ? 'primary' : 'secondary'}
          onPress={() => actions.open(repo.slug)}
        />
        {total !== null && (
          <Text bold {...tone(total)}>
            {String(total)}
          </Text>
        )}
      </Box>
      <Box>
        {first !== undefined && square(kit, first, scores)}
        {second !== undefined && square(kit, second, scores)}
      </Box>
      <Box>
        {third !== undefined && square(kit, third, scores)}
        {fourth !== undefined && square(kit, fourth, scores)}
      </Box>
      {footer(kit, view, repo, actions)}
    </Box>
  )
}

function row(kit: Kit, view: View, repo: Repo, suggestion: Suggestion, actions: Actions): RenderElement {
  const { Box, Text, Button, Link } = kit
  const key = issueKey(repo, suggestion)
  const filed = view.issues[key]
  const isFiling = view.busy.includes(`issue:${key}`)
  const label = DIMENSIONS.find(one => one.key === suggestion.dimension)?.label ?? suggestion.dimension

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        <Text {...severityTone(suggestion.severity)}>{suggestion.severity}</Text>
        <Text dimColor>{label}</Text>
      </Box>
      <Text bold wrap="wrap">
        {suggestion.title}
      </Text>
      <Text wrap="wrap">{suggestion.why}</Text>
      {suggestion.paths.length > 0 && (
        <Text dimColor wrap="truncate-middle">
          {suggestion.paths.join('  ')}
        </Text>
      )}
      <Box gap={1}>
        {filed !== undefined && isIssueUrl(filed) && <Link href={filed} label={`Issue ${issueNumber(filed)}`} />}
        {filed === undefined && (
          <Button
            key={`issue:${suggestion.id}`}
            label={isFiling ? 'Filing…' : 'Issue'}
            onPress={() => actions.issue(repo, suggestion)}
          />
        )}
        <Button
          key={`session:${suggestion.id}`}
          label="Session"
          onPress={press => actions.session(repo, suggestion, press.surface)}
        />
        {filed === undefined && (
          <Button
            key={`both:${suggestion.id}`}
            label="Both"
            variant="primary"
            onPress={press => actions.both(repo, suggestion, press.surface)}
          />
        )}
      </Box>
    </Box>
  )
}

function panel(kit: Kit, view: View, repo: Repo, actions: Actions, width: number, isSplit: boolean): RenderElement {
  const { Box, Text, Button, Link } = kit
  const phase = phaseOf(repo, view.busy)
  const suggestions = repo.report?.suggestions ?? []
  const scores = repo.report?.scores ?? null
  const summary = scores === null ? 'No scores yet' : `Overall ${overall(scores)} · ${ago(view.now, repo.report?.scannedAt ?? null)}`

  return (
    <Box flexDirection="column" width={width}>
      <Box gap={GAP}>
        <Button key="close" label={isSplit ? 'Close' : 'All repos'} onPress={() => actions.open(null)} />
        <Text bold wrap="truncate">
          {repo.slug}
        </Text>
      </Box>
      <Text dimColor>{phase === 'scanning' ? 'Scanning…' : summary}</Text>
      {(repo.routine !== null || !isSplit) && (
        <Box gap={GAP}>
          {repo.routine !== null && phase !== 'scanning' && scanButton(kit, repo, actions, 'panel')}
          {repo.routine === null && scheduleButton(kit, view, repo, actions)}
          {repo.routine !== null && <Link href={`${ROUTINES_URL}/${repo.routine.id}`} label="Routine" />}
        </Box>
      )}
      {suggestions.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>{repo.report === null ? 'Suggestions show here after the first scan.' : 'No suggestions today.'}</Text>
        </Box>
      )}
      {suggestions.map(suggestion => row(kit, view, repo, suggestion, actions))}
    </Box>
  )
}

export function dashboard(kit: Kit, view: View, actions: Actions): RenderElement {
  const { Box, Text, Button } = kit
  const { board, repo, columns } = view
  const isSplit = repo !== null && columns >= TILE + GAP + PANEL_MIN
  const isStacked = repo !== null && !isSplit

  return (
    <Box flexDirection="column">
      <Box gap={GAP}>
        <Text bold>Code quality</Text>
        <Button key="refresh" label={board.isLoading ? 'Refreshing…' : 'Refresh'} onPress={() => actions.refresh()} />
      </Box>
      {board.notice !== '' && (
        <Text color="warning" wrap="wrap">
          {board.notice}
        </Text>
      )}
      {board.repos.length === 0 && (
        <Text dimColor>
          {board.isLoading ? 'Looking for recent repositories…' : 'No recent GitHub repositories found.'}
        </Text>
      )}
      {isStacked && <Box marginTop={1}>{panel(kit, view, repo, actions, columns, false)}</Box>}
      {!isStacked && board.repos.length > 0 && (
        <Box marginTop={1} gap={GAP}>
          <Box flexWrap="wrap" columnGap={GAP} rowGap={1} flexShrink={0} {...(isSplit ? { width: TILE } : {})}>
            {board.repos.map(one => tile(kit, view, one, actions))}
          </Box>
          {isSplit && panel(kit, view, repo, actions, columns - TILE - GAP, true)}
        </Box>
      )}
    </Box>
  )
}
