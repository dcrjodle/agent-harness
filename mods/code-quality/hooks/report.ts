import type { Dimension, Report, Scores, Severity, Suggestion } from '../types'

export const DIMENSIONS: readonly { key: Dimension; code: string; label: string }[] = [
  { key: 'maintainability', code: 'm', label: 'Maintainable' },
  { key: 'reliability', code: 'r', label: 'Reliable' },
  { key: 'security', code: 's', label: 'Secure' },
  { key: 'tests', code: 't', label: 'Tested' },
]

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']
const MARK = '{"cq":1,'
const MAX_SUGGESTIONS = 8
const MAX_TITLE = 80
const MAX_WHY = 200
const MAX_PATH = 120

type Row = Record<string, unknown>

function objectAt(text: string, start: number): string | null {
  let depth = 0
  let isInString = false
  let isEscaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]

    if (char === '\n') return null
    if (isInString) {
      if (isEscaped) isEscaped = false
      else if (char === '\\') isEscaped = true
      else if (char === '"') isInString = false
    } else if (char === '"') {
      isInString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}' && --depth === 0) {
      return text.slice(start, index + 1)
    }
  }

  return null
}

function rowAt(text: string, start: number): Row | null {
  const source = objectAt(text, start)

  if (source === null) return null
  try {
    const row: unknown = JSON.parse(source)

    return typeof row === 'object' && row !== null && !Array.isArray(row) ? (row as Row) : null
  } catch {
    return null
  }
}

function rows(log: string): Row[] {
  const found: Row[] = []

  for (let from = log.indexOf(MARK); from !== -1; from = log.indexOf(MARK, from + MARK.length)) {
    const row = rowAt(log, from)

    if (row !== null) found.push(row)
  }

  return found
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''

  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function scoresOf(row: Row): Scores | null {
  if (row['k'] !== 'scores') return null
  const scores: Partial<Scores> = {}

  for (const { key, code } of DIMENSIONS) {
    const value = row[code]

    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    scores[key] = Math.max(0, Math.min(100, Math.round(value)))
  }

  return scores as Scores
}

function suggestionOf(row: Row): Suggestion | null {
  if (row['k'] !== 'fix') return null
  const dimension = DIMENSIONS.find(one => one.code === row['d'])?.key
  const severity = SEVERITIES.find(one => one === row['v'])
  const title = clean(row['t'], MAX_TITLE)
  const why = clean(row['w'], MAX_WHY)

  if (dimension === undefined || severity === undefined || title === '' || why === '') return null
  const listed: unknown[] = Array.isArray(row['p']) ? row['p'] : []
  const paths = listed.map(path => clean(path, MAX_PATH)).filter(path => path !== '')

  return { id: fingerprint(`${dimension}|${title}`), dimension, severity, title, why, paths: paths.slice(0, 3) }
}

export function fingerprint(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function parseReport(log: string, run: string, scannedAt: string | null): Report | null {
  const found = rows(log)
  const start = found.findLastIndex(row => scoresOf(row) !== null)
  const head = found[start]
  const scores = head === undefined ? null : scoresOf(head)

  if (scores === null) return null
  const suggestions: Suggestion[] = []

  for (const row of found.slice(start + 1)) {
    const suggestion = suggestionOf(row)

    if (suggestion !== null && !suggestions.some(one => one.id === suggestion.id)) suggestions.push(suggestion)
  }

  return { run, scannedAt, scores, suggestions: suggestions.slice(0, MAX_SUGGESTIONS) }
}

export function overall(scores: Scores): number {
  return Math.round(DIMENSIONS.reduce((sum, { key }) => sum + scores[key], 0) / DIMENSIONS.length)
}

export function scanPrompt(slug: string): string {
  return `You are scoring the code quality of the repository ${slug}, checked out in the working directory. Read the code. Do not modify, commit, push or open anything.

Score four dimensions from 0 to 100 on what the repository holds today:
- m, maintainability: structure, duplication, complexity, dead code, naming, dependency hygiene.
- r, reliability: error handling, edge cases, input validation, type safety, races.
- s, security: secrets, injection, unsafe shell or eval, authorization, vulnerable or unpinned dependencies.
- t, tests: automated tests that assert behaviour, coverage of the critical paths, CI that runs them.
Anchors: 90 and up exemplary, 70-89 solid with small gaps, 50-69 notable gaps, below 50 serious problems. Judge the same way every day so the scores compare.

Then list at most ${MAX_SUGGESTIONS} suggestions, most valuable first. Each is one concrete change that fits one pull request and names the files it touches. If a GitHub tool is available, read the open issues and leave out what one already covers.

Write for a reader with no time:
- t, the title: imperative, at most 60 characters, no trailing period.
- w, the reason: what is wrong and what it costs, at most 140 characters, one or two plain sentences. No filler, no praise, no restating the title.
- p: one or two repository-relative paths.

Report as records, one JSON object per line, keys in exactly this order:
{"cq":1,"k":"scores","m":<0-100>,"r":<0-100>,"s":<0-100>,"t":<0-100>}
{"cq":1,"k":"fix","d":"<m|r|s|t>","v":"<high|medium|low>","t":"<title>","w":"<reason>","p":["<path>"]}
One scores record first, then one fix record per suggestion.

A dashboard reads the records from this run's log, so deliver them exactly like this:
1. Write the records to /tmp/cq.jsonl with one Bash heredoc.
2. Run: awk 'length > 380 || !/^\\{"cq":1,/' /tmp/cq.jsonl
   It must print nothing. Shorten and rewrite until it does.
3. Print the file one line per Bash call: sed -n '1p' /tmp/cq.jsonl, then sed -n '2p' /tmp/cq.jsonl, and so on to the last line. Never print two records in one call: output past 400 characters is cut off and the record is lost.
4. End with one short sentence and nothing else.`
}
