// S2: 子智能体任务识别 / 描述式命名 / isSub+parentId 字段（隔离 DSH_HOME，不碰真实进度文件）
import fs from 'node:fs'
import path from 'node:path'

const HOME = path.join('D:/workwork/ai/deepseek-harness/tmp', 's2-home-' + process.pid)
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })
process.env.DSH_HOME = HOME
const PROG = path.join(HOME, 'dsh-progress.json')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const listeners = {}
const routes = []
mod.apply({
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  on: (name, cb) => { listeners[name] = cb; return () => {} },
  effect: () => () => {},
  logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
})

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('OK   ' + name) } else { fail++; console.log('FAIL ' + name + ' | ' + (detail === undefined ? '' : JSON.stringify(detail))) }
}
async function getStatus() {
  const r = routes.find((x) => x.path === '/dsh-progress/status')
  let body = ''
  await r.handler({ method: 'GET' }, { writeHead: () => {}, end: (b) => { body = String(b) } })
  return JSON.parse(body)
}
const sessions = {
  'session-main': { id: 'session-main', header: { cwd: 'D:/workwork/ai/test-proj' } },
  'sub-a': { id: 'sub-a', header: { cwd: 'D:/workwork/ai/test-proj', parentSession: 'session-main', delegationDepth: 1, origin: 'subagent' } },
  'sub-b': { id: 'sub-b', header: { cwd: 'D:/workwork/ai/test-proj', parentSession: 'session-main', delegationDepth: 1, origin: 'subagent' } },
  'sub-orphan': { id: 'sub-orphan', header: { cwd: 'D:/workwork/ai/test-proj', delegationDepth: 1 } },
}
const ev = (sid, type, data) => listeners['session/event'](sessions[sid], { type, data: data || {} })
const userMsg = (sid, text) => ev(sid, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })

// —— 主任务 ——
userMsg('session-main', '帮我加一个子任务显示功能')
ev('session-main', 'turn/start', { turn: 1 })
ev('session-main', 'step/start', { turn: 1, step: 1 })

// —— 子智能体 A：有 descriptor label（真实事件顺序：descriptor → user/message → turn/start）——
ev('sub-a', 'subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: '审计 D 盘散落残留' })
userMsg('sub-a', '你是只读审计员，负责「D/E 盘散落 AI 残留」盘点，只读不许删。')
ev('sub-a', 'turn/start', { turn: 1 })
ev('sub-a', 'step/start', { turn: 1, step: 1 })

// —— 子智能体 B：没有 descriptor，只能靠任务正文命名 ——
userMsg('sub-b', '你是一个测试员，请把 progress 插件的后端用例全部跑一遍并汇报失败项。')
ev('sub-b', 'turn/start', { turn: 1 })

// —— 无父会话头的子会话：不猜测父归属 ——
userMsg('sub-orphan', '孤立子任务正文')
ev('sub-orphan', 'turn/start', { turn: 1 })

let s = await getStatus()
const byId = (id) => s.tasks.find((t) => t.id === id)

check('子任务出现在 tasks 列表(3 个子会话)', ['sub-a', 'sub-b', 'sub-orphan'].every((id) => !!byId(id)), s.tasks.map((t) => t.id))
check('主任务 isSub 不为 true', byId('session-main') && byId('session-main').isSub !== true, byId('session-main'))
check('子任务 A isSub=true', byId('sub-a') && byId('sub-a').isSub === true, byId('sub-a'))
check('子任务 A parentId=父会话 id', byId('sub-a') && byId('sub-a').parentId === 'session-main', byId('sub-a') && byId('sub-a').parentId)
check('descriptor label 当作子任务名', byId('sub-a') && byId('sub-a').task === '审计 D 盘散落残留', byId('sub-a') && byId('sub-a').task)
check('无 descriptor 时用任务正文命名(不走 TITLE_MAP)', byId('sub-b') && byId('sub-b').task !== '问题修复' && byId('sub-b').task !== '功能开发' && byId('sub-b').task.indexOf('你是一个测试员') === 0, byId('sub-b') && byId('sub-b').task)
check('正文命名截断到 24 字以内', byId('sub-b') && byId('sub-b').task.length <= 25, byId('sub-b') && byId('sub-b').task)
check('父会话头缺失时不硬猜 parentId', byId('sub-orphan') && byId('sub-orphan').isSub === true && byId('sub-orphan').parentId === '', byId('sub-orphan'))
check('buildTask 优先返回主任务(子会话更新更晚也不抢位)', s.task && s.task.id === 'session-main', s.task && s.task.id)

// 主任务结束后：子任务仍在跑 → 可以退到子任务显示
ev('session-main', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
ev('sub-a', 'step/start', { turn: 1, step: 2 })
s = await getStatus()
check('主任务结束后顶部显示仍在跑的子任务', s.task && s.task.isSub === true, s.task && { id: s.task.id, isSub: s.task.isSub })
check('子任务标签仍带 parentId', s.task && s.task.parentId === 'session-main', s.task && s.task.parentId)

// —— 进度文件声明子会话 session：合并后仍保留 isSub/parentId ——
fs.writeFileSync(PROG, JSON.stringify({
  task: '子任务上报的任务名', session: 'sub-a', stages: ['甲', '乙'], current: 0, pct: 20,
  action: '上报中', etaMin: 6, status: 'running', startedAt: Date.now(), updatedAt: Date.now(),
}))
s = await getStatus()
const merged = s.tasks.find((t) => t.id === 'sub-a')
check('文件上报合并后仍是同一条(不重复)', s.tasks.filter((t) => t.id === 'sub-a').length === 1 && !!merged, s.tasks.map((t) => t.id))
check('合并后保留 isSub / parentId', merged && merged.isSub === true && merged.parentId === 'session-main', merged && { isSub: merged.isSub, parentId: merged.parentId })
check('合并后任务名用上报值', merged && merged.task === '子任务上报的任务名', merged && merged.task)
try { fs.unlinkSync(PROG) } catch (e) {}

// 清理隔离 HOME
try { fs.rmSync(HOME, { recursive: true, force: true }) } catch (e) {}
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
