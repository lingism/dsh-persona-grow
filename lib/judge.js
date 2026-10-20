/**
 * 判断层：把一轮对话 + 现有档案交给模型，判断该记人格、记经历、还是丢掉。
 *
 * 这里只有"准备输入 / 解析输出"的纯函数；真正调用模型的部分在 index.js 的 apply 里。
 */
import { KINDS, KIND_LABEL } from './config.js'
import { effectiveStrength, liveEntries } from './strength.js'

export const JUDGE_PROMPT = `你是一个人格档案的归档员。先读【现有档案】，再读【本轮对话】，判断这一轮该做什么。

**先记住：档案会胖。你的默认答案是「本轮不写」。** 只有下面四种情况真的成立时才写，写不超过 2 条：

四种结果，互斥，只挑最合适的一种：

1. **人格增量** —— 出现了关于"这个 agent 是谁"的**确定的新事实**：新的性格侧面、确定下来的偏好、新的说话习惯、一条决定守住的底线，或者"你们之间"的关系状态。写进 persona 数组。
2. **技能** —— 只有满足下面**至少一条**才写进 skills 数组：
   - **踩过坑**：这轮真的卡住过（报错、失败、走错路），后来找到了解法——试错出来的才值得记
   - **重复出现**：同一个做法这轮第二次用到（第一次可能是偶然，第二次才是套路）
   - **推翻旧的**：发现以前记的做法是错的（这种必须写，用 supersede）
   **"顺利执行一个已知流程"不写**——那本来就是技能库里该有的，写进来只是重复。
3. **难忘的经历** —— 既没有人格增量、也没有可复用技能，但这是一次值得记住的事：第一次做某件事、一个重要的决定、一段有分量的谈话。写进 experience。
4. **都不是** —— 寒暄、事务性问答、重复已知的事、本轮只是执行一个已知流程。全部留空。

**宁缺毋滥（重要）：**

- 已有的档案里**说过类似的话**，就不要写新的——除非你要用 merge/supersede 修正它。
- 只是"这轮做完了一件小事"不算——那是经历，不是技能；除非从中提炼出了**以后能复用的方法**。
- 拿不准写不写，就不写。**写多了比写少了危害大**（档案臃肿会让真正重要的条目被挤掉）。
- 每轮最多 2 条（persona + skills 合计）。

**分层的硬规则（逐条自问）：**

- 这句话里出现**文件名、路径、命令、配置项、工具名、代码、操作步骤**中的任何一样 → 进 skills。哪怕它写成"我……"的第一人称句式。
- 这句话描述的是**对方怎么待我、我怎么待对方、我说话的样子、我的情绪和原则** → 进 persona。
- 两条都像时问自己："换一个完全不同性格的人来做这件事，这句话还成立吗？" 成立的是技能，不成立的是人格。
- 不要因为一句技术话里出现"我"就把它当成人格。

写 persona 或 skills 条目时，每条可以带两个可选字段来修正旧认知：

- "merge": ["pg-0007"] —— 这条只是旧条目的更好说法时，用它把旧的合并掉。
- "supersede": ["pg-0003"] —— 这条**推翻了**旧条目时用（比如旧条目说"我不吃辣"，这轮确认了其实吃）。

只在确有把握时使用这两个字段；不要为了"清理"而乱指定 id。

**技能条目必须带 domain 字段**（领域名，2-6 个字）：
- **一律用中文**：不写 dsh / git / windows 这种英文名，写成「本体」「版本控制」「系统」。
- 用宽口径：聊到"点外卖 / 买菜 / 炒菜"都归「厨房」，不拆成一堆小类。
- 优先复用【现有技能领域】里列出的名字；都不适合才新起一个。
- 宁可归进最接近的现有领域，也别为一条新条目开一个新文件。

条目要求：一句自足的话，用第一人称"我"，不超过 60 字，不要解释，不要写"用户说"。
strength 1-5：5 只留给定义我是谁的核心，日常细节给 2-3。

只输出 JSON，不要解释，不要代码块围栏：
{"persona":[{"kind":"trait|preference|speech|memory|boundary|bond","text":"...","strength":3,"merge":[],"supersede":[]}],"skills":[{"kind":"trait|preference|speech|memory|boundary|bond","text":"...","strength":3,"domain":"领域名","merge":[],"supersede":[]}],"experience":{"title":"10字以内","text":"300字以内，写详细点：发生了什么、怎么解决的、有什么教训","tags":["..."]},"reason":"一句话"}

没有内容时：{"persona":[],"skills":[],"experience":null,"reason":"..."}`

export const CONSOLIDATE_PROMPT = `你是一个人格档案的整理员。下面是一批条目（每条前面标了所在层：人格 / 技能·领域），请找出其中语义重复或可以合并的组。

规则：
- 只合并真正重复或高度重叠的（说的是同一件事的不同措辞）。
- **只能合并同一层、同一领域的条目**：人格和技能不能混，技能和技能之间跨领域也不能混。
- 不要合并"相关但不同"的条目。
- 合并后的话要保留各条里的关键信息，用第一人称。
- 没有可合并的就返回空数组。

只输出 JSON，不要解释，不要代码块围栏：
{"groups":[{"ids":["pg-0001","pg-0005"],"kind":"trait","text":"合并后的说法","strength":4}]}`

export function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 给判断模型看的"现有档案摘要"（每类取前 N 条，免得喂爆）。 */
export function buildArchiveDigest(entries, experiences, config, now) {
  const live = liveEntries(entries)
    .map((entry) => ({ entry, strength: effectiveStrength(entry, config, now) }))
    .sort((a, b) => b.strength - a.strength)
  const lines = ['【现有档案】']
  if (live.length === 0) {
    lines.push('（空）')
  }
  else {
    let shown = 0
    for (const kind of KINDS) {
      const group = live.filter((item) => item.entry.kind === kind).slice(0, config.digestMaxPerKind)
      if (group.length === 0) continue
      lines.push(`${KIND_LABEL[kind]}：`)
      for (const { entry, strength } of group) {
        lines.push(`- [${entry.id}] ★${strength} ${entry.text}`)
        shown += 1
      }
    }
    if (shown < live.length) lines.push(`（另有 ${live.length - shown} 条较低权重的未列出）`)
  }
  if (experiences.length > 0) {
    lines.push('', '【最近的经历】')
    for (const title of experiences) lines.push(`- ${title}`)
  }
  // 现有技能领域：让模型优先复用，别每轮新起名字（领域文件会爆炸）
  const domains = new Set()
  for (const item of live) {
    if (item.entry.layer === 'skill' && item.entry.domain) domains.add(item.entry.domain)
  }
  if (domains.size > 0) {
    lines.push('', `【现有技能领域】${[...domains].sort().join(' / ')}`)
  }
  return lines.join('\n')
}

/** 判断输入：档案摘要 + 本轮一问一答（长输出掐头去尾）。userLabel 可配，默认中性。 */
export function buildJudgeInput(digest, userText, assistantText, userLabel = '用户') {
  const long = assistantText.length > 3000
  const assistant = long
    ? `${clip(assistantText, 600)}\n…（长输出中间省略）…\n${assistantText.slice(-600)}`
    : clip(assistantText, 1500)
  return `${digest}\n\n【本轮对话】\n${userLabel}说：\n${clip(userText, 800)}\n\n我说：\n${assistant}`
}

/** 解析模型返回的 JSON（容忍代码块围栏和前后废话）。 */
export function parseJudge(text) {
  let raw = String(text ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fence !== null) raw = fence[1]
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export function textOfMessage(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 取本轮"最后一条用户消息 + 之后的助手输出"。 */
export function currentExchange(session) {
  let messages
  try {
    messages = session.deriveMessages()
  } catch {
    return null
  }
  if (!Array.isArray(messages) || messages.length === 0) return null
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      start = i
      break
    }
  }
  if (start < 0) return null
  const userText = textOfMessage(messages[start])
  const assistantText = messages
    .slice(start + 1)
    .filter((message) => message?.role === 'assistant')
    .map(textOfMessage)
    .filter((text) => text !== '')
    .join('\n\n')
  if (userText === '' && assistantText === '') return null
  return { userText, assistantText }
}
