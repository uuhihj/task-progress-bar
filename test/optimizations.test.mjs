// 2026-10-25 优化项回归：英文命名 / 坏 JSON 兜底 / 文件删除立即消失 / 淘汰策略
import fs from 'node:fs'
import path from 'node:path'

const HOME = path.join('D:/workwork/ai/deepseek-harness/tmp', 'opt-home-' + process.pid)
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME
const PROG = path.join(HOME, 'dsh-progress.json')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const listeners = {}
const routes = []
mod.apply({
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  on: (n, cb) => { listeners[n] = cb; return () => {} },
  effect: () => () => {},
}, { maxTasks: 3, protocolHint: false })

let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('OK   ' + n) } else { fail++; console.log('FAIL ' + n + ' | ' + JSON.stringify(d)) } }
async function status() {
  const r = routes.find((x) => x.path === '/dsh-progress/status')
  let body = ''
  await r.handler({}, { writeHead: () => {}, end: (b) => { body = String(b) } })
  return JSON.parse(body)
}
const sessions = {}
function sess(id) { sessions[id] = { id, header: { cwd: 'D:/workwork/ai/test' } }; return sessions[id] }
const ev = (id, type, data) => listeners['session/event'](sess(id), { type, data: data || {} })
const userMsg = (id, text) => ev(id, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

// 1) 英文任务名走英文规则
userMsg('s1', 'fix the broken login flow')
ev('s1', 'turn/start', { turn: 1 })
let s = await status()
check('英文任务名映射为问题修复', s.task && s.task.task === '问题修复', s.task && s.task.task)
check('status 下发 pollMs/doneHoldMs', s.config && s.config.pollMs === 1000 && s.config.doneHoldMs === 30000, s.config)
ev('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

// 2) 英文长标题按单词边界截断
userMsg('s2', 'please implement a completely new dashboard layout for the admin panel')
ev('s2', 'turn/start', { turn: 1 })
s = await status()
const t2 = s.tasks.find((x) => x.id === 's2')
check('英文标题截断不出现半个词', t2 && !/[a-z]\u2026$/.test(t2.task), t2 && t2.task)
ev('s2', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

// 3) 坏 JSON：沿用上一次有效值（2 秒内）
fs.writeFileSync(PROG, JSON.stringify({ task: '上报任务', stages: ['a', 'b'], current: 0, pct: 10, status: 'running', etaMin: 5, startedAt: Date.now(), updatedAt: Date.now() }))
s = await status()
check('有效文件被读到', s.tasks.some((t) => t.id === 'file'), s.tasks.map((t) => t.id))
fs.writeFileSync(PROG, '{"task":"half')
s = await status()
check('坏 JSON 2 秒内沿用上次有效值', s.tasks.some((t) => t.id === 'file'), s.tasks.map((t) => t.id))

// 4) 文件被删 → 立即消失（不走兜底）
await new Promise((r) => setTimeout(r, 2100))
fs.writeFileSync(PROG, JSON.stringify({ task: '短暂任务', stages: ['a'], current: 0, pct: 5, status: 'running', etaMin: 5, startedAt: Date.now(), updatedAt: Date.now() }))
s = await status()
check('删除前可见', s.tasks.some((t) => t.id === 'file'), s.tasks.map((t) => t.id))
fs.unlinkSync(PROG)
s = await status()
check('删除文件后立即消失', !s.tasks.some((t) => t.id === 'file'), s.tasks.map((t) => t.id))

// 5) 淘汰：超过 maxTasks(3) 时淘汰最久没活动的，而不是最早插入的
const mk = (id, n) => { userMsg(id, 'do task ' + n); ev(id, 'turn/start', { turn: 1 }) }
mk('a', 1)
await new Promise((r) => setTimeout(r, 30))
mk('b', 2)
await new Promise((r) => setTimeout(r, 30))
mk('c', 3)
await new Promise((r) => setTimeout(r, 30))
// a 最早插入，但再给 a 一次活动 → a 的 lastActivityAt 最新；b 变成最久没活动
ev('a', 'step/start', { turn: 1, step: 2 })
await new Promise((r) => setTimeout(r, 30))
mk('d', 4)
s = await status()
const ids = s.tasks.map((t) => t.id)
check('超出 maxTasks 后 b 被淘汰、a 仍在', !ids.includes('b') && ids.includes('a'), ids)
check('新会话 d 在列表里', ids.includes('d'), ids)

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch (e) {}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)