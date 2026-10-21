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

/** 剥掉标题开头自带的日期（旧条目格式："2026-10-19 · 标题"）。 */
export function stripDatePrefix(title) {
  return String(title ?? '').replace(/^\d{4}-\d{2}-\d{2}\s*[·\-]\s*/, '').trim()
}

export function appendExperience(p, item) {
  const file = experienceFile(p)
  const head = existsSync(file) ? '' : `# ${item.at.slice(0, 7)} 的经历\n\n`
  // 标题里已经带日期就不重复拼（旧格式条目就是这么长出双日期的）
  const title = stripDatePrefix(item.title) || String(item.title ?? '').trim()
  // 标题行带 id：删除时按 id 精确匹配，不用靠标题猜（标题可能被改写/互为后缀）
  const body = `${head}## ${item.at.slice(0, 10)} · ${title} <!-- ${item.id} -->\n\n${item.text}\n\n`
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  atomicWrite(file, existing + body)
  appendFileSync(p.expIndex, `${JSON.stringify({ ...item, title })}\n`, 'utf8')
}

/**
 * 删经历：索引和正文一起删。
 * 正文段落没有 id，按「日期 · 标题」这个段头匹配；标题自带日期的旧条目
 * 要先剥掉日期再拼，否则会拼成"日期 · 日期 · 标题"对不上段头（2026-10 踩过）。
 */
export function removeExperience(p, ids) {
  const drop = new Set((ids ?? []).map(String))
  const index = readExperienceIndex(p)
  const removed = index.filter((item) => drop.has(item.id))
  if (removed.length === 0) return { removed: [] }
  const kept = index.filter((item) => !drop.has(item.id))
  atomicWrite(p.expIndex, kept.length > 0 ? kept.map((item) => JSON.stringify(item)).join('\n') + '\n' : '')

  // 正文：按月份文件分组，删掉对应段头（双日期和单日期两种拼法都试）
  const byMonth = new Map()
  for (const item of removed) {
    const at = String(item.at ?? '')
    if (at.length < 10) continue
    const month = at.slice(0, 7)
    if (!byMonth.has(month)) byMonth.set(month, new Set())
    const date = at.slice(0, 10)
    const title = String(item.title ?? '')
    byMonth.get(month).add(`${date} · ${title}`)
    const bare = stripDatePrefix(title)
    if (bare !== '') byMonth.get(month).add(`${date} · ${bare}`)
  }
  for (const [month, headings] of byMonth) {
    const file = join(p.experiences, `${month}.md`)
    if (!existsSync(file)) continue
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const blocks = raw.split(/^## /m)
    const head = blocks[0]
    // 优先按段头里的 <!-- id --> 精确删（新数据）；旧数据没有 id 时按精确标题兜底。
    // 不做模糊匹配——「讨论外卖的菜品」会误删「主人不像做饭与我讨论外卖的菜品」这种后缀包含。
    const ids = [...drop]
    const idTags = ids.map((id) => '<!-- ' + id + ' -->')
    const keptBlocks = blocks.slice(1).filter((block) => {
      const first = block.split('\n')[0].trim()
      if (headings.has(first)) return false
      for (const tag of idTags) {
        if (first.includes(tag)) return false
      }
      return true
    })
    atomicWrite(file, head + keptBlocks.map((block) => `## ${block}`).join(''))
  }
  return { removed }
}

/**
 * 待办收口：剥掉经历标题的「[待办] 」前缀，转成普通经历（索引和月志段头一起改）。
 * 「办完了没有」插件判断不了——由会话里的 agent 听到用户说办完/不用了之后主动调。
 */
export function clearTodoTitle(p, ids) {
  const drop = new Set((ids ?? []).map(String))
  const index = readExperienceIndex(p)
  const changed = []
  for (const item of index) {
    if (!drop.has(item.id)) continue
    const title = String(item.title ?? '')
    if (!title.startsWith('[待办]')) continue
    const next = title.replace(/^\[待办\]\s*/, '').trim()
    if (next === '') continue
    const date = String(item.at ?? '').slice(0, 10)
    const month = String(item.at ?? '').slice(0, 7)
    const file = join(p.experiences, `${month}.md`)
    if (date.length === 10 && existsSync(file)) {
      let raw = ''
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        raw = ''
      }
      const before = `## ${date} · ${title}`
      if (raw.includes(before)) atomicWrite(file, raw.replace(before, `## ${date} · ${next}`))
    }
    item.title = next
    changed.push(item)
  }
  if (changed.length > 0) {
    atomicWrite(p.expIndex, index.map((item) => JSON.stringify(item)).join('\n') + '\n')
  }
  return { changed }
}

/** 最近 N 条经历的标题（注入用）。 */export function recentExperiences(p, limit) {
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
