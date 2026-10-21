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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Config, KINDS, KIND_LABEL, SCHEMA_VERSION, DAY } from './config.js'
import {
  resolveDir, paths, ensureDirs, readJson, atomicWrite, parseJsonl,
  readEntries, entriesToText, appendEntry, rewriteEntries, nextId,
} from './storage.js'
import { clampStrength, effectiveStrength, isLive, liveEntries } from './strength.js'
import {
  experienceFile, readExperienceIndex, appendExperience, removeExperience, recentExperiences, recall,
} from './experiences.js'
import { renderPersonaMd, FOLDER_README } from './render.js'
import { buildInjectedText } from './inject.js'
import {
  JUDGE_PROMPT, CONSOLIDATE_PROMPT, clip, buildArchiveDigest, buildJudgeInput,
  parseJudge, textOfMessage, currentExchange, stripRuntimeContext,
} from './judge.js'
import { buildPersonaTools } from './tools.js'
import { listProfiles, createProfile, switchProfile, disablePersona, enablePersona } from './profiles.js'
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

  function applyVerdict(verdict, onlyExperience = false) {
    // 保护性禁用期间：档案是空的，任何写入都等于往空壳里灌脏数据
    if (readJson(p.manifest, {}).disabled === true) {
      return { summary: '人格已被禁用（档案为空），本轮不写任何条目；用 persona_enable 还原。', writes: 0 }
    }
    // 生长关闭时：人格、技能都不写，让模型只负责总结经历
    const personaItems = onlyExperience ? [] : (Array.isArray(verdict.persona) ? verdict.persona.slice(0, 2) : [])
    const skillItems = onlyExperience ? [] : (Array.isArray(verdict.skills) ? verdict.skills.slice(0, 2) : [])
    const experience = verdict.experience !== null && typeof verdict.experience === 'object' ? verdict.experience : null
    const result = growEntries(personaItems, 'auto')
    const skillResult = growEntries(skillItems, 'auto', 'skill')
    let experienceLine = ''
    // 只有经历模式时无条件写经历；正常模式保持「人格/技能没新增才写经历」
    if ((onlyExperience || (result.added.length === 0 && skillResult.added.length === 0)) && experience !== null) {
      const title = String(experience.title ?? '').trim().slice(0, 40)
      // 正文不进提示词（只注入标题），所以可以写详细——recall 时才读
      const text = String(experience.text ?? '').trim().slice(0, 600)
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
    if (disposed) return
    // 同一轮去重：事件通道和轮询通道会先后看到它，两条通道都要用同一把钥匙
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
      // 生长关闭时只让模型总结经历：门槛抬高一倍，经历别涨太快
      if (chars < (cfg.auto ? cfg.minChars : cfg.minChars * 2)) return
      if (llmCtx === null) return
      if (tooBusy()) {
        ctx.logger?.warn?.('[persona-grow] 本小时判断配额已满，跳过这一轮')
        return
      }
      turnCounter += 1
      const verdict = await judge(llmCtx, exchange)
      if (verdict !== null && !disposed) {
        // 关掉生长：人格/技能都不写，模型只负责总结经历
        const result = applyVerdict(verdict, !cfg.auto)
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
      if (text.trim() !== '') situation = stripRuntimeContext(text).slice(0, 4000)
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
      text: () => buildInjectedText({
        p,
        cfg,
        situation,
        load,
        manifest: readJson(p.manifest, {}),
      }),
    }), 'persona-grow: prompt section')
  })
  // #endregion

  // #region Web 设置页 API（人格档案切换 / 禁用 / 还原）
  ctx.inject(['webServer'], (injected) => {
    ctx.effect(() => registerPersonaHttpRoutes(injected.webServer, {
      state: () => shapeState(p, listProfiles, cfg.auto),
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

  // 工具定义都搬去 tools.js 了；这里只负责造出来并注册（放在所有依赖定义之后）
  const tools = buildPersonaTools({
    p, cfg, growEntries, touchEntries, saveEntries, bumpManifest, invalidate,
    readEntries, sessionOf, applyVerdict, judgeModel: judge, getLlmCtx: () => llmCtx, diag,
  })
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `persona-grow: tool ${tool.name}`)
  }


  ctx.effect(() => () => {
    disposed = true
  }, 'persona-grow: dispose guard')

  ctx.logger?.info?.(`[persona-grow] 档案：${p.dir} · 自动 ${cfg.auto ? '开' : '关'} · 判断 ${cfg.provider}/${cfg.model} · 衰减 ${cfg.decayDays} 天/级`)
}
// #endregion
