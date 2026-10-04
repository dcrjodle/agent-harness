// The session's agents as a picture: one box per agent, a line from each spawner to what it spawned.
// Laid out left to right so a side pane's width holds it: depth runs across, siblings run down.
// Pure: it returns an SVG document for the surfaces that draw one.

import type { AgentNode } from '../types'

import { clip, duration, money, tone } from './format'

const BOX = { width: 196, height: 58, gapX: 44, gapY: 10, pad: 6 }

type Placed = { node: AgentNode; depth: number; row: number }

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Depth and row per node: a leaf takes the next free row, a spawner sits level with the middle of its children. */
export function layout(nodes: readonly AgentNode[]): Placed[] {
  const known = new Set(nodes.map(node => node.id))
  const childrenOf = (id: string | null): AgentNode[] =>
    nodes.filter(node => (node.parent !== null && known.has(node.parent) ? node.parent : null) === id)
  const placed: Placed[] = []
  let next = 0

  const place = (node: AgentNode, depth: number): number => {
    const rows = childrenOf(node.id).map(child => place(child, depth + 1))
    const row = rows.length === 0 ? next++ : (Math.min(...rows) + Math.max(...rows)) / 2
    placed.push({ node, depth, row })

    return row
  }

  for (const root of childrenOf(null)) place(root, 0)

  return placed
}

/** The same tree as rows, parents before children, each with the connector that leads to it. */
export function tree(nodes: readonly AgentNode[]): { node: AgentNode; lead: string }[] {
  const known = new Set(nodes.map(node => node.id))
  const childrenOf = (id: string | null): AgentNode[] =>
    nodes.filter(node => (node.parent !== null && known.has(node.parent) ? node.parent : null) === id)
  const rows: { node: AgentNode; lead: string }[] = []

  const walk = (node: AgentNode, lead: string, trunk: string): void => {
    rows.push({ node, lead })
    const children = childrenOf(node.id)
    children.forEach((child, index) => {
      const isLast = index === children.length - 1
      walk(child, `${trunk}${isLast ? '└─ ' : '├─ '}`, `${trunk}${isLast ? '   ' : '│  '}`)
    })
  }

  for (const root of childrenOf(null)) walk(root, '', '')

  return rows
}

export function graph(nodes: readonly AgentNode[], selected: string | null): { source: string; alt: string } {
  const placed = layout(nodes)
  const at = new Map(placed.map(one => [one.node.id, one]))
  const x = (depth: number): number => BOX.pad + depth * (BOX.width + BOX.gapX)
  const y = (row: number): number => BOX.pad + row * (BOX.height + BOX.gapY)
  const depth = Math.max(0, ...placed.map(one => one.depth))
  const rows = Math.max(1, ...placed.map(one => one.row + 1))
  const width = x(depth) + BOX.width + BOX.pad
  const height = y(rows - 1) + BOX.height + BOX.pad

  const lines = placed.flatMap(one => {
    const parent = one.node.parent === null ? undefined : at.get(one.node.parent)
    if (parent === undefined) return []
    const fromX = x(parent.depth) + BOX.width
    const fromY = y(parent.row) + BOX.height / 2
    const toX = x(one.depth)
    const toY = y(one.row) + BOX.height / 2
    const mid = (fromX + toX) / 2

    return [`<path d="M${fromX} ${fromY} C${mid} ${fromY} ${mid} ${toY} ${toX} ${toY}" fill="none" stroke="#8b949e" stroke-width="1.5"/>`]
  })

  const boxes = placed.map(one => {
    const { node } = one
    const left = x(one.depth)
    const top = y(one.row)
    const isSelected = node.id === selected
    const isRunning = node.status === 'running'
    const name = node.kind === 'session' ? 'session' : node.type
    const about = node.kind === 'session' ? (node.models[0] ?? '') : (node.description ?? '')

    return [
      `<rect x="${left}" y="${top}" width="${BOX.width}" height="${BOX.height}" rx="8" fill="#1f2430" stroke="${isSelected ? '#7aa2f7' : '#3a4252'}" stroke-width="${isSelected ? 2.5 : 1}"/>`,
      `<circle cx="${left + 14}" cy="${top + 17}" r="4.5" fill="${tone(node.status)}"/>`,
      `<text x="${left + 26}" y="${top + 21}" fill="#e6e8eb" font-size="12" font-weight="600">${escape(clip(name, 16))}</text>`,
      `<text x="${left + BOX.width - 10}" y="${top + 21}" fill="#e6e8eb" text-anchor="end">${isRunning ? '' : escape(money(node.cost_usd))}</text>`,
      `<text x="${left + 10}" y="${top + 37}" fill="#9aa4b2">${escape(clip(about, 30))}</text>`,
      `<text x="${left + 10}" y="${top + 51}" fill="#9aa4b2">${escape(isRunning ? 'running' : `${node.status} · ${duration(node.active_ms)}`)}</text>`,
    ].join('')
  })

  const spawned = nodes.filter(node => node.kind === 'agent')
  const alt =
    spawned.length === 0
      ? 'Agent graph: the session spawned no agents.'
      : `Agent graph: the session and ${spawned.length} agent${spawned.length === 1 ? '' : 's'} (${clip(spawned.map(node => node.type).join(', '), 120)}), joined by who spawned whom.`

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="11">${lines.join('')}${boxes.join('')}</svg>`,
    alt,
  }
}
