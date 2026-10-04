import type { Routine, Run } from '../types'

import { scanPrompt } from './report'

const PREFIX = 'code-quality: '
const TOOLS = ['Bash', 'Read', 'Glob', 'Grep']

export const ROUTINES_URL = 'https://claude.ai/code/routines'

export type Answer = { isOk: true; body: unknown; summary: string } | { isOk: false; reason: string }

export type Listing = { routines: Map<string, Routine>; environment: string | null }

export type Schedule = { environment: string; hourUtc: number; model: string }

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function parse(json: unknown): unknown {
  if (typeof json !== 'string') return null
  try {
    return JSON.parse(json) as unknown
  } catch {
    return null
  }
}

export function answerOf(result: unknown): Answer {
  const status = field(result, 'status')
  const body = parse(field(result, 'json'))

  if (typeof status === 'number' && status >= 200 && status < 300) {
    return { isOk: true, body, summary: text(field(result, 'summary')) ?? '' }
  }
  const message = text(field(field(body, 'error'), 'message')) ?? text(field(body, 'message'))

  return { isOk: false, reason: `the routine API answered ${String(status)}${message === null ? '' : `: ${message}`}` }
}

function runOf(value: unknown): Run | null {
  const session = text(field(value, 'session_id'))
  const status = text(field(value, 'status')) ?? ''
  const finishedAt = text(field(value, 'finished_at'))

  if (session === null) return null
  if (status.endsWith('SUCCEEDED')) return { session, status: 'succeeded', at: finishedAt }
  if (finishedAt !== null) return { session, status: 'failed', at: finishedAt }

  return { session, status: 'running', at: text(field(value, 'fired_at')) }
}

export function listingOf(body: unknown): Listing {
  const data = field(body, 'data')
  const routines = new Map<string, Routine>()
  let environment: string | null = null

  for (const one of Array.isArray(data) ? (data as unknown[]) : []) {
    environment ??= text(field(field(field(one, 'job_config'), 'ccr'), 'environment_id'))
    const id = text(field(one, 'id'))
    const name = text(field(one, 'name'))

    if (id === null || name === null || !name.startsWith(PREFIX)) continue
    const slug = name.slice(PREFIX.length)

    if (routines.has(slug)) continue
    routines.set(slug, {
      id,
      isEnabled: field(one, 'enabled') !== false,
      nextRunAt: text(field(one, 'next_run_at')),
      run: runOf(field(one, 'last_run')),
    })
  }

  return { routines, environment }
}

export function createdOf(body: unknown): { id: string; hasConnectors: boolean } | null {
  const made = field(body, 'trigger')
  const id = text(field(made, 'id'))
  const connections = field(made, 'mcp_connections')

  return id === null ? null : { id, hasConnectors: Array.isArray(connections) && connections.length > 0 }
}

export function scanMinute(slug: string): number {
  let sum = 0

  for (let index = 0; index < slug.length; index++) sum = (sum * 31 + slug.charCodeAt(index)) % 60

  return sum
}

export function scanTime(slug: string, hourUtc: number): string {
  return `${String(hourUtc).padStart(2, '0')}:${String(scanMinute(slug)).padStart(2, '0')} UTC`
}

export function routineBody(slug: string, schedule: Schedule, uuid: string): Record<string, unknown> {
  return {
    name: `${PREFIX}${slug}`,
    cron_expression: `${scanMinute(slug)} ${schedule.hourUtc} * * *`,
    enabled: true,
    job_config: {
      ccr: {
        environment_id: schedule.environment,
        session_context: {
          model: schedule.model,
          sources: [{ git_repository: { url: `https://github.com/${slug}` } }],
          allowed_tools: TOOLS,
        },
        events: [
          {
            data: {
              uuid,
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: { content: scanPrompt(slug), role: 'user' },
            },
          },
        ],
      },
    },
  }
}
