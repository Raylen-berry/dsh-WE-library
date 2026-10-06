// ============================================================================
// dsh-WE-library · Host half —— Wallpaper Engine 库桥（从 dsh-bg-atelier-plus 移植）
//
// 职责边界（与底图插件分立，两边靠 HTTP 接口解耦）：
//   1. 发现本机 WE 安装与库（注册表 → libraryfolders.vdf → 兜底清单）。
//   2. 通过 webServer 前缀路由提供库清单、媒体流、静态合成图与官方 CLI 启动。
//   3. 提供"实时场景"的启动/停止控制面，由原生桥把 WE 专用窗口的画面接入 DSH。
//
// 与底图插件的关系：
//   · 底图插件（dsh-bg-atelier-plus）负责"把画面当背景贴上去"；
//   · 本插件负责"WE 库里有什么、场景怎么渲染、画面从哪来"。
//   · 路由前缀**必须是本插件自己的**（/dwl），否则两个插件会抢同一段路由。
//
// 路径发现刻意不写死盘符：注册表 SteamPath 是首选，vdf 提供多库，
// 硬编码清单只在两级都失败时兜底（换机器/换盘符仍可用）。
// ============================================================================

import path from 'node:path'
import fsSync from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerWeRoutes } from './we/routes.js'

export const name = 'dsh-we-library'
export const inject = ['webServer']

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))

/** 本插件的路由前缀。与底图插件的 /bga 完全分开，互不覆盖。 */
const ROUTE_PREFIX = '/dwl'

export function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
}

/** 派生图（场景静态合成 webp）与场景属性的落点。 */
export function settingsDir() {
  return process.env.DSH_WE_LIBRARY_DIR || path.join(dshHome(), 'dsh-we-library')
}

/**
 * sharp 候选路径。移植自底图插件（那份已经踩过 asar / junction / 裸 import 的坑：
 * asar 内部路径**不能先探存在性** —— 普通 Node 的 fs 看不见它，而 Electron 里能 import）。
 * 环境变量改成 DSH_WE_LIBRARY_SHARP，与底图插件的 DSH_BG_ATELIER_SHARP 互不干扰。
 */
function sharpCandidates() {
  const candidates = []
  // ⓪ 显式指定：判据用 "://" 而不是 /^[a-zA-Z]+:/，否则盘符 "D:\..." 会被当协议
  if (process.env.DSH_WE_LIBRARY_SHARP) {
    const p = process.env.DSH_WE_LIBRARY_SHARP
    candidates.push(p.indexOf('://') > 0 ? p : pathToFileURL(path.resolve(p)).href)
  }
  // ① 裸 import：插件装在真有 node_modules 的树里时有效
  candidates.push('sharp')
  // ①b profile 树共享的 node_modules 绝对路径（link/junction 场景裸 import 兜不到）
  const home = dshHome()
  for (const rel of [['profiles', 'node_modules'], ['node_modules']]) {
    const p = path.join(home, ...rel, 'sharp', 'dist', 'index.cjs')
    try { if (fsSync.existsSync(p)) candidates.push(pathToFileURL(p).href) } catch { /* ignore */ }
  }
  // ②③ 宿主自带的 sharp：桌面版打在 asar 里，路径从 process.execPath 现推，不写死盘符
  const probes = []
  try {
    const exeDir = path.dirname(process.execPath)
    const resources = path.join(exeDir, 'resources')
    for (const rel of [
      ['app.asar.unpacked', 'node_modules', 'sharp', 'dist', 'index.cjs'],
      ['app.asar', 'node_modules', 'sharp', 'dist', 'index.cjs'],
      ['app', 'node_modules', 'sharp', 'dist', 'index.cjs'],
    ]) probes.push(path.join(resources, ...rel))
    probes.push(path.join(exeDir, '..', '..', 'sharp', 'dist', 'index.cjs'))
  } catch { /* ignore */ }
  for (const p of probes) {
    const spec = /[\\/]app\.asar[\\/]/.test(p) ? pathToFileURL(p).href : (fsSync.existsSync(p) ? pathToFileURL(p).href : null)
    if (spec && candidates.indexOf(spec) < 0) candidates.push(spec)
  }
  return candidates
}

export async function apply(ctx) {
  const webServer = ctx.webServer
  const dir = settingsDir()
  const stillsDir = path.join(dir, 'we-stills')
  try { fsSync.mkdirSync(stillsDir, { recursive: true }) } catch { /* 只读盘就让合成时报错 */ }

  // 官方 WE CLI 启动器：不用 shell，应用自己持有生命周期。
  const spawnLauncher = (exe, args) => new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('spawn', () => { child.unref(); resolve() })
  })

  ctx.effect(() => registerWeRoutes(webServer, {
    prefix: ROUTE_PREFIX,
    spawnLauncher,
    stillsDir,
    sharpCandidates: sharpCandidates(),
  }), 'dsh-we-library: we routes')

  let ver = '?'
  try { ver = JSON.parse(await fsSync.promises.readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version } catch { /* 读不到就显示 ? */ }
  console.log('[dsh-we-library] host up (v' + ver + '), routes at ' + ROUTE_PREFIX + '/*, stills at ' + stillsDir)
}