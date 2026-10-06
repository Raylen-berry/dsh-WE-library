#!/usr/bin/env node
// tools/run-all.mjs —— 发布前检查总入口（本地与 CI 跑同一条命令：npm test）。
//
// 每套都跑完再汇总：任一套非 0 退出 ⇒ 本进程退出码 1。
// 清单只含**离线套件**：不联网、不起真浏览器、不读本机 DSH 安装目录、不碰真实配置。
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIST_ONLY = process.argv.includes('--list')

// 语法门禁：这几个文件必须先能过 node --check
const CHECKS = ['index.js', 'we/routes.js', 'we/paths.js', 'we/scanner.js', 'we/jobs.js', 'we/still.js']

const SUITES = [
  'tools/verify-we-library.mjs',
  // 真跑一次库发现并与磁盘对账；本机没有 WE 时自己 SKIP 并退出 0，不污染 CI。
  'tools/verify-discovery-live.mjs',
]

const EXCLUDED = [
  ['tools/install-native-bridge.mjs', '要把桥写进 DSH 安装目录，属安装动作不是断言式套件；手工跑，见 we/native/README.md'],
]

const DISCOVERY = (n) => /^(verify|test|probe)-.*\.mjs$/.test(n)
const KNOWN_FAILING = []

function checkRegistry() {
  const reg = new Set([...SUITES, ...EXCLUDED.map((e) => e[0]), ...KNOWN_FAILING.map((e) => e[0])].map((f) => path.basename(String(f).split(' ')[0])))
  const entries = readdirSync(path.join(REPO, 'tools'))
  const missing = entries.filter(DISCOVERY).filter((n) => !reg.has(n))
  if (missing.length) {
    console.error('✗ 有套件没登记到 tools/run-all.mjs（SUITES / EXCLUDED / KNOWN_FAILING 三选一）：' + missing.join(', '))
    process.exit(1)
  }
}

checkRegistry()

if (LIST_ONLY) {
  console.log('语法门禁：' + CHECKS.join(', '))
  console.log('测试套件：')
  for (const f of SUITES) console.log('  · ' + f)
  console.log('未纳入 CI：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + ' —— ' + why)
  process.exit(0)
}

const results = []
const t = (ms) => (ms / 1000).toFixed(1) + 's'

function summarize(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const cand = [...lines].reverse().find((l) => /通过|失败|passed|failed|SKIP/.test(l))
  return cand ? cand.trim() : (lines.filter((l) => /^\s*(PASS|✓|✔|OK)\b/.test(l)).length + ' 项（按 PASS 行计数）')
}

function run(kind, file) {
  const args = kind === 'check' ? ['--check', file] : [file]
  const started = Date.now()
  const s = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = (s.stdout || '') + (s.stderr || '')
  const code = s.status === null ? 1 : s.status
  const ok = code === 0
  results.push({ kind, file, ok, code, ms: Date.now() - started, summary: summarize(out) })
  console.log('\n' + '─'.repeat(72))
  console.log((ok ? '✅ ' : '❌ ') + file + '   exit=' + code + '  ' + t(Date.now() - started))
  console.log('─'.repeat(72))
  if (out.trim()) console.log(out.replace(/\s+$/, ''))
  if (s.error) console.log('!! spawn 失败：' + s.error.message)
  return ok
}

console.log('===== 语法门禁 =====')
for (const f of CHECKS) run('check', f)
console.log('\n===== 测试套件 =====')
for (const f of SUITES) run('suite', f)

const checks = results.filter((r) => r.kind === 'check')
const suites = results.filter((r) => r.kind === 'suite')
const passChecks = checks.filter((r) => r.ok).length
const passSuites = suites.filter((r) => r.ok).length

console.log('\n' + '='.repeat(72))
console.log('语法门禁 ' + passChecks + '/' + checks.length + '　套件 ' + passSuites + '/' + suites.length + ' 通过')
if (EXCLUDED.length) {
  console.log('\n未纳入 CI（原因）：')
  for (const [f, why] of EXCLUDED) console.log('  · ' + f + '\n      ' + why)
}
const allOk = passChecks === checks.length && passSuites === suites.length
console.log(allOk ? '\n✓ 全部通过' : '\n✗ 有失败 —— 整体失败')
process.exit(allOk ? 0 : 1)