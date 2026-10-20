/**
 * 存储层：路径解析、JSON/JSONL 读写、traits 文件读写。
 *
 * 所有磁盘操作的入口都在这里；其它模块只通过本模块碰文件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KINDS } from './config.js'

/** 解析人格目录：显式 dir > $DSH_HOME/persona > ~/.dsh/persona。 */
export function resolveDir(config) {
  if (typeof config.dir === 'string' && config.dir.trim() !== '') return config.dir.trim()
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'persona')
}

/** 目录下所有已知文件的位置。技能按类别分文件，存在 skills/ 子目录里。 */
export function paths(dir) {
  return {
    dir,
    traits: join(dir, 'traits.jsonl'),
    skillsDir: join(dir, 'skills'),
    experiences: join(dir, 'experiences'),
    expIndex: join(dir, 'experiences', 'index.jsonl'),
    manifest: join(dir, 'manifest.json'),
    persona: join(dir, 'persona.md'),
    readme: join(dir, 'README.md'),
    identity: join(dir, 'identity.md'),
  }
}

/** 技能文件路径：skills/<domain>.jsonl。domain 是动态领域名（聊到新领域就自动新建）。 */
export function skillFile(p, domain) {
  const safe = String(domain || 'misc').trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24) || 'misc'
  return join(p.skillsDir, `${safe}.jsonl`)
}

export function ensureDirs(p) {
  mkdirSync(p.dir, { recursive: true })
  mkdirSync(p.experiences, { recursive: true })
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 先写临时文件再改名，避免半截文件。 */
export function atomicWrite(file, body) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
}

/** 逐行 JSON 解析；坏行（手改残留）直接跳过。 */
export function parseJsonl(raw) {
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '') continue
    try {
      const value = JSON.parse(text)
      if (value !== null && typeof value === 'object') out.push(value)
    } catch {
      // 手工编辑留下的残行：跳过
    }
  }
  return out
}

/**
 * 读条目：人格层在 traits.jsonl，技能层在 skills/<domain>.jsonl（领域动态）。
 * layer 和 domain 都由本函数按所在位置盖章——文件在哪，条目就属于哪。
 */
export function readEntries(p) {
  const readLayer = (file, layer, domain) => {
    if (!existsSync(file)) return []
    try {
      return parseJsonl(readFileSync(file, 'utf8'))
        .filter((entry) => typeof entry.id === 'string' && typeof entry.text === 'string' && KINDS.includes(entry.kind))
        .map((entry) => ({ ...entry, layer, ...(domain ? { domain } : {}) }))
    } catch {
      return []
    }
  }
  const skills = []
  if (existsSync(p.skillsDir)) {
    for (const file of readdirSync(p.skillsDir)) {
      if (!file.endsWith('.jsonl')) continue
      const domain = file.replace(/\.jsonl$/, '')
      skills.push(...readLayer(join(p.skillsDir, file), 'skill', domain))
    }
  }
  return [...readLayer(p.traits, 'persona'), ...skills]
}

export function entriesToText(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
}

/** 纯追加走 append，涉及改写才全量重写。技能按 domain 写 skills/<domain>.jsonl。 */
export function appendEntry(p, entry) {
  const isSkill = entry.layer === 'skill'
  const file = isSkill ? skillFile(p, entry.domain) : p.traits
  if (isSkill) mkdirSync(p.skillsDir, { recursive: true })
  let needsBreak = false
  try {
    const raw = readFileSync(file, 'utf8')
    needsBreak = raw.length > 0 && !raw.endsWith('\n')
  } catch {
    needsBreak = false
  }
  appendFileSync(file, `${needsBreak ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8')
}

export function rewriteEntries(p, entries) {
  const persona = entries.filter((entry) => entry.layer !== 'skill')
  const skills = entries.filter((entry) => entry.layer === 'skill')
  atomicWrite(p.traits, entriesToText(persona))
  mkdirSync(p.skillsDir, { recursive: true })
  // 按 domain 分组重写；不再使用的领域文件清掉
  const byDomain = new Map()
  for (const entry of skills) {
    const domain = String(entry.domain || 'misc')
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain).push(entry)
  }
  for (const file of readdirSync(p.skillsDir)) {
    if (file.endsWith('.jsonl')) rmSync(join(p.skillsDir, file), { force: true })
  }
  for (const [domain, group] of byDomain) {
    atomicWrite(skillFile(p, domain), entriesToText(group))
  }
}

/** 下一个可用 id（pg-0001 起，取最大值 +1）。 */
export function nextId(entries) {
  let max = 0
  for (const entry of entries) {
    const match = /^pg-(\d+)$/.exec(String(entry.id))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `pg-${String(max + 1).padStart(4, '0')}`
}
