/**
 * 存储层：路径解析、JSON/JSONL 读写、traits 文件读写。
 *
 * 所有磁盘操作的入口都在这里；其它模块只通过本模块碰文件。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

/** 目录下所有已知文件的位置。 */
export function paths(dir) {
  return {
    dir,
    traits: join(dir, 'traits.jsonl'),
    experiences: join(dir, 'experiences'),
    expIndex: join(dir, 'experiences', 'index.jsonl'),
    manifest: join(dir, 'manifest.json'),
    persona: join(dir, 'persona.md'),
    readme: join(dir, 'README.md'),
    identity: join(dir, 'identity.md'),
  }
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

/** 读人格条目（只保留 id/text/kind 合法的）。 */
export function readEntries(p) {
  if (!existsSync(p.traits)) return []
  try {
    return parseJsonl(readFileSync(p.traits, 'utf8'))
      .filter((entry) => typeof entry.id === 'string' && typeof entry.text === 'string' && KINDS.includes(entry.kind))
  } catch {
    return []
  }
}

export function entriesToText(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
}

/** 纯追加走 append，涉及改写才全量重写。 */
export function appendEntry(p, entry) {
  let needsBreak = false
  try {
    const raw = readFileSync(p.traits, 'utf8')
    needsBreak = raw.length > 0 && !raw.endsWith('\n')
  } catch {
    needsBreak = false
  }
  appendFileSync(p.traits, `${needsBreak ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8')
}

export function rewriteEntries(p, entries) {
  atomicWrite(p.traits, entriesToText(entries))
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
