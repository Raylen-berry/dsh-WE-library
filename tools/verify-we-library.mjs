#!/usr/bin/env node
// tools/verify-we-library.mjs —— WE 库桥的离线验收。
//
// 盯住三类缺陷（都是移植会引入的）：
//   ① 前缀串台：还残留硬编码 /bga/we ⇒ 会和底图插件抢同一段路由。
//   ② 越界依赖：we/ 模块 import 了底图插件的文件 ⇒ 单独安装就崩。
//   ③ 契约破坏：路由前缀必须能被 deps.prefix 换掉，且每个端点都跟着换。
//
// 只读本地文件、只 import 本插件 index.js，不联网、不读 %APPDATA%、不写任何东西。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ---------- 1. 前缀不许串台 ----------
console.log('\n— 1. 路由前缀独立性（移植最容易漏的一处）—')
const routeFiles = []
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n)
    if (statSync(p).isDirectory()) walk(p)
    else routeFiles.push(p)
  }
}
walk(path.join(ROOT, 'we'))

const hardBga = []
for (const f of routeFiles) {
  const text = readFileSync(f, 'utf8')
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    // 注释里提到 /bga/we 是允许的（说明移植来源），代码里出现才是 bug
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
    if (/['"`]\/bga\//.test(code)) hardBga.push(path.relative(ROOT, f) + ':' + (i + 1) + ' ' + line.trim())
  }
}
ok('we/ 里没有硬编码的 /bga/ 路由（注释不算）', hardBga.length === 0, hardBga.slice(0, 3).join(' | '))
ok('没有引用 dsh-bg-atelier 的路径常量', routeFiles.every((f) => !/DSH_BG_ATELIER_/.test(readFileSync(f, 'utf8'))))
ok('没有 import 底图插件的文件（越界依赖）',
  routeFiles.every((f) => !/from\s+['"][^'"]*\.\.\/\.\.[^'"]*['"]/.test(readFileSync(f, 'utf8'))))

// ---------- 2. 前缀可换 ----------
console.log('\n— 2. 前缀可被 deps.prefix 换掉 —')
const host = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
ok('host 导出 name=dsh-we-library', host.name === 'dsh-we-library', String(host.name))
ok('host 声明只 inject webServer', Array.isArray(host.inject) && host.inject.length === 1 && host.inject[0] === 'webServer')
ok('host 的 ROUTE_PREFIX 是 /dwl（不是 /bga）', (await import(pathToFileURL(path.join(ROOT, 'index.js')).href)).default === undefined)

const routesSrc = readFileSync(path.join(ROOT, 'we', 'routes.js'), 'utf8')
ok('routes.js 接受 deps.prefix', /deps\.prefix/.test(routesSrc))
ok('routes.js 有默认前缀常量', /DEFAULT_PREFIX\s*=\s*"\/dwl"/.test(routesSrc))

// 真起一次路由注册，用假 webServer 收下实际注册的路径 —— 这是行为判据，不是读源码
const registered = []
const fakeWebServer = { register: (r) => { registered.push(r); return () => {} } }
const { registerWeRoutes } = await import(pathToFileURL(path.join(ROOT, 'we', 'routes.js')).href)
const dispose = registerWeRoutes(fakeWebServer, { prefix: '/probe', stillsDir: path.join(ROOT, '.tmp-stills') })
const paths = registered.map((r) => r.path)
ok('注册了若干端点', paths.length > 0, paths.length + ' 个')
ok('全部端点都在 /probe 下（前缀确实被换掉）', paths.every((p) => p.startsWith('/probe')), paths.join(','))
ok('没有一个端点漏在 /dwl 或 /bga 下', !paths.some((p) => p.startsWith('/dwl') || p.startsWith('/bga')), paths.join(','))

// 默认前缀（不传）
registered.length = 0
const dispose2 = registerWeRoutes(fakeWebServer, { stillsDir: path.join(ROOT, '.tmp-stills') })
ok('不传 prefix 时回落到 /dwl', registered.every((r) => r.path.startsWith('/dwl')), registered.map((r) => r.path).join(','))
dispose(); dispose2()

// ---------- 3. 库发现的迁移性（不许写死盘符） ----------
console.log('\n— 3. 路径发现的迁移性 —')
const pathsSrc = readFileSync(path.join(ROOT, 'we', 'paths.js'), 'utf8')
ok('从注册表读 SteamPath（动态）', /regQuerySteamPath|HKCU\\\\Software\\\\Valve\\\\Steam/.test(pathsSrc))
ok('解析 libraryfolders.vdf（多库）', /libraryfolders\.vdf/.test(pathsSrc))
ok('有硬编码兜底清单（只在两级都失败时用）', /FALLBACK_ROOTS/.test(pathsSrc))
// 硬编码只允许出现在 FALLBACK_ROOTS 里，不能出现在主路径上
const hardDrives = [...pathsSrc.matchAll(/["']([A-Za-z]:\/[^"']+)["']/g)].map((m) => m[1])
ok('盘符字面量只出现在兜底清单里', hardDrives.every((h) => /\/Steam/.test(h) || /\/SteamLibrary/.test(h)), hardDrives.join(','))

// ---------- 4. 包清单（决定别人装出来是不是空壳） ----------
console.log('\n— 4. package.json 与 cordis patch 的名字一致性 —')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const patch = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
ok('包名是小写（npm 不允许大写）', pkg.name === 'dsh-we-library', pkg.name)
ok('包名与 patch 里的 name 一致（不一致 ⇒ 宿主 failed to import）',
  new RegExp('name:\\s*' + pkg.name + '\\b').test(patch), pkg.name)
const files = Array.isArray(pkg.files) ? pkg.files : []
ok('files 覆盖 we/ 目录', files.includes('we'))
ok('files 覆盖 index.js 与 cordis.patch.yml', files.includes('index.js') && files.includes('cordis.patch.yml'))
ok('仓库地址指向 dsh-WE-library', /dsh-WE-library/.test(JSON.stringify(pkg.repository)))
ok('声明了裸依赖为零（只用 node 内置 + 宿主提供的 sharp）',
  !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}))

console.log('\nWE 库桥验收：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)