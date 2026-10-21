/**
 * 提示词注入：身份 + 人格与经历 + 技能，并顺手写调试日志。
 *
 * 从 index.js 拆出来——注入的组装逻辑跟插件生命周期是两件事，
 * 单独放这里方便读、也方便以后加别的注入源。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickExperiences } from './experiences.js'
import { renderIdentity, renderSection, renderSkills } from './render.js'

const LOG_KEEP = 10 // 保留最近多少轮

/**
 * 组装本轮要注入的文本。
 * @param {{ p: object, cfg: object, situation: string, load: () => { entries: object[] }, manifest: object }} args
 */
export function buildInjectedText({ p, cfg, situation, load, manifest }) {
  const { entries } = load()
  // 经历标题按当前情境挑（相关优先，没命中退回最近 N 条），token 不变
  const experiences = pickExperiences(p, situation, cfg.recentExperiences)
  const skillText = renderSkills(entries, cfg, Date.now(), situation)

  // 调试日志：追加式，保留最近 LOG_KEEP 轮——只看最后一轮会被覆盖，验证不了前几轮。
  try {
    const logFile = join(p.dir, 'last-inject.log')
    const line = `# ${new Date().toISOString()}\n# 情境：${situation || '（无）'}\n${skillText || '（本轮没有注入技能）'}\n`
    appendFileSync(logFile, line, 'utf8')
    // 超过上限就只留最近的几段
    const blocks = readFileSync(logFile, 'utf8').split(/^# /m).filter((b) => b.trim() !== '')
    if (blocks.length > LOG_KEEP) {
      writeFileSync(logFile, blocks.slice(-LOG_KEEP).map((b) => '# ' + b).join(''), 'utf8')
    }
  } catch {
    // 写不了不影响注入
  }

  return [
    renderIdentity(p.identity, cfg.userLabel),
    renderSection(entries, experiences, cfg, Date.now(), manifest),
    skillText,
  ]
    .filter((part) => part !== '')
    .join('\n\n')
}
