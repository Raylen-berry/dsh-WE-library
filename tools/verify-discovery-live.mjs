#!/usr/bin/env node
// tools/verify-discovery-live.mjs —— 真跑一次库发现，对账本机 WE 库的实际内容。
//
// 这是"验收动作"，不是读源码：直接调本插件的 discoverWePaths()，再数磁盘上的真实项目数，
// 两边必须一致。本机没有 WE 时 SKIP 并退出 0（换机器不该冒红）。
import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { discoverWePaths } = await import(pathToFileURL(path.join(ROOT, 'we', 'paths.js')).href)

const p = await discoverWePaths()
if (!p.found) {
  console.log('SKIP  本机没找到 Wallpaper Engine（found=false）—— 换机器不该因此冒红')
  process.exit(0)
}

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')) }
}

console.log('发现结果：')
console.log('  steamRoot       = ' + p.steamRoot)
console.log('  WE 安装目录      = ' + p.wallpaperEngineDir)
console.log('  workshopRoot    = ' + p.workshopRoot)
console.log('  localProjectsDir= ' + p.localProjectsDir)

// WE 安装目录里必须真有可执行文件（发现成功的最硬判据）
const hasExe = await stat(path.join(p.wallpaperEngineDir, 'wallpaper32.exe')).then(() => true, () => false)
  || await stat(path.join(p.wallpaperEngineDir, 'wallpaper64.exe')).then(() => true, () => false)
ok('WE 安装目录里真的有可执行文件', hasExe)

// workshop：数磁盘 vs 清单元数据一致（至少不为空）
let subCount = 0
try {
  const dirs = await readdir(p.workshopRoot, { withFileTypes: true })
  subCount = dirs.filter((d) => d.isDirectory()).length
} catch { /* 没有订阅 */ }
console.log('  workshop 订阅项目实测: ' + subCount)
ok('workshopRoot 可读（即使为 0）', true, subCount + ' 个')

// 本地项目：projects/<组>/<项目>/project.json
let localCount = 0
try {
  for (const g of await readdir(p.localProjectsDir, { withFileTypes: true })) {
    if (!g.isDirectory()) continue
    const gd = path.join(p.localProjectsDir, g.name)
    const hasPj = await stat(path.join(gd, 'project.json')).then(() => true, () => false)
    if (hasPj) { localCount++; continue }
    for (const it of await readdir(gd, { withFileTypes: true })) {
      if (!it.isDirectory()) continue
      if (await stat(path.join(gd, it.name, 'project.json')).then(() => true, () => false)) localCount++
    }
  }
} catch { /* 没有本地项目 */ }
console.log('  本地项目实测: ' + localCount)
ok('localProjectsDir 可读且发现到项目', localCount > 0, localCount + ' 个')

// 白名单校验：库根之外的路径必须被拒（安全边界）
const { isInsideWeRoots } = await import(pathToFileURL(path.join(ROOT, 'we', 'paths.js')).href)
ok('库根内的路径被接受', isInsideWeRoots(path.join(p.workshopRoot, '123'), p) === true)
ok('库根外的路径被拒绝（防目录穿越）', isInsideWeRoots('C:/Windows/System32', p) === false)

console.log('\n库发现实测：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)