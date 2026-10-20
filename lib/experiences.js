/**
 * 经历层：按月归档的事件流水 + 本地关键词召回。
 *
 * 经历正文不注入提示词（只注入最近几条标题），需要细节时用 recall 翻。
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, parseJsonl } from './storage.js'

export function experienceFile(p, date = new Date()) {
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  return join(p.experiences, `${month}.md`)
}

/**
 * 读索引。
 *
 * 注意：必须同时有 id 和 title 才收——没有 id 的行会被静默丢掉，
 * 表现为 recall 永远搜不到（2026-10 踩过一次）。
 */
export function readExperienceIndex(p) {
  if (!existsSync(p.expIndex)) return []
  try {
    return parseJsonl(readFileSync(p.expIndex, 'utf8'))
      .filter((item) => typeof item.id === 'string' && typeof item.title === 'string')
  } catch {
    return []
  }
}

export function appendExperience(p, item) {
  const file = experienceFile(p)
  const head = existsSync(file) ? '' : `# ${item.at.slice(0, 7)} 的经历\n\n`
  const body = `${head}## ${item.at.slice(0, 10)} · ${item.title}\n\n${item.text}\n\n`
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  atomicWrite(file, existing + body)
  appendFileSync(p.expIndex, `${JSON.stringify(item)}\n`, 'utf8')
}

/** 最近 N 条经历的标题（注入用）。 */
export function recentExperiences(p, limit) {
  if (limit <= 0) return []
  const index = readExperienceIndex(p)
  if (index.length > 0) {
    return index.slice(-limit).reverse().map((item) => item.title)
  }
  // 索引缺失时退回读文件（兼容老档案）
  let names = []
  try {
    names = readdirSync(p.experiences).filter((name) => name.endsWith('.md')).sort()
  } catch {
    return []
  }
  const picked = []
  for (const name of names) {
    let raw = ''
    try {
      raw = readFileSync(join(p.experiences, name), 'utf8')
    } catch {
      continue
    }
    for (const block of raw.split(/^## /m).slice(1).reverse()) {
      const [titleLine] = block.split('\n')
      if (titleLine !== undefined) picked.push(titleLine.trim())
      if (picked.length >= limit) return picked
    }
  }
  return picked
}

/** 本地关键词召回，不调模型。 */
export function recall(p, query, limit) {
  const index = readExperienceIndex(p)
  const terms = String(query ?? '').toLowerCase().split(/[\s,，、]+/).filter((t) => t.length > 0)
  if (terms.length === 0) return index.slice(-limit).reverse()
  const scored = []
  for (const item of index) {
    const haystack = `${item.title} ${item.text} ${(item.tags ?? []).join(' ')}`.toLowerCase()
    let score = 0
    for (const term of terms) if (haystack.includes(term)) score += 1
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || String(b.item.at).localeCompare(String(a.item.at)))
  return scored.slice(0, limit).map((hit) => hit.item)
}
