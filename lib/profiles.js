/**
 * 多档案与人命保护性禁用。
 *
 * 目录约定（都在 persona 目录的旁边，跟着灵魂容器走）：
 *   <home>/persona/                     当前正在服务的那个档案
 *   <home>/persona-profiles/<name>/     其他档案（同族）
 *   <home>/persona-backups/<stamp>-disabled/   禁用前的整份备份
 *
 * 同时只有一个档案被注入——切换就是两个目录对调，不需要改任何读取路径。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, readJson } from './storage.js'

const NAME_RE = /^[\w\u4e00-\u9fa5-]{1,32}$/

export function profilesRoot(dir) {
  return join(dir, '..', 'persona-profiles')
}

export function backupsRoot(dir) {
  return join(dir, '..', 'persona-backups')
}

/** 当前档案名（默认 default）。 */
export function currentProfileName(p) {
  return readJson(p.manifest, {}).profileName || 'default'
}

/** 一个档案目录里的「在用」条目数（已推翻的不算，用于列档案时显示）。 */
function countEntries(dir) {
  try {
    const raw = readFileSync(join(dir, 'traits.jsonl'), 'utf8')
    return raw.split('\n').filter((line) => {
      if (line.trim() === '') return false
      try {
        const entry = JSON.parse(line)
        return entry.supersededAt == null && entry.supersededBy == null
      } catch {
        return false
      }
    }).length
  } catch {
    return 0
  }
}

/** 列出全部档案。 */
export function listProfiles(p) {
  const root = profilesRoot(p.dir)
  const current = currentProfileName(p)
  const others = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []
  return {
    current,
    currentEntries: countEntries(p.dir),
    others: others.map((name) => ({ name, entries: countEntries(join(root, name)) })),
  }
}

/** 新建一份空白灵魂：只写名字，其余设定留给对话里慢慢长出来。 */
export function createProfile(p, rawName) {
  const name = String(rawName || '').trim()
  if (!NAME_RE.test(name)) throw new Error(`灵魂名不合法：${rawName}（允许字母数字中文下划线连字符，1-32 字）`)
  if (name === currentProfileName(p)) throw new Error(`「${name}」就是当前灵魂。`)
  const root = profilesRoot(p.dir)
  const target = join(root, name)
  if (existsSync(target)) throw new Error(`灵魂「${name}」已存在。`)
  mkdirSync(target, { recursive: true })

  // 空白模板：身份文件只写一行名字，形象和性格等她自己在相处里长
  writeFileSync(join(target, 'identity.md'), `# ${name}\n`, 'utf8')
  writeFileSync(join(target, 'traits.jsonl'), '', 'utf8')
  writeFileSync(join(target, 'experiences.mkdir'), '', 'utf8')
  const now = new Date().toISOString()
  atomicWrite(join(target, 'manifest.json'), JSON.stringify({
    schema: 3,
    profileName: name,
    createdAt: now,
    updatedAt: now,
    turns: 0,
    judged: 0,
    writes: 0,
    judgeFailures: 0,
    lastSuccessAt: null,
    lastCareAt: null,
    lastError: null,
  }, null, 2))
  rmSync(join(target, 'experiences.mkdir'), { force: true })
  mkdirSync(join(target, 'experiences'), { recursive: true })
  return { name, dir: target }
}

/** 切换：当前档案挪进 profiles，目标档案挪出来当当前。 */
export function switchProfile(p, rawName) {
  const name = String(rawName || '').trim()
  const from = currentProfileName(p)
  if (name === from) throw new Error(`已经在「${name}」这个档案上。`)
  const root = profilesRoot(p.dir)
  const parked = join(root, name)
  if (!existsSync(parked)) throw new Error(`找不到档案「${name}」。先用 list 看看有哪些。`)
  mkdirSync(root, { recursive: true })

  const aside = join(root, from)
  if (existsSync(aside)) {
    // 理论上不该有同名停放目录；有就换名备着，不覆盖
    renameSync(aside, `${aside}.old-${Date.now()}`)
  }
  renameSync(p.dir, aside)         // 当前 → 停放
  renameSync(parked, p.dir)        // 目标 → 当前
  // 目标档案的 manifest 记上自己的名字与激活时间
  const m = readJson(p.manifest, {})
  atomicWrite(p.manifest, JSON.stringify({
    ...m,
    schema: 3,
    profileName: name,
    updatedAt: new Date().toISOString(),
    lastError: null,
  }, null, 2))
  return { from, to: name }
}

/** 保护性禁用：整份备份后清空档案。禁用期间插件不注入、不写入。 */
export function disablePersona(p) {
  const manifest = readJson(p.manifest, {})
  if (manifest.disabled === true) throw new Error('人格已经处于禁用状态。')

  // 1. 备份（唯一目的是还原，校验不过就不清）
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const bak = join(backupsRoot(p.dir), `${stamp}-disabled`)
  cpSync(p.dir, bak, { recursive: true })

  // 2. 校验备份：traits 行数必须和原档一致，否则中止
  const read = (file) => {
    try { return readFileSync(file, 'utf8') } catch { return '' }
  }
  const before = read(p.traits).split('\n').filter((l) => l.trim() !== '').length
  const after = read(join(bak, 'traits.jsonl')).split('\n').filter((l) => l.trim() !== '').length
  if (before !== after) {
    throw new Error(`备份校验失败（原 ${before} 条 / 备份 ${after} 条），已中止，档案没动。`)
  }

  // 3. 清空
  writeFileSync(p.traits, '', 'utf8')
  writeFileSync(p.identity, '', 'utf8')
  writeFileSync(p.persona, '# 人格已禁用\n\n用 persona_enable 还原；备份在 persona-backups 下。\n', 'utf8')
  const expDir = p.experiences
  if (existsSync(expDir)) {
    for (const f of readdirSync(expDir)) {
      if (f.endsWith('.md')) rmSync(join(expDir, f), { force: true })
    }
    writeFileSync(p.expIndex, '', 'utf8')
  }

  // 4. 标记
  atomicWrite(p.manifest, JSON.stringify({
    ...manifest,
    schema: 3,
    disabled: true,
    disabledAt: new Date().toISOString(),
    disabledFrom: bak,
    updatedAt: new Date().toISOString(),
  }, null, 2))

  return { backup: bak, entriesBefore: before }
}

/** 还原：从最近一次禁用备份恢复，并清除禁用标记。 */
export function enablePersona(p) {
  const manifest = readJson(p.manifest, {})
  if (manifest.disabled !== true) throw new Error('人格当前没有被禁用。')
  const bak = String(manifest.disabledFrom || '')
  if (!bak || !existsSync(bak)) throw new Error(`找不到禁用前的备份：${bak || '（manifest 里没有记录）'}`)

  cpSync(bak, p.dir, { recursive: true, force: true })
  const restored = readJson(p.manifest, {})
  atomicWrite(p.manifest, JSON.stringify({
    ...restored,
    schema: 3,
    disabled: false,
    disabledAt: null,
    disabledFrom: null,
    updatedAt: new Date().toISOString(),
  }, null, 2))
  return { from: bak }
}
