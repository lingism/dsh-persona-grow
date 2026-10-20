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

/** 文本转 2-gram 集合（中文不分词也能粗匹配）。 */
function bigrams(text) {
  const out = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (let i = 0; i + 1 < lower.length; i += 1) out.add(lower.slice(i, i + 2))
  return out
}

/**
 * 注入用：按当前情境挑最相关的经历标题；没命中就退回最近 N 条。
 * token 成本不变（只换标题排序），但相关经历更容易被想起来。
 */
export function pickExperiences(p, situation, limit) {
  const index = readExperienceIndex(p)
  if (index.length === 0) return recentExperiences(p, limit)
  const task = String(situation || '').trim()
  // 闲聊/无明确任务时只给最近 3 条（省一半标题 token），有任务才按相关挑
  if (task === '') return recentExperiences(p, Math.min(3, limit))
  const grams = bigrams(task)
  const scored = []
  for (const item of index) {
    const hay = `${item.title} ${item.text} ${(item.tags ?? []).join(' ')}`
    let score = 0
    for (const gram of bigrams(hay)) {
      if (grams.has(gram)) score += 1
    }
    if (score >= 2) scored.push({ title: item.title, score, at: item.at })
  }
  if (scored.length === 0) return recentExperiences(p, Math.min(3, limit))
  scored.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
  return scored.slice(0, limit).map((hit) => hit.title)
}

/** 本地关键词召回，不调模型。2-gram 匹配，中文整句也能搜到。 */
export function recall(p, query, limit) {
  const index = readExperienceIndex(p)
  const q = String(query ?? '').trim()
  if (q === '') return index.slice(-limit).reverse()
  const grams = bigrams(q)
  if (grams.size === 0) return index.slice(-limit).reverse()
  const scored = []
  for (const item of index) {
    const hay = `${item.title} ${item.text} ${(item.tags ?? []).join(' ')}`.toLowerCase()
    let score = 0
    for (const gram of grams) if (hay.includes(gram)) score += 1
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || String(b.item.at).localeCompare(String(a.item.at)))
  return scored.slice(0, limit).map((hit) => hit.item)
}
