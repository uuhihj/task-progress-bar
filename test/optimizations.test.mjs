// 2026-10-25 优化项回归：英文命名 / 坏 JSON 兜底 / 文件删除立即消失 / 淘汰策略
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-progress-opt-' + process.pid)
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
function sess(id) { sessions[id] = { id, header: { cwd: 'D:/demo/test' } }; return sessions[id] }
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
check('有效文件被读到', s.tasks.some((t) => String(t.id).indexOf('file:') === 0), s.tasks.map((t) => t.id))
fs.writeFileSync(PROG, '{"task":"half')
s = await status()
check('坏 JSON 2 秒内沿用上次有效值', s.tasks.some((t) => String(t.id).indexOf('file:') === 0), s.tasks.map((t) => t.id))

// 4) 文件被删 → 立即消失（不走兜底）
await new Promise((r) => setTimeout(r, 2100))
fs.writeFileSync(PROG, JSON.stringify({ task: '短暂任务', stages: ['a'], current: 0, pct: 5, status: 'running', etaMin: 5, startedAt: Date.now(), updatedAt: Date.now() }))
s = await status()
check('删除前可见', s.tasks.some((t) => String(t.id).indexOf('file:') === 0), s.tasks.map((t) => t.id))
fs.unlinkSync(PROG)
s = await status()
check('删除文件后立即消失', !s.tasks.some((t) => String(t.id).indexOf('file:') === 0), s.tasks.map((t) => t.id))

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


// 6) 待办清单驱动：todo/write 后带 todoDone/todoTotal，ETA 来源切到 todo
ev('a', 'todo/write', { todos: [
  { content: 'x', status: 'completed' }, { content: 'y', status: 'completed' },
  { content: 'z', status: 'in_progress' }, { content: 'w', status: 'pending' },
  { content: 'v', status: 'pending' },
] })
s = await status()
const ta = s.tasks.find((t) => t.id === 'a')
check('todo 总数/完成数进入 tasks', ta && ta.todoTotal === 5 && ta.todoDone === 2, ta && { d: ta.todoDone, t: ta.todoTotal })
check('ETA 来源切到 todo', ta && ta.etaBasis === 'todo', ta && ta.etaBasis)
check('自带 p75 参考值', ta && typeof ta.etaP75Min === 'number', ta && ta.etaP75Min)


// 7) 上报超时不再丢弃：保留真实阶段与任务名，只标注「真实进度已中断 N 分钟」
// （旧行为是整段丢掉、退回按关键词猜的阶段模板，用户会把猜测当成真实进度）
for (const sid of ['a', 'b', 'c', 'd']) ev(sid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
fs.writeFileSync(PROG, JSON.stringify({ task: '长渲染任务', stages: ['排队', '渲染', '校验'], current: 1, pct: 40, status: 'running', etaMin: 2, session: 'no-such-session', startedAt: Date.now() - 600000, updatedAt: Date.now() - 300000 }))
s = await status()
const st = s.tasks.find((x) => String(x.id).indexOf('file:') === 0)
check('超时上报仍显示真实任务名', st && st.task === '长渲染任务', st && st.task)
check('标注真实进度已中断分钟数', st && st.staleReport === true && st.staleMin >= 4, st && { r: st.staleReport, m: st.staleMin })
check('保留真实阶段而非猜测模板', st && Array.isArray(st.stages) && st.stages.length === 3 && st.stages[1] === '渲染', st && st.stages)

// 8) blocked：卡住/等确认时要显示得出来，并带 issue，且不再假装倒计时
fs.writeFileSync(PROG, JSON.stringify({ task: '卡住的任务', stages: ['准备', '执行'], current: 0, pct: 10, status: 'blocked', issue: '等用户确认输出目录', etaMin: 5, startedAt: Date.now() - 60000, updatedAt: Date.now() }))
s = await status()
const bt = s.tasks.find((x) => String(x.id).indexOf('file:') === 0)
check('blocked 任务会显示', bt && bt.task === '卡住的任务', bt && bt.task)
check('blocked 透出 status 与 issue', bt && bt.status === 'blocked' && bt.issue === '等用户确认输出目录', bt && { s: bt.status, i: bt.issue })
check('blocked 不再倒计时', bt && (bt.etaAnchorMin === undefined || bt.etaAnchorMin === 0), bt && bt.etaAnchorMin)

// 9) 缺 startedAt 的上报不该显示成 1970 年
fs.writeFileSync(PROG, JSON.stringify({ task: '没写开始时间的任务', stages: ['a'], current: 0, pct: 5, status: 'running', etaMin: 3, updatedAt: Date.now() }))
s = await status()
const nt = s.tasks.find((x) => String(x.id).indexOf('file:') === 0)
check('缺 startedAt 时用当前时间兜底', nt && Number(nt.startedAt) > 1600000000000, nt && nt.startedAt)


// 10) A 方案核心：每会话一个文件，多会话各自上报互不覆盖
const PDIR = path.join(HOME, "dsh-progress")
fs.rmSync(PDIR, { recursive: true, force: true })
fs.mkdirSync(PDIR, { recursive: true })
fs.writeFileSync(PROG, JSON.stringify({ task: "旧单文件任务", stages: ["a"], current: 0, pct: 5, status: "done", updatedAt: Date.now() }))
fs.writeFileSync(path.join(PDIR, "session-aaa.json"), JSON.stringify({ task: "会话A的任务", session: "session-aaa", stages: ["s1", "s2"], current: 1, pct: 60, status: "running", etaMin: 4, startedAt: Date.now() - 60000, updatedAt: Date.now() }))
fs.writeFileSync(path.join(PDIR, "session-bbb.json"), JSON.stringify({ task: "会话B的任务", session: "session-bbb", stages: ["s1"], current: 0, pct: 20, status: "running", etaMin: 6, startedAt: Date.now() - 30000, updatedAt: Date.now() }))
s = await status()
const fileIds = s.tasks.filter((x) => String(x.id).indexOf("file:") === 0).map((x) => x.id)
check("两个会话的上报同时存在", fileIds.indexOf("file:session-aaa") >= 0 && fileIds.indexOf("file:session-bbb") >= 0, fileIds)
const ta2 = s.tasks.find((x) => x.id === "file:session-aaa")
check("各自保留自己的真实阶段", ta2 && ta2.task === "会话A的任务" && ta2.stages[1] === "s2" && ta2.pct === 60, ta2 && { t: ta2.task, p: ta2.pct })

// 11) 一个文件坏掉不影响另一个（旧版单文件一坏就全没了）
fs.writeFileSync(path.join(PDIR, "session-bbb.json"), "{ broken")
await new Promise((r) => setTimeout(r, 2200))
fs.writeFileSync(path.join(PDIR, "session-bbb.json"), "{ still broken")
s = await status()
check("坏掉的文件不拖累其它会话", s.tasks.some((x) => x.id === "file:session-aaa"), s.tasks.map((x) => x.id))

// 12) 同一会话在旧单文件+新目录各留一份 → 只出一条，取较新的
fs.writeFileSync(PROG, JSON.stringify({ task: "同会话旧记录", session: "session-aaa", stages: ["old"], current: 0, pct: 10, status: "running", etaMin: 9, updatedAt: Date.now() - 120000 }))
fs.writeFileSync(path.join(PDIR, "session-aaa.json"), JSON.stringify({ task: "同会话新记录", session: "session-aaa", stages: ["new"], current: 0, pct: 70, status: "running", etaMin: 2, startedAt: Date.now() - 60000, updatedAt: Date.now() }))
s = await status()
const dup = s.tasks.filter((x) => x.id === "file:session-aaa")
check("同一会话只出现一条", dup.length === 1, dup.length)
check("留下的是较新那条", dup[0] && dup[0].task === "同会话新记录", dup[0] && dup[0].task)

// 13) 超过 24 小时的分文件被清理（避免无限堆积）
const stale = path.join(PDIR, "session-old.json")
fs.writeFileSync(stale, JSON.stringify({ task: "很旧的任务", stages: ["a"], current: 0, pct: 1, status: "running", etaMin: 1, updatedAt: Date.now() - 90000000 }))
const old = new Date(Date.now() - 26 * 3600 * 1000)
fs.utimesSync(stale, old, old)
fs.writeFileSync(PROG, JSON.stringify({ task: "触发一次读", stages: ["a"], current: 0, pct: 1, status: "done", updatedAt: Date.now() }))
await status()
check("24 小时前的分文件被清理", !fs.existsSync(stale), fs.existsSync(stale))

try { fs.rmSync(HOME, { recursive: true, force: true }) } catch (e) {}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)