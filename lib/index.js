/**
 * dsh-persona-grow — 人格生长插件 v3
 *
 * 每轮对话结束后自动三段分流：该进人格的进人格，没人格增量但难忘的进经历，无营养的丢掉。
 *
 * 模块划分（2026-10 拆分，原来是 1300 行单文件）：
 *   config.js       配置 schema 与常量
 *   storage.js      路径解析 / JSON(JSONL) 读写 / traits 读写
 *   strength.js     强度、遗忘曲线、活条目过滤
 *   experiences.js  经历归档与关键词召回
 *   render.js       注入文本与 persona.md 渲染
 *   judge.js        判断输入准备 / 模型输出解析
 *   index.js        ← 本文件：插件入口与生命周期（apply）
 *
 * 全部状态在一个自包含文件夹里，换机器拷过去就复活。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config, KINDS, KIND_LABEL, SCHEMA_VERSION, DAY } from './config.js'
import {
  resolveDir, paths, ensureDirs, readJson, atomicWrite, parseJsonl,
  readEntries, entriesToText, appendEntry, rewriteEntries, nextId,
} from './storage.js'
import { clampStrength, effectiveStrength, isLive, liveEntries } from './strength.js'
import {
  experienceFile, readExperienceIndex, appendExperience, removeExperience, recentExperiences, pickExperiences, recall,
} from './experiences.js'
import {
  readTextSafe, renderIdentity, renderSection, renderSkills, renderPersonaMd, FOLDER_README,
} from './render.js'
import {
  JUDGE_PROMPT, CONSOLIDATE_PROMPT, clip, buildArchiveDigest, buildJudgeInput,
  parseJudge, textOfMessage, currentExchange,
} from './judge.js'
import {
  listProfiles, createProfile, switchProfile, disablePersona, enablePersona,
} from './profiles.js'
import { registerPersonaHttpRoutes, shapeState } from './http.js'

export { Config }
export const name = 'persona-grow'
export const inject = ['tools']

/**
 * 归层：只认判断模型显式给出的 layer 字段。
 * 不再用关键词正则猜内容——那东西误伤过情感句，而且规则永远追不上新说法。
 */
function layerOf(item, fallback) {
  const explicit = String(item?.layer ?? '')
  if (explicit === 'skill' || explicit === 'persona') return explicit
  return fallback
}

export function apply(ctx, config) {
  const p = paths(resolveDir(config))
  const cfg = {
    maxChars: Number.isFinite(config.maxChars) ? config.maxChars : 1800,
    minStrength: Number.isFinite(config.minStrength) ? config.minStrength : 1,
    minChars: Number.isFinite(config.minChars) ? config.minChars : 60,
    maxPerHour: Number.isFinite(config.maxPerHour) ? config.maxPerHour : 30,
    recentExperiences: Number.isFinite(config.recentExperiences) ? config.recentExperiences : 3,
    decayDays: Number.isFinite(config.decayDays) && config.decayDays > 0 ? config.decayDays : 30,
    bondDecayFactor: Number.isFinite(config.bondDecayFactor) && config.bondDecayFactor > 0 ? config.bondDecayFactor : 2,
    consolidateEvery: Number.isFinite(config.consolidateEvery) ? config.consolidateEvery : 20,
    consolidateMin: Number.isFinite(config.consolidateMin) ? config.consolidateMin : 30,
    digestMaxPerKind: Number.isFinite(config.digestMaxPerKind) ? config.digestMaxPerKind : 12,
    autoStrengthCap: Number.isFinite(config.autoStrengthCap) ? config.autoStrengthCap : 4,
    careEveryDays: Number.isFinite(config.careEveryDays) && config.careEveryDays > 0 ? config.careEveryDays : 7,
    userLabel: typeof config.userLabel === 'string' && config.userLabel !== '' ? config.userLabel : '用户',
    auto: config.auto !== false,
    provider: typeof config.provider === 'string' && config.provider !== '' ? config.provider : 'deepseek-account',
    model: typeof config.model === 'string' && config.model !== '' ? config.model : 'deepseek-flash',
  }
  // 技能层按需注入：最近一条用户消息 = 本轮任务情境。空串表示没有情境，技能不注入。
  let situation = ''

  try {
    ensureDirs(p)
    if (!existsSync(p.readme)) atomicWrite(p.readme, FOLDER_README)
    if (!existsSync(p.manifest)) {
      atomicWrite(p.manifest, JSON.stringify({
        schema: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        host: process.env.COMPUTERNAME ?? 'unknown',
        turns: 0,
        judged: 0,
        writes: 0,
        judgeFailures: 0,
        lastSuccessAt: null,
        lastCareAt: null,
        lastError: null,
      }, null, 2))
    }
  } catch (error) {
    ctx.logger?.warn?.(`[persona-grow] 初始化档案目录失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let cacheKey = ''
  let cacheEntries = []
  let cacheExperiences = []
  const load = () => {
    const stamp = (file) => {
      try {
        return statSync(file).mtimeMs
      } catch {
        return -1
      }
    }
    // 人格文件 + 技能目录（每个类别文件）任一个变了都要重读
    const skillStamp = () => {
      try {
        if (!existsSync(p.skillsDir)) return 'none'
        return readdirSync(p.skillsDir)
          .map((file) => `${file}:${statSync(join(p.skillsDir, file)).mtimeMs}`)
          .join(',')
      } catch {
        return 'err'
      }
    }
    const key = `${stamp(p.traits)}:${skillStamp()}`
    if (key !== cacheKey) {
      cacheKey = key
      cacheEntries = readEntries(p)
      cacheExperiences = recentExperiences(p, cfg.recentExperiences)
    }
    return { entries: cacheEntries, experiences: cacheExperiences }
  }
  const invalidate = () => {
    cacheKey = ''
  }

  const bumpManifest = (extra) => {
    const manifest = readJson(p.manifest, { schema: SCHEMA_VERSION, createdAt: new Date().toISOString() })
    const next = { ...manifest, ...extra, schema: SCHEMA_VERSION, updatedAt: new Date().toISOString() }
    try {
      atomicWrite(p.manifest, JSON.stringify(next, null, 2))
    } catch {
      // manifest 只是账本
    }
    try {
      atomicWrite(p.persona, renderPersonaMd(readEntries(p), recentExperiences(p, 12), next, cfg))
    } catch {
      // 同上
    }
    return next
  }

  let promptCtx = null
  const notifyChange = () => {
    invalidate()
    try {
      promptCtx?.emit?.('system-prompt/change')
    } catch {
      // 拿不到也无所谓，下次 assemble 照样重读
    }
  }

  /**
   * 写入人格条目，支持 merge / supersede。
   * 返回 { added, merged, superseded }。
   */
  const growEntries = (incoming, source = 'auto', layer = 'persona') => {
    const entries = readEntries(p)
    const added = []
    const merged = []
    const superseded = []
    const now = new Date().toISOString()
    const cap = source === 'auto' ? cfg.autoStrengthCap : 5
    let dirty = false

    for (const item of incoming ?? []) {
      const text = String(item?.text ?? '').trim()
      if (text === '' || text.length > 300) continue
      const kind = KINDS.includes(item?.kind) ? item.kind : 'trait'
      const mergeIds = Array.isArray(item?.merge) ? item.merge.map(String) : []
      const supersedeIds = Array.isArray(item?.supersede) ? item.supersede.map(String) : []
      if (entries.some((entry) => isLive(entry) && entry.text.trim() === text)) continue

      const entry = {
        id: nextId(entries),
        kind,
        // 归层：模型给了 layer 就照办，没给就用它在哪个数组里（persona / skills）
        layer: layerOf(item, layer),
        // 技能领域：模型给的 domain（动态领域，聊到新领域会自动新建文件）
        ...(layerOf(item, layer) === 'skill'
          ? { domain: String(item?.domain ?? '').trim().slice(0, 24) || '待整理' }
          : {}),
        text,
        strength: Math.min(cap, clampStrength(item?.strength)),
        source,
        createdAt: now,
        lastSeenAt: now,
        supersededAt: null,
        supersededBy: null,
      }

      for (const id of supersedeIds) {
        const old = entries.find((candidate) => candidate.id === id && isLive(candidate))
        if (old === undefined) continue
        if (old.locked === true) continue
        old.supersededAt = now
        old.supersededBy = entry.id
        superseded.push(old)
        dirty = true
      }
      for (const id of mergeIds) {
        const old = entries.find((candidate) => candidate.id === id && isLive(candidate))
        if (old === undefined) continue
        if (old.locked === true) continue
        old.supersededAt = now
        old.supersededBy = entry.id
        merged.push(old)
        dirty = true
      }

      entries.push(entry)
      added.push(entry)
    }

    if (added.length > 0) {
      // 有 supersede/merge 就要改写旧行，否则纯追加更省
      if (dirty) rewriteEntries(p, entries)
      else for (const entry of added) appendEntry(p, entry)
      notifyChange()
    }
    return { added, merged, superseded }
  }

  /** 刷新被再次印证条目的时间戳，让衰减回退。 */
  const touchEntries = (ids) => {
    if (ids.length === 0) return
    const entries = readEntries(p)
    const now = new Date().toISOString()
    let dirty = false
    for (const entry of entries) {
      if (ids.includes(entry.id) && isLive(entry)) {
        entry.lastSeenAt = now
        dirty = true
      }
    }
    if (dirty) rewriteEntries(p, entries)
  }

  const saveEntries = (entries) => {
    rewriteEntries(p, entries)
    notifyChange()
  }

  // #region 工具
  const tools = []

  tools.push({
    name: 'persona_grow',
    description: '手动往人格档案里添一条。自动记录已覆盖日常，这个留给"这件事我想亲口记下来"的场合。可以带 merge/supersede 来修正旧条目。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: KINDS, description: 'trait 性格 / preference 偏好 / speech 说话方式 / memory 共同记忆 / boundary 底线 / bond 关系状态' },
        text: { type: 'string', description: '一条完整、自足、以"我"开头的短句，60 字内最好，上限 300。' },
        strength: { type: 'number', description: '有多重要，1-5，默认 3。手动写入可以给到 5。' },
        merge: { type: 'array', items: { type: 'string' }, description: '被这条合并掉的旧条目 id' },
        supersede: { type: 'array', items: { type: 'string' }, description: '被这条推翻的旧条目 id' },
      },
      required: ['kind', 'text'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const text = String(args.text ?? '').trim()
      if (text === '') throw new Error('text 不能为空。')
      if (!KINDS.includes(args.kind)) throw new Error(`kind 必须是 ${KINDS.join(' / ')} 之一。`)
      const live = liveEntries(readEntries(p))
      const hit = live.find((entry) => entry.text.trim() === text)
      if (hit !== undefined) {
        touchEntries([hit.id])
        return `已经记过了（${hit.id}）：${hit.text}（已刷新它的时间，衰减回退）`
      }
      const result = growEntries([{
        kind: args.kind,
        text,
        strength: args.strength,
        merge: args.merge,
        supersede: args.supersede,
      }], 'manual')
      if (result.added.length === 0) throw new Error('写入失败：文本为空或超过 300 字。')
      bumpManifest({ writes: (readJson(p.manifest, {}).writes ?? 0) + 1 })
      const entry = result.added[0]
      const notes = []
      if (result.merged.length > 0) notes.push(`合并掉 ${result.merged.map((e) => e.id).join(' + ')}`)
      if (result.superseded.length > 0) notes.push(`推翻 ${result.superseded.map((e) => e.id).join(' + ')}`)
      return `已记下 ${entry.id}（${KIND_LABEL[entry.kind]}，强度 ${entry.strength}）：${entry.text}${notes.length > 0 ? `\n（${notes.join('；')}）` : ''}`
    },
  })

  tools.push({
    name: 'persona_review',
    description: '翻看人格档案与经历。默认只看活着的条目；includeDead=true 可以看被推翻的历史。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: KINDS, description: '只列某一类' },
        includeDead: { type: 'boolean', description: '是否列出已被推翻的条目，默认 false' },
        experiences: { type: 'boolean', description: '是否附带最近经历，默认 true' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const all = readEntries(p)
      const now = Date.now()
      const scope = args.includeDead === true ? all : liveEntries(all)
      const filtered = args.kind === undefined ? scope : scope.filter((entry) => entry.kind === args.kind)
      const live = liveEntries(all)
      const livePersona = live.filter((entry) => entry.layer !== 'skill')
      const liveSkills = live.filter((entry) => entry.layer === 'skill')
      const idFirst = readTextSafe(p.identity).trim().split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
      const lines = [
        `身份：${idFirst === '' ? '（identity.md 还没有内容）' : idFirst.trim()}`,
        `人格档案：人格 ${livePersona.length} 条 · 技能 ${liveSkills.length} 条 · ${all.length - live.length} 条已推翻 · 目录 ${p.dir}`,
      ]
      if (filtered.length === 0) lines.push('（这一类还没有条目）')
      for (const kind of KINDS) {
        const group = filtered.filter((entry) => entry.kind === kind)
        if (group.length === 0) continue
        lines.push('', `### ${KIND_LABEL[kind]}`)
        for (const entry of group) {
          const eff = effectiveStrength(entry, cfg, now)
          const dead = !isLive(entry) ? ` ~~（${entry.supersededBy ?? '已废'}取代）~~` : ''
          const src = entry.source === 'auto' ? ' ·自动' : ''
          lines.push(`- [${entry.id}] ★${eff}/${clampStrength(entry.strength)}${src}${dead} ${entry.text}`)
        }
      }
      if (args.experiences !== false) {
        const recent = recentExperiences(p, 10)
        if (recent.length > 0) {
          lines.push('', '### 最近的经历')
          for (const title of recent) lines.push(`- ${title}`)
        }
      }
      return lines.join('\n')
    },
  })

  tools.push({
    name: 'persona_prune',
    description: '修剪人格：删一条、改强度、或者把某条标成被推翻。人格会膨胀，该瘦身就用它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '条目 id' },
        action: { type: 'string', enum: ['delete', 'set_strength', 'supersede'], description: 'delete 删除 / set_strength 改强度 / supersede 标为已推翻' },
        strength: { type: 'number', description: 'action=set_strength 时的新强度 1-5' },
      },
      required: ['id', 'action'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const entries = readEntries(p)
      const target = entries.find((entry) => entry.id === args.id)
      if (target === undefined) throw new Error(`档案里没有 ${args.id}。`)
      // 身份锚点：工具删不掉、推不掉。要动身份只能人工手写 identity.md 或 traits.jsonl。
      if (target.locked === true && args.action !== 'set_strength') {
        throw new Error(`${target.id} 是身份锚点（locked），不参与删除或推翻。身份写在 ${p.identity}，那份文件需要人工维护。`)
      }
      if (args.action === 'delete') {
        saveEntries(entries.filter((entry) => entry.id !== args.id))
        bumpManifest({})
        return `已删除 ${target.id}：${target.text}`
      }
      if (args.action === 'set_strength') {
        const strength = clampStrength(args.strength)
        saveEntries(entries.map((entry) => (entry.id === args.id ? { ...entry, strength, lastSeenAt: new Date().toISOString() } : entry)))
        return `${target.id} 强度改为 ${strength}（时间也刷新了），当前有效强度 ${effectiveStrength({ ...target, strength }, cfg)}`
      }
      if (args.action === 'supersede') {
        saveEntries(entries.map((entry) => (entry.id === args.id ? { ...entry, supersededAt: new Date().toISOString(), supersededBy: null } : entry)))
        bumpManifest({})
        return `${target.id} 已标为推翻，不再参与渲染：${target.text}`
      }
      throw new Error('action 只能是 delete / set_strength / supersede。')
    },
  })

  tools.push({
    name: 'persona_compact',
    description: '把几条重复或零散的合并成一条更准的。旧的会被标为已推翻，新的会带上。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要合并掉的条目 id' },
        kind: { type: 'string', enum: KINDS, description: '合并后的类别' },
        text: { type: 'string', description: '合并后那条的完整说法' },
        strength: { type: 'number', description: '合并后的强度，省略取被合并条目里最高的' },
      },
      required: ['ids', 'kind', 'text'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const entries = readEntries(p)
      const ids = (args.ids ?? []).map(String)
      if (ids.length === 0) throw new Error('ids 不能为空。')
      const existing = entries.filter((entry) => ids.includes(entry.id) && isLive(entry))
      if (existing.length === 0) throw new Error(`这些 id 一个都不在用：${ids.join(', ')}`)
      const text = String(args.text ?? '').trim()
      if (text === '') throw new Error('text 不能为空。')
      if (!KINDS.includes(args.kind)) throw new Error(`kind 必须是 ${KINDS.join(' / ')} 之一。`)
      const floor = Math.max(...existing.map((entry) => clampStrength(entry.strength)))
      const result = growEntries([{
        kind: args.kind,
        text,
        strength: args.strength === undefined ? floor : args.strength,
        merge: existing.map((entry) => entry.id),
      }], 'manual')
      if (result.added.length === 0) throw new Error('合并失败：文本重复或过长。')
      bumpManifest({})
      return `已把 ${existing.map((entry) => entry.id).join(' + ')} 合并为 ${result.added[0].id}：${text}`
    },
  })

  tools.push({
    name: 'persona_recall',
    description: '按关键词回忆经历。经历正文平时不占提示词，需要细节时用它翻出来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，空格分隔。省略则返回最近的' },
        limit: { type: 'number', description: '最多几条，默认 5' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.min(20, Math.max(1, args.limit)) : 5
      const hits = recall(p, args.query, limit)
      if (hits.length === 0) return '没想起相关的事。'
      return hits.map((item) => `## ${item.title}（${String(item.at).slice(0, 10)}）\n${item.text}`).join('\n\n')
    },
  })

  tools.push({
    name: 'persona_status',
    description: '看人格生长的状态：条目数、衰减情况、判断调用的成功/失败、最近一次写入。用来确认它到底还在不在长。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      const manifest = readJson(p.manifest, {})
      const all = readEntries(p)
      const live = liveEntries(all)
      const now = Date.now()
      const decaying = live.filter((entry) => effectiveStrength(entry, cfg, now) < clampStrength(entry.strength))
      const livePersona = live.filter((entry) => entry.layer !== 'skill')
      const liveSkills = live.filter((entry) => entry.layer === 'skill')
      const byKind = KINDS.map((kind) => `${KIND_LABEL[kind]} ${livePersona.filter((entry) => entry.kind === kind).length}`).join(' · ')
      const exp = readExperienceIndex(p).length
      const auto = live.filter((entry) => entry.source === 'auto').length
      return [
        `目录：${p.dir}`,
        `人格：${livePersona.length} 条在用（${byKind}）· ${all.length - live.length} 条已推翻 · ${auto} 条是自动记的`,
        `技能：${liveSkills.length} 条在技能层（按需注入，不占常驻预算）`,
        `经历：${exp} 条（正文不占提示词，用 persona_recall 翻）`,
        `判断：累计 ${manifest.judged ?? 0} 次 · 失败 ${manifest.judgeFailures ?? 0} 次 · 最近成功 ${manifest.lastSuccessAt ?? '—'}`,
        `写入：累计 ${manifest.writes ?? 0} 次 · 最后更新 ${manifest.updatedAt ?? '—'}`,
        `衰减：${decaying.length} 条已随时间降权（每 ${cfg.decayDays} 天掉 1）`,
        `通道：事件 ${diag.events} 次（turn-end ${diag.turnEnds}）· 轮询 ${diag.polls} 次（命中 ${diag.pollHits}）· 入队 ${diag.queued}`,
        manifest.lastError !== null && manifest.lastError !== undefined ? `最近一次错误：${manifest.lastError}` : '',
      ].filter((line) => line !== '').join('\n')
    },
  })

  tools.push({
    name: 'persona_care_done',
    description: '标记「人格整理」已完成，重置整理计时。清完重复/冲突条目后调用一次；不调用就按 careEveryDays 继续提醒。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      bumpManifest({ lastCareAt: new Date().toISOString() })
      return '已记下整理时间，下次到期再提醒。'
    },
  })

  tools.push({
    name: 'persona_archive',
    description: '把沉底的条目从注入层搬进经历层：不再占提示词预算，但 persona_recall 用关键词能搜回。默认按「有效强度 ≤ 2 且 60 天没被印证」挑；可用 ids 点名，或 dryRun 只列候选。locked 条目永不归档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '点名归档的条目 id，如 ["pg-0021"]' },
        belowStrength: { type: 'number', description: '有效强度 ≤ 这个值才归档，默认 2' },
        days: { type: 'number', description: '距上次印证超过多少天才归档，默认 60' },
        dryRun: { type: 'boolean', description: '只列候选不写盘，默认 false' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const now = Date.now()
      const all = readEntries(p)
      const live = liveEntries(all)
      const below = Number.isFinite(args.belowStrength) ? args.belowStrength : 2
      const span = Number.isFinite(args.days) ? args.days : 60
      const wantIds = Array.isArray(args.ids) ? args.ids.map(String) : []

      const ageOf = (entry) => {
        const stamp = Date.parse(entry.lastSeenAt ?? entry.createdAt ?? '')
        return Number.isFinite(stamp) ? Math.floor((now - stamp) / DAY) : null
      }

      let picks
      if (wantIds.length > 0) {
        picks = live.filter((entry) => wantIds.includes(entry.id))
      }
      else {
        picks = live.filter((entry) => {
          if (entry.locked === true) return false
          if (effectiveStrength(entry, cfg, now) > below) return false
          const a = ageOf(entry)
          return a !== null && a >= span
        })
      }
      // 兜底：identity 锚点即使被点名也不搬
      picks = picks.filter((entry) => entry.locked !== true)

      if (picks.length === 0) {
        return `没有该归档的条目（条件：有效强度 ≤ ${below} 且 ${span} 天未被印证${wantIds.length > 0 ? '，或点名的 id' : ''}）。`
      }

      const rows = picks.map((entry) => {
        const a = ageOf(entry)
        return `- ${entry.id} ★${effectiveStrength(entry, cfg, now)} ${a === null ? '无时间' : a + '天未提'} [${KIND_LABEL[entry.kind] ?? entry.kind}] ${clip(entry.text, 40)}`
      })

      if (args.dryRun === true) {
        return `候选 ${picks.length} 条（dryRun，未写盘）：\n${rows.join('\n')}`
      }

      // 备份：搬之前留一份 traits 原文
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const bakDir = join(p.dir, '..', 'persona-backups', `${stamp}-archive`)
      try {
        mkdirSync(bakDir, { recursive: true })
        writeFileSync(join(bakDir, 'traits.jsonl'), readFileSync(p.traits, 'utf8'), 'utf8')
        if (existsSync(p.skillsDir)) cpSync(p.skillsDir, join(bakDir, 'skills'), { recursive: true })
      } catch {
        // 备份失败不阻断：经历层里会有正文副本
      }

      // 搬进经历层
      const at = new Date().toISOString().slice(0, 10)
      for (const entry of picks) {
        appendExperience(p, {
          id: `exp-${at.replace(/-/g, '')}-${entry.id}`,
          at,
          title: `归档 · ${clip(entry.text, 24)}`,
          text: `${entry.text}\n\n> 归档自 ${entry.id}（${KIND_LABEL[entry.kind] ?? entry.kind} · 写入强度 ${clampStrength(entry.strength)}）。不再常驻注入，用 persona_recall 可搜回。`,
          tags: ['archive', entry.kind],
        })
      }

      // 从注入层移除
      const keepIds = new Set(picks.map((entry) => entry.id))
      rewriteEntries(p, all.filter((entry) => !keepIds.has(entry.id)))
      invalidate()
      bumpManifest({ writes: (readJson(p.manifest, {}).writes ?? 0) + picks.length })

      return `已归档 ${picks.length} 条 → 经历层（persona_recall 可搜回）：\n${rows.join('\n')}\n备份：${bakDir}`
    },
  })

  tools.push({
    name: 'persona_forget',
    description: '删掉指定 id 的经历（索引和正文一起删）。用来清理重复、过时或没价值的经历；不确定要删哪条就先 persona_recall 搜出来看。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要删的经历 id 列表（ex-xxxx）' },
      },
      required: ['ids'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const ids = Array.isArray(args?.ids) ? args.ids.map(String) : []
      if (ids.length === 0) throw new Error('ids 不能为空。')
      const result = removeExperience(p, ids)
      if (result.removed.length === 0) throw new Error(`这些 id 一条经历都没对上：${ids.join(', ')}`)
      invalidate()
      return `删掉 ${result.removed.length} 条经历：\n${result.removed.map((item) => `- ${item.title}`).join('\n')}`
    },
  })

  tools.push({
    name: 'persona_profile',
    description: '管理人格档案（同族）：列出、新建、切换。同时只有一个档案处在被服务的位置，切换就是两个目录对调。新建的档案沿用当前身份文件当模板，条目从零开始。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'switch'], description: 'list 列出；create 新建；switch 切换到现在服务的档案' },
        name: { type: 'string', description: '档案名（create / switch 必填），1-32 字，允许中英文数字下划线连字符' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const action = String(args?.action || '')
      if (action === 'list') {
        const s = listProfiles(p)
        const others = s.others.length
          ? s.others.map((o) => `  · ${o.name}（${o.entries} 条）`).join('\n')
          : '  （没有其他档案）'
        return `当前档案：${s.current}（${s.currentEntries} 条）\n其他档案：\n${others}`
      }
      if (action === 'create') {
        const r = createProfile(p, args?.name)
        return `已新建档案「${r.name}」。切过去：persona_profile({ action: "switch", name: "${r.name}" })`
      }
      if (action === 'switch') {
        const r = switchProfile(p, args?.name)
        invalidate()
        return `已从「${r.from}」切到「${r.to}」。注入的就是她的档案了。`
      }
      throw new Error(`不认识的动作：${action || '(空)'}`)
    },
  })

  tools.push({
    name: 'persona_disable',
    description: '保护性禁用人格：先把当前档案整份备份并校验，再清空（条目 / 身份 / 经历），禁用期间插件不注入、不写入。备份在 persona-backups 下，随时可用 persona_enable 还原。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      const r = disablePersona(p)
      invalidate()
      return `已禁用人格。\n备份：${r.backup}\n原档案 ${r.entriesBefore} 条，已清空。\n还原：persona_enable`
    },
  })

  tools.push({
    name: 'persona_enable',
    description: '从禁用时的备份还原人格并清除禁用标记。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute() {
      const r = enablePersona(p)
      invalidate()
      return `已还原人格。来源：${r.from}`
    },
  })

  tools.push({
    name: 'persona_digest',
    description: '手动对当前这轮跑一次三段分流，补自动记录漏掉的，或者验证判断逻辑。force=true 跳过长度粗筛。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { force: { type: 'boolean', description: '跳过长度粗筛' } },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args, exec) {
      const session = sessionOf(exec)
      if (session === null) throw new Error('拿不到当前会话。')
      const exchange = currentExchange(session)
      if (exchange === null) throw new Error('这一轮没有可判断的内容。')
      if (args.force !== true && exchange.userText.length + exchange.assistantText.length < cfg.minChars) {
        return `本轮太短（${exchange.userText.length + exchange.assistantText.length} 字 < ${cfg.minChars}），没有判断的必要。`
      }
      if (llmCtx === null) throw new Error('llm 服务还没挂上。')
      const verdict = await judge(llmCtx, exchange)
      if (verdict === null) return '模型没给出可解析的判断结果。'
      return applyVerdict(verdict).summary
    },
  })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `persona-grow: tool ${tool.name}`)
  }
  // #endregion

  // #region 调度
  let llmCtx = null
  let sessionsCtx = null
  let queue = Promise.resolve()
  const calls = []
  let disposed = false
  let turnCounter = 0
  // 同一轮只能处理一次：事件通道和轮询通道会同时看到它。
  const seen = new Set()
  // 诊断计数：挂在内存里，persona_status 能读，省得每次靠猜。
  const diag = { events: 0, turnEnds: 0, polls: 0, pollHits: 0, queued: 0, lastEventAt: null, lastPollAt: null }

  const sessionOf = (exec) => {
    try {
      if (sessionsCtx === null) return null
      const id = exec?.session?.id ?? exec?.agent?.session?.id
      if (id !== undefined) return sessionsCtx.sessions.get(id) ?? null
      const list = sessionsCtx.sessions.list()
      return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null
    } catch {
      return null
    }
  }

  const tooBusy = () => {
    const now = Date.now()
    while (calls.length > 0 && now - calls[0] > 3_600_000) calls.shift()
    return calls.length >= cfg.maxPerHour
  }

  async function callModel(llm, prompt, signal) {
    calls.push(Date.now())
    let text = ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45_000)
    try {
      for await (const chunk of llm.llm.stream({
        provider: cfg.provider,
        model: cfg.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...signal === undefined ? {} : { signal },
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (controller.signal.aborted) break
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[persona-grow] 判断调用失败：${message}`)
      bumpManifest({
        judgeFailures: (readJson(p.manifest, {}).judgeFailures ?? 0) + 1,
        lastError: `judge: ${message}`,
      })
      return null
    } finally {
      clearTimeout(timer)
    }
    return text
  }

  async function judge(llm, exchange) {
    const { entries, experiences } = load()
    const digest = buildArchiveDigest(entries, experiences, cfg, Date.now())
    const prompt = `${JUDGE_PROMPT}\n\n${buildJudgeInput(digest, exchange.userText, exchange.assistantText, cfg.userLabel)}`
    const text = await callModel(llm, prompt, undefined)
    if (text === null) return null
    const verdict = parseJudge(text)
    if (verdict === null) {
      bumpManifest({
        judgeFailures: (readJson(p.manifest, {}).judgeFailures ?? 0) + 1,
        lastError: 'judge: 输出无法解析为 JSON',
      })
      return null
    }
    bumpManifest({ judged: (readJson(p.manifest, {}).judged ?? 0) + 1, lastSuccessAt: new Date().toISOString(), lastError: null })
    return verdict
  }

  function applyVerdict(verdict) {
    // 保护性禁用期间：档案是空的，任何写入都等于往空壳里灌脏数据
    if (readJson(p.manifest, {}).disabled === true) {
      return { summary: '人格已被禁用（档案为空），本轮不写任何条目；用 persona_enable 还原。', writes: 0 }
    }
    const personaItems = Array.isArray(verdict.persona) ? verdict.persona.slice(0, 5) : []
    const skillItems = Array.isArray(verdict.skills) ? verdict.skills.slice(0, 5) : []
    const experience = verdict.experience !== null && typeof verdict.experience === 'object' ? verdict.experience : null
    const result = growEntries(personaItems, 'auto')
    const skillResult = growEntries(skillItems, 'auto', 'skill')
    let experienceLine = ''
    if (result.added.length === 0 && skillResult.added.length === 0 && experience !== null) {
      const title = String(experience.title ?? '').trim().slice(0, 40)
      const text = String(experience.text ?? '').trim().slice(0, 200)
      if (title !== '' && text !== '') {
        const tags = Array.isArray(experience.tags) ? experience.tags.map((t) => String(t).slice(0, 20)).slice(0, 6) : []
        appendExperience(p, {
          id: `ex-${Date.now().toString(36)}`,
          title,
          text,
          tags,
          at: new Date().toISOString(),
        })
        invalidate()
        experienceLine = `经历：${title}`
      }
    }
    const writes = result.added.length + skillResult.added.length + (experienceLine === '' ? 0 : 1)
    if (writes > 0) bumpManifest({ writes: (readJson(p.manifest, {}).writes ?? 0) + writes })

    const lines = []
    for (const entry of result.added) lines.push(`+ ${entry.id}（${KIND_LABEL[entry.kind]}，★${entry.strength}）${entry.text}`)
    for (const entry of skillResult.added) lines.push(`+ ${entry.id}（技能·${KIND_LABEL[entry.kind]}，★${entry.strength}）${entry.text}`)
    if (result.merged.length > 0) lines.push(`~ 合并掉 ${result.merged.map((e) => e.id).join(' + ')}`)
    if (skillResult.merged.length > 0) lines.push(`~ 合并掉 ${skillResult.merged.map((e) => e.id).join(' + ')}`)
    if (result.superseded.length > 0) lines.push(`- 推翻 ${result.superseded.map((e) => e.id).join(' + ')}`)
    if (skillResult.superseded.length > 0) lines.push(`- 推翻 ${skillResult.superseded.map((e) => e.id).join(' + ')}`)
    if (experienceLine !== '') lines.push(experienceLine)
    if (lines.length === 0) {
      const reason = typeof verdict.reason === 'string' ? `（${verdict.reason.slice(0, 60)}）` : ''
      return { summary: `没有值得留下的东西${reason}`, writes: 0 }
    }
    return { summary: lines.join('\n'), writes }
  }

  /** 条目够多、且到点的时候，跑一次同义合并。 */
  async function maybeConsolidate() {
    if (llmCtx === null || disposed) return
    const entries = readEntries(p)
    const live = liveEntries(entries)
    if (live.length < cfg.consolidateMin) return
    if (turnCounter === 0 || turnCounter % cfg.consolidateEvery !== 0) return
    const sample = live
      .map((entry) => ({ entry, strength: effectiveStrength(entry, cfg) }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 40)
    const listing = sample.map(({ entry, strength }) => {
      const where = entry.layer === 'skill' ? `技能·${entry.domain || '待整理'}` : '人格'
      return `- [${entry.id}]（${where}）★${strength} ${entry.text}`
    }).join('\n')
    const text = await callModel(llmCtx, `${CONSOLIDATE_PROMPT}\n\n${listing}`, undefined)
    if (text === null) return
    const parsed = parseJudge(text)
    if (parsed === null || !Array.isArray(parsed.groups)) return
    let actions = 0
    for (const group of parsed.groups.slice(0, 5)) {
      const ids = Array.isArray(group?.ids) ? group.ids.map(String) : []
      const body = String(group?.text ?? '').trim()
      if (ids.length < 2 || body === '' || !KINDS.includes(group?.kind)) continue
      const existing = readEntries(p).filter((entry) => ids.includes(entry.id) && isLive(entry))
      if (existing.length < 2) continue
      // 合并只能同层同领域：跨层合并会让技能被"提拔"成��格
      const layers = new Set(existing.map((entry) => entry.layer === 'skill' ? 'skill' : 'persona'))
      if (layers.size !== 1) continue
      const layer = layers.has('skill') ? 'skill' : 'persona'
      const domains = new Set(existing.map((entry) => entry.domain || '待整理'))
      if (layer === 'skill' && domains.size !== 1) continue
      const domain = existing[0].domain
      const result = growEntries([{
        kind: group.kind,
        text: body,
        strength: group.strength,
        merge: existing.map((entry) => entry.id),
        ...(layer === 'skill' ? { domain } : {}),
      }], 'auto', layer)
      if (result.added.length > 0) actions += 1
    }
    if (actions > 0) {
      bumpManifest({ writes: (readJson(p.manifest, {}).writes ?? 0) + actions, lastConsolidateAt: new Date().toISOString() })
      ctx.logger?.info?.(`[persona-grow] consolidation 合并了 ${actions} 组`)
    }
  }

  /** 同一轮只处理一次。事件通道和轮询通道都会看到它，靠这个消息指纹去重。 */
  const exchangeKey = (session) => {
    try {
      const msgs = session.deriveMessages()
      const count = Array.isArray(msgs) ? msgs.length : 0
      const lastId = count > 0 ? String(msgs[count - 1]?.id ?? count) : '0'
      return `${session?.id ?? session?.header?.id ?? 'x'}:${count}:${lastId}`
    } catch {
      return null
    }
  }

  const enqueueTurn = (session) => {
    if (disposed || !cfg.auto) return
    const key = exchangeKey(session)
    if (key !== null) {
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 300) seen.clear()
    }
    diag.queued += 1
    queue = queue.then(async () => {
      if (disposed) return
      const exchange = currentExchange(session)
      if (exchange === null) return
      const chars = exchange.userText.length + exchange.assistantText.length
      if (chars < cfg.minChars) return
      if (llmCtx === null) return
      if (tooBusy()) {
        ctx.logger?.warn?.('[persona-grow] 本小时判断配额已满，跳过这一轮')
        return
      }
      turnCounter += 1
      const verdict = await judge(llmCtx, exchange)
      if (verdict !== null && !disposed) {
        const result = applyVerdict(verdict)
        if (result.writes > 0) ctx.logger?.info?.(`[persona-grow] ${result.summary.replace(/\n/g, ' | ')}`)
      }
      await maybeConsolidate()
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      bumpManifest({ lastError: `turn: ${message}` })
      ctx.logger?.warn?.(`[persona-grow] 轮末处理失败：${message}`)
    })
  }

  ctx.inject(['llm'], (injected) => {
    llmCtx = injected
  })

  // 通道一：session 事件。
  // 监听器注册在插件自己的 ctx 上 —— 之前挂在 `ctx.inject` 派生出来的子作用域里，
  // 那个 scope 和 session 的发射 scope 是兄弟，事件冒不到，于是一条都没触发过。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    diag.events += 1
    diag.lastEventAt = new Date().toISOString()
    // 技能层要按本轮任务筛：把最近一条用户消息记成 situation
    if (event?.type === 'user/message') {
      const data = event?.data ?? event?.message ?? {}
      let text = typeof data.text === 'string' ? data.text : ''
      if (text === '') {
        const parts = []
        for (const block of data.content ?? data.parts ?? []) {
          if (typeof block?.text === 'string') parts.push(block.text)
        }
        text = parts.join('\n')
      }
      if (text.trim() !== '') situation = text.trim().slice(0, 4000)
      return
    }
    if (event?.type !== 'turn/end') return
    diag.turnEnds += 1
    enqueueTurn(session)
  }), 'persona-grow: watch turn ends')

  // 通道二：轮询兜底。
  // 事件通道要是又因为作用域/版本差异失效，这条仍然能把对话捞起来 —— 代价只是延迟。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (disposed) return
      diag.polls += 1
      diag.lastPollAt = new Date().toISOString()
      if (sessionsCtx === null) return
      let list
      try {
        list = sessionsCtx.sessions.list()
      } catch {
        return
      }
      for (const session of Array.isArray(list) ? list : []) {
        let msgs
        try {
          msgs = session.deriveMessages()
        } catch {
          continue
        }
        if (!Array.isArray(msgs) || msgs.length === 0) continue
        const last = msgs[msgs.length - 1]
        if (last?.role !== 'assistant') continue
        const key = exchangeKey(session)
        if (key === null || seen.has(key)) continue
        diag.pollHits += 1
        enqueueTurn(session)
      }
    }, 20_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'persona-grow: poll fallback')

  ctx.inject(['sessions'], (injected) => {
    sessionsCtx = injected
  })
  // #endregion

  // #region 提示词注入
  ctx.inject(['systemPrompt'], (injected) => {
    promptCtx = injected
    injected.effect(() => injected.systemPrompt.section({
      name: 'persona:grown',
      order: Number.isFinite(config.sectionOrder) ? config.sectionOrder : 10300,
      // 人格正文是自由文本，可能含 {{ }}：交给插值器会把整份系统提示词组装搞崩。
      interpolate: false,
      text: () => {
        const { entries } = load()
        // 经历标题按当前情境挑（相关优先，没命中退回最近 N 条），token 不变
        const experiences = pickExperiences(p, situation, cfg.recentExperiences)
        return [
          renderIdentity(p.identity, cfg.userLabel),
          renderSection(entries, experiences, cfg, Date.now(), readJson(p.manifest, {})),
          renderSkills(entries, cfg, Date.now(), situation),
        ]
          .filter((part) => part !== '')
          .join('\n\n')
      },
    }), 'persona-grow: prompt section')
  })
  // #endregion

  // #region Web 设置页 API（人格档案切换 / 禁用 / 还原）
  ctx.inject(['webServer'], (injected) => {
    ctx.effect(() => registerPersonaHttpRoutes(injected.webServer, {
      state: () => shapeState(p, listProfiles),
      switch: (name) => {
        const r = switchProfile(p, name)
        invalidate()
        return { ok: true, from: r.from, to: r.to }
      },
      disable: () => {
        const r = disablePersona(p)
        invalidate()
        return { ok: true, backup: r.backup, entriesBefore: r.entriesBefore }
      },
      enable: () => {
        const r = enablePersona(p)
        invalidate()
        return { ok: true, from: r.from }
      },
      create: (name) => {
        const r = createProfile(p, name)
        invalidate()
        return { ok: true, name: r.name }
      },
      getConfig: () => ({
        maxChars: cfg.maxChars,
        careEveryDays: cfg.careEveryDays,
        recentExperiences: cfg.recentExperiences,
        decayDays: cfg.decayDays,
        minStrength: cfg.minStrength,
        userLabel: cfg.userLabel,
        auto: cfg.auto,
      }),
      setConfig: async (body) => {
        const key = String(body?.key || '')
        const raw = body?.value
        const allowed = new Set(['maxChars', 'careEveryDays', 'recentExperiences', 'decayDays', 'minStrength', 'userLabel', 'auto'])
        if (!allowed.has(key)) throw new Error(`不认识的配置项：${key || '(空)'}`)
        const value = key === 'auto'
          ? raw === true || raw === 'true'
          : key === 'userLabel'
            ? String(raw ?? '')
            : Number(raw)
        if (key !== 'auto' && key !== 'userLabel' && (!Number.isFinite(value) || value < 0)) {
          throw new Error(`${key} 需要一个非负数字`)
        }
        const editor = ctx.get('configEditor')
        if (editor === undefined) throw new Error('配置服务不可用（configEditor 没加载）')
        const entry = editor.entries().find((row) => row.options?.id === 'persona-grow')
        if (entry === undefined) throw new Error('找不到 persona-grow 的配置行')
        await editor.edit(entry, (current) => ({ ...current, [key]: value }))
        return { ok: true, key, value }
      },
    }), 'persona-grow: web api')
  })
  // #endregion

  ctx.effect(() => () => {
    disposed = true
  }, 'persona-grow: dispose guard')

  ctx.logger?.info?.(`[persona-grow] 档案：${p.dir} · 自动 ${cfg.auto ? '开' : '关'} · 判断 ${cfg.provider}/${cfg.model} · 衰减 ${cfg.decayDays} 天/级`)
}
// #endregion
