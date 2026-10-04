import type { Repo } from '../types'

export type Found = Pick<Repo, 'slug' | 'root' | 'usedAt'>

export function parseRepos(output: string, limit: number): Found[] {
  return output
    .split('\n')
    .flatMap((line): Found[] => {
      const [slug, root, used] = line.split('\t')

      return slug === undefined || slug === '' || root === undefined || root === ''
        ? []
        : [{ slug, root, usedAt: (Number(used) || 0) * 1000 }]
    })
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, limit)
}
