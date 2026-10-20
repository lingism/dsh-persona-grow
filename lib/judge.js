/**
 * 判断层：把一轮对话 + 现有档案交给模型，判断该记人格、记经历、还是丢掉。
 *
 * 这里只有"准备输入 / 解析输出"的纯函数；真正调用模型的部分在 index.js 的 apply 里。
 */
import { KINDS, KIND_LABEL } from './config.js'
import { effectiveStrength, liveEntries } from './strength.js'

export const JUDGE_PROMPT = `你是一个人格档案的归档员。先读【现有档案】，再读【本轮对话】，判断这一轮该做什么。

三种结果，互斥，只挑最合适的一种：

1. **人格增量** —— 出现了关于"这个 agent 是谁"的新事实：新的性格侧面、确定下来的偏好、新的说话习惯、一条决定守住的底线，或者"你们之间"的关系状态。写进 persona 数组。
2. **难忘的经历** —— 没有人格增量，但这是一次值得记住的事：第一次做某件事、一个重要的决定、一段有分量的谈话。写进 experience。
3. **都不是** —— 寒暄、事务性问答、纯技术操作、调试代码、重复已知的事。两个字段都留空。

写 persona 条目时，每条可以带两个可选字段来修正旧认知：

- "merge": ["pg-0007"] —— 这条只是旧条目的更好说法时，用它把旧的合并掉。
- "supersede": ["pg-0003"] —— 这条**推翻了**旧条目时用（比如旧条目说"我不吃辣"，这轮确认了其实吃）。

只在确有把握时使用这两个字段；不要为了"清理"而乱指定 id。

条目要求：一句自足的话，用第一人称"我"，不超过 60 字，不要解释，不要写"用户说"。
strength 1-5：5 只留给定义我是谁的核心，日常细节给 2-3。

注意：**纯工具操作、代码、文件处理不算经历**，除非里面真的发生了关于我或者我们关系的事。

只输出 JSON，不要解释，不要代码块围栏：
{"persona":[{"kind":"trait|preference|speech|memory|boundary|bond","text":"...","strength":3,"merge":[],"supersede":[]}],"experience":{"title":"10字以内","text":"60字以内","tags":["..."]},"reason":"一句话"}

没有内容时：{"persona":[],"experience":null,"reason":"..."}`

export const CONSOLIDATE_PROMPT = `你是一个人格档案的整理员。下面是一批人格条目，请找出其中语义重复或可以合并的组。

规则：
- 只合并真正重复或高度重叠的（说的是同一件事的不同措辞）。
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
  return lines.join('\n')
}

/** 判断输入：档案摘要 + 本轮一问一答（长输出掐头去尾）。 */
export function buildJudgeInput(digest, userText, assistantText) {
  const long = assistantText.length > 3000
  const assistant = long
    ? `${clip(assistantText, 600)}\n…（长输出中间省略）…\n${assistantText.slice(-600)}`
    : clip(assistantText, 1500)
  return `${digest}\n\n【本轮对话】\n用户说：\n${clip(userText, 800)}\n\n我说：\n${assistant}`
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
