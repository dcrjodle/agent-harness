import type { Suggestion } from '../types'

const ISSUE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/

export const OPENERS: readonly (readonly string[])[] = [['open'], ['xdg-open'], ['rundll32', 'url.dll,FileProtocolHandler']]

export function issueBody(suggestion: Suggestion): string {
  const files = suggestion.paths.map(path => `\`${path}\``).join(' ')

  return files === '' ? suggestion.why : `${suggestion.why}\n\n${files}`
}

export function issueCommand(slug: string, suggestion: Suggestion): string[] {
  return ['gh', 'issue', 'create', '--repo', slug, '--title', suggestion.title, '--body', issueBody(suggestion)]
}

export function issueUrlIn(output: string): string | null {
  return ISSUE_URL.exec(output)?.[0] ?? null
}

export function isIssueUrl(url: string): boolean {
  return ISSUE_URL.exec(url)?.[0] === url
}

export function issueNumber(url: string): string {
  return `#${url.slice(url.lastIndexOf('/') + 1)}`
}

export function sessionPrompt(suggestion: Suggestion, issue: string | null): string {
  return [
    suggestion.title,
    suggestion.why,
    suggestion.paths.length === 0 ? '' : `Files: ${suggestion.paths.join(', ')}`,
    issue === null ? '' : `Closes ${issue}`,
  ]
    .filter(part => part !== '')
    .join('\n\n')
}

export function sessionLink(root: string, prompt: string): string {
  return `claude://code/new?folder=${encodeURIComponent(root)}&q=${encodeURIComponent(prompt)}`
}
