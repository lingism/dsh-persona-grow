/**
 * Web 设置页用的 HTTP API。
 *
 * 浏览器侧的「人格」设置区通过 fetch 调这几个端点：
 *   GET  /persona-grow/state    当前档案 + 其他档案 + 禁用状态
 *   POST /persona-grow/switch   { name }
 *   POST /persona-grow/disable
 *   POST /persona-grow/enable
 *
 * 路由注册走 dsh-host-webserver 的 ctx.webserver.register（kind: exact）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PREFIX = '/persona-grow/'

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('JSON 解析失败'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 注册人格 API（在 host 的 webserver 服务上）。
 * @param webserver dsh-host-webserver 服务实例
 * @param api { state, switch, disable, enable }
 * @returns 卸载函数
 */
export function registerPersonaHttpRoutes(webserver, api) {
  // 同一路径只能注册一次——GET/POST 分开注册会被后者覆盖，导致 405。
  // 所以 config 这条用一个 handler 自己分流。
  const routes = [
    { path: `${PREFIX}state`, method: 'GET', run: () => api.state() },
    { path: `${PREFIX}switch`, method: 'POST', run: (body) => api.switch(body?.name) },
    { path: `${PREFIX}disable`, method: 'POST', run: () => api.disable() },
    { path: `${PREFIX}enable`, method: 'POST', run: () => api.enable() },
    { path: `${PREFIX}create`, method: 'POST', run: (body) => api.create(body?.name) },
    {
      path: `${PREFIX}config`,
      method: null, // 两种方法都支持，handler 里分流
      run: (body, method) => (method === 'POST' ? api.setConfig(body) : api.getConfig()),
    },
  ]

  const disposers = routes.map((route) =>
    webserver.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        try {
          if (route.method !== null && req.method !== route.method) {
            sendJson(res, 405, { error: `只支持 ${route.method}` })
            return
          }
          const body = req.method === 'POST' ? await readBody(req) : {}
          const data = await route.run(body, req.method)
          sendJson(res, 200, data)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * 把档案状态整理成浏览器好用的形状。
 * @param p paths
 * @param listProfiles listProfiles(p)
 */
export function shapeState(p, listProfiles, auto) {
  const raw = listProfiles(p)
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(p.manifest, 'utf8'))
  } catch {
    manifest = {}
  }
  const disabled = manifest.disabled === true
  // 灵魂的名字：取身份文件第一行 `# 名字`
  let name = ''
  try {
    const body = readFileSync(p.identity, 'utf8')
    const match = /^#\s*(.+)$/m.exec(body)
    if (match) name = match[1].trim()
  } catch {
    name = ''
  }
  // 分层统计：人格层在 traits.jsonl、技能层在 skills/<kind>.jsonl，分开数
  let personaCount = 0
  let skillCount = 0
  const countFile = (file, markSkill) => {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const entry = JSON.parse(line)
          if (entry.supersededAt != null || entry.supersededBy != null) continue
          if (markSkill) skillCount += 1
          else personaCount += 1
        } catch {
          // 坏行跳过
        }
      }
    } catch {
      // 文件不存在
    }
  }
  countFile(p.traits, false)
  if (existsSync(p.skillsDir)) {
    for (const file of readdirSync(p.skillsDir)) {
      if (file.endsWith('.jsonl')) countFile(join(p.skillsDir, file), true)
    }
  }
  return {
    current: raw.current,
    // 禁用时身份文件是空的：不拿 profileName 顶上，让 UI 显示「已禁用」
    name: disabled ? '' : (name || raw.current),
    personaCount,
    skillCount,
    others: raw.others,
    disabled,
    disabledFrom: disabled ? String(manifest.disabledFrom || '') : '',
    disabledFromExists: disabled ? existsSync(String(manifest.disabledFrom || '')) : false,
    identityExists: existsSync(p.identity),
    // 生长开关：自动写灵魂是否开着
    auto: auto !== false,
    dir: p.dir,
  }
}
