/**
 * 配置与常量。
 *
 * Config 是 schema，其余是插件内部共享的枚举/时间常量。
 * 拆分自原来的单文件 index.js，行为不变。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  dir: z.string().default(''),
  auto: z.boolean().default(true),
  provider: z.string().default('deepseek-account'),
  model: z.string().default('deepseek-flash'),
  minChars: z.number().default(60),
  maxPerHour: z.number().default(30),
  maxChars: z.number().default(1800),
  minStrength: z.number().default(1),
  sectionOrder: z.number().default(10300),
  recentExperiences: z.number().default(3),
  decayDays: z.number().default(30),
  bondDecayFactor: z.number().default(2),
  consolidateEvery: z.number().default(20),
  consolidateMin: z.number().default(30),
  digestMaxPerKind: z.number().default(12),
  autoStrengthCap: z.number().default(4),
  careEveryDays: z.number().default(7),
})

/** 六个类别，顺序即注入时的展示顺序。 */
export const KINDS = ['trait', 'preference', 'speech', 'memory', 'boundary', 'bond']

/** 类别 → 中文标题。 */
export const KIND_LABEL = {
  trait: '性格',
  preference: '偏好',
  speech: '说话方式',
  memory: '共同记忆',
  boundary: '底线',
  bond: '我们之间',
}

export const SCHEMA_VERSION = 3
export const DAY = 86_400_000
