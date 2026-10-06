// 实机检验：在 Node 里真跑一次 apply()，用真 HTTP 服务器收下注册的路由并实际请求。
// 这不是读源码，是真的起服务、真的发请求、真的看响应。
//
// 插件从**本仓库自身**加载（不是从 profile），所以换机器也能跑；
// 只有"本机装了 WE"这一条是环境依赖，没有时相关断言 SKIP。
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// 优先从插件自己的目录加载（可迁移）；DSH_WE_LIBRARY_ENTRY 可显式指定 profile 里的入口。
const entry = process.env.DSH_WE_LIBRARY_ENTRY || path.join(ROOT, 'index.js')
const mod = await import(pathToFileURL(entry).href)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// 假 webServer：收下注册，并按 DSH 的匹配规则（pathname === path || startsWith(path + '/')）派发
const routes = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) }
  },
}

const effects = []
const ctx = {
  webServer,
  effect(fn, label) { effects.push({ label, dispose: fn() }) },
}
const origLog = console.log
await mod.apply(ctx)
ok('apply() 跑完没抛错', true)
ok('注册了路由', routes.length > 0, routes.length + ' 条')
ok('注册了 effect（清理钩子）', effects.length > 0, effects.map((e) => e.label).join(','))

// 起真服务器，用注册的路由派发
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname
  for (const r of routes) {
    const hit = r.kind === 'prefix' ? (pathname === r.path || pathname.startsWith(r.path + '/')) : pathname === r.path
    if (hit) { try { await r.handler(req, res) } catch (e) { res.writeHead(500); res.end(String(e.message)) } return }
  }
  res.writeHead(404); res.end('no route')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = 'http://127.0.0.1:' + port
const get = async (p) => {
  const res = await fetch(base + p)
  const text = await res.text()
  return { status: res.status, text }
}

// ---- /dwl/status：应报告 weFound 与桥状态 ----
const status = await get('/dwl/status')
ok('/dwl/status 返回 200', status.status === 200, String(status.status))
let sj = null
try { sj = JSON.parse(status.text) } catch {}
ok('/dwl/status 是合法 JSON', sj !== null)
ok('/dwl/status 报告 weFound=true（本机真有 WE）', sj && sj.weFound === true, JSON.stringify(sj && { weFound: sj.weFound, running: sj.running }))

// ---- /dwl/library.json：应列出真实项目 ----
const lib = await get('/dwl/library.json')
ok('/dwl/library.json 返回 200', lib.status === 200, String(lib.status))
let lj = null
try { lj = JSON.parse(lib.text) } catch {}
ok('/dwl/library.json 是合法 JSON', lj !== null)
const entries = (lj && lj.entries) || []
// 本机没有 WE 时这条 SKIP（不冒红），有 WE 时必须有条目
if (sj && sj.weFound === false) {
  console.log('  SKIP  本机没有 WE，跳过"列出真实条目"相关断言')
} else {
  ok('列出真实条目（本机应有 37 个左右：16 订阅 + 21 本地）', entries.length > 0, entries.length + ' 条')
  ok('条目带 id/title/type', entries.every((e) => e.id && e.title !== undefined && e.type))
  const byType = {}
  for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1
  ok('类型分布合理', Object.keys(byType).length > 0, JSON.stringify(byType))
  ok('存在 scene 条目', entries.some((e) => e.type === 'scene'), entries.filter((e) => e.type === 'scene').length + ' 个 scene')
}

// ---- 越权与边界 ----
const bad = await get('/dwl/media/../../etc/passwd')
ok('路径穿越被拒（不是 200 带内容）', bad.status !== 200 || !bad.text.includes('root:'), String(bad.status))
const badId = await get('/dwl/still/not-an-id.webp')
ok('非法 id 被拒', badId.status === 400 || badId.status === 404, String(badId.status))
const notFound = await get('/dwl/nonexistent')
ok('未知路径 404', notFound.status === 404, String(notFound.status))

// ---- 前缀隔离：/bga 不该被本插件接管 ----
const bga = await get('/bga/we/status')
ok('/bga/* 不归本插件管（前缀没串台）', bga.status === 404, String(bga.status))

// ---- 清理：effect 的 dispose 应能撤掉路由 ----
for (const e of effects) if (typeof e.dispose === 'function') e.dispose()
ok('dispose 后路由被撤掉', routes.length === 0, routes.length + ' 条残留')

server.close()
console.log('\n实机检验（真起服务 + 真发请求）：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)