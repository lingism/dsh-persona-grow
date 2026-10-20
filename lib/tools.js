/**
 * 工具注册：13 个 persona_* 工具的定义与执行。
 *
 * 它们只依赖两个东西：容器路径 p、归一化配置 cfg，以及 apply 里造的几个闭包
 * （growEntries / touchEntries / saveEntries / bumpManifest / invalidate）。
 * 拆出来是为了让 index.js 只剩生命周期，不再混着 400 行工具 schema。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KINDS, KIND_LABEL, DAY } from './config.js'
import { readJson } from './storage.js'
import { clampStrength, effectiveStrength, isLive, liveEntries } from './strength.js'
import {
  readExperienceIndex, appendExperience, removeExperience, recentExperiences, recall,
} from './experiences.js'
import { readTextSafe } from './render.js'
import { clip, currentExchange } from './judge.js'
import {
  listProfiles, createProfile, switchProfile, disablePersona, enablePersona,
} from './profiles.js'

/**
 * 造一组工具定义。
 * @param {object} deps
 * @param {object} deps.p           容器路径
 * @param {object} deps.cfg         归一化配置
 * @param {Function} deps.growEntries
 * @param {Function} deps.touchEntries
 * @param {Function} deps.saveEntries
 * @param {Function} deps.bumpManifest
 * @param {Function} deps.invalidate
 * @param {Function} deps.readEntries
 * @param {Function} deps.sessionOf
 * @param {Function} deps.applyVerdict
 * @param {Function} deps.judgeModel   (llmCtx, exchange) => verdict
 * @param {Function} deps.getLlmCtx
 * @param {object}   deps.diag
 * @returns {object[]}
 */
export function buildPersonaTools(deps) {
  const {
    p, cfg, growEntries, touchEntries, saveEntries, bumpManifest, invalidate,
    readEntries, sessionOf, applyVerdict, judgeModel, getLlmCtx, diag,
  } = deps
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
      // 只允许同层同领域：跨层合并会把技能"提拔"成人格，跨域合并会让领域文件串味
      const layers = new Set(existing.map((entry) => (entry.layer === 'skill' ? 'skill' : 'persona')))
      if (layers.size !== 1) throw new Error('不能跨层合并：人格和技能要分开处理。')
      const layer = layers.has('skill') ? 'skill' : 'persona'
      const domains = new Set(existing.map((entry) => entry.domain || '待整理'))
      if (layer === 'skill' && domains.size !== 1) {
        throw new Error(`技能合并要在同一领域内，现在是：${[...domains].join(' / ')}`)
      }
      const domain = existing[0].domain
      const floor = Math.max(...existing.map((entry) => clampStrength(entry.strength)))
      const result = growEntries([{
        kind: args.kind,
        text,
        strength: args.strength === undefined ? floor : args.strength,
        merge: existing.map((entry) => entry.id),
        ...(layer === 'skill' ? { domain } : {}),
      }], 'manual', layer)
      if (result.added.length === 0) throw new Error('合并失败：文本重复或过长。')
      bumpManifest({})
      const where = layer === 'skill' ? `（技能·${domain}）` : ''
      return `已把 ${existing.map((entry) => entry.id).join(' + ')} 合并为 ${result.added[0].id}${where}：${text}`
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
      saveEntries(all.filter((entry) => !keepIds.has(entry.id)))
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
      // 经历删了，persona.md 的「最近的经历」也要跟着重生成，不然残留已删标题
      bumpManifest({})
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
      const llmCtx = getLlmCtx()
      if (llmCtx === null) throw new Error('llm 服务还没挂上。')
      const verdict = await judgeModel(llmCtx, exchange)
      if (verdict === null) return '模型没给出可解析的判断结果。'
      return applyVerdict(verdict).summary
    },
  })

  return tools
}
