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
import { existsSync, readFileSync } from 'node:fs'
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
  const routes = [
    { path: `${PREFIX}state`, method: 'GET', run: () => api.state() },
    { path: `${PREFIX}switch`, method: 'POST', run: (body) => api.switch(body?.name) },
    { path: `${PREFIX}disable`, method: 'POST', run: () => api.disable() },
    { path: `${PREFIX}enable`, method: 'POST', run: () => api.enable() },
  ]

  const disposers = routes.map((route) =>
    webserver.register({
      kind: 'exact',
      path: route.path,
      handler: async (req, res) => {
        try {
          if (req.method !== route.method) {
            sendJson(res, 405, { error: `只支持 ${route.method}` })
            return
          }
          const body = route.method === 'POST' ? await readBody(req) : {}
          const data = await route.run(body)
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
export function shapeState(p, listProfiles) {
  const raw = listProfiles(p)
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(p.manifest, 'utf8'))
  } catch {
    manifest = {}
  }
  const disabled = manifest.disabled === true
  return {
    current: raw.current,
    currentEntries: raw.currentEntries,
    others: raw.others,
    disabled,
    disabledFrom: disabled ? String(manifest.disabledFrom || '') : '',
    disabledFromExists: disabled ? existsSync(String(manifest.disabledFrom || '')) : false,
    identityExists: existsSync(p.identity),
    dir: p.dir,
  }
}
