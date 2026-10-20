/**
 * 强度与遗忘曲线。
 *
 * strength 是写入时的强度；effectiveStrength 是"此刻实际生效的强度"——
 * 随最后一次被印证的时间衰减。locked 条目永不衰减。
 */
import { DAY } from './config.js'

export function clampStrength(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 3
  return Math.min(5, Math.max(1, Math.round(n)))
}

/**
 * 遗忘曲线：最后一次被印证之后，每过 decayDays 天掉一级，最低 1 级。
 * bond（关系状态）衰减更快 —— 关系是当下的，不是纪念碑。
 */
export function effectiveStrength(entry, config, now = Date.now()) {
  const base = clampStrength(entry.strength)
  // 身份锚点不随时间衰减：名字和形象不该因为"很久没提"就变淡。
  if (entry.locked === true) return base
  const stamp = Date.parse(entry.lastSeenAt ?? entry.createdAt ?? '')
  if (!Number.isFinite(stamp)) return base
  const days = Math.max(0, (now - stamp) / DAY)
  const span = entry.kind === 'bond'
    ? Math.max(1, config.decayDays / Math.max(1, config.bondDecayFactor))
    : Math.max(1, config.decayDays)
  const lost = Math.floor(days / span)
  return Math.max(1, base - lost)
}

/** 是否还活着（没被推翻/合并掉）。 */
export function isLive(entry) {
  return entry.supersededAt === undefined || entry.supersededAt === null
}

export function liveEntries(entries) {
  return entries.filter(isLive)
}
