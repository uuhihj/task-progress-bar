// S2: 前端子任务折叠/展开/切换/返回父任务（mock 浏览器环境，不加载真实页面）
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

class MockEl {
  constructor(tag) {
    this.tagName = tag
    this.style = {}
    this.children = []
    this.listeners = {}
    this.className = ''
    this.id = ''
    this.parentNode = null
    this.offsetWidth = 280
    this._innerHTML = ''
  }
  set innerHTML(v) { this._innerHTML = v }
  get innerHTML() { return this._innerHTML }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1) }
  addEventListener(type, fn) { this.listeners[type] = fn }
  getBoundingClientRect() { return { left: 100, top: 100, width: 280, height: 44 } }
  setPointerCapture() {}
  closest() { return null }
}
const els = {}
const documentMock = {
  getElementById: (id) => els[id] || null,
  createElement: (tag) => new MockEl(tag),
  body: new MockEl('body'),
  head: new MockEl('head'),
  documentElement: new MockEl('html'),
}
const storage = {}
global.window = { __ModuleLoader__: { load: (spec) => { capturedSpec = spec } }, innerWidth: 1920, innerHeight: 1080, addEventListener: () => {} }
let capturedSpec = null
global.document = documentMock
global.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v) },
}
let fetchQueue = []
global.fetch = async () => {
  const resp = fetchQueue.shift()
  if (resp === undefined) return { json: async () => ({ ok: false, task: null, live: {} }) }
  return { json: async () => resp }
}
global.setInterval = () => 1
global.clearInterval = () => {}

let spec = null
global.window.__ModuleLoader__.load = (s) => { spec = s }
eval(src)
const clientExports = spec.factory(() => {})
const apply = clientExports.apply

let pass = 0, fail = 0
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('OK   ' + name) } else { fail++; console.log('FAIL ' + name + ' | ' + String(detail || '')) }
}
function applyFresh() {
  for (const k of Object.keys(els)) delete els[k]
  documentMock.body.children = []
  documentMock.head.children = []
  apply({ effect: () => () => {} })
  return documentMock.body.children.find((c) => c.id === 'dsh-progress-widget') || null
}
const tick = () => new Promise((r) => setTimeout(r, 10))
const now = Date.now()
function task(over) {
  return Object.assign({
    task: '功能开发', project: 'proj', stages: ['实现', '验证', '收尾'], current: 0, pct: 10, action: '写代码',
    etaMin: 5, status: 'running', auto: true, autoStage: true, steps: 2,
    startedAt: now - 60000, updatedAt: now - 1000, etaAnchorAt: now - 1000, etaAnchorMin: 5, etaTotalMin: 12,
  }, over)
}
const payload = () => ({
  ok: true,
  task: task({ id: 'session-main' }),
  tasks: [
    task({ id: 'session-main' }),
    task({ id: 'sub-a', task: '审计 D 盘散落残留', isSub: true, parentId: 'session-main', startedAt: now - 30000, updatedAt: now - 500, etaAnchorAt: now - 500, etaAnchorMin: 3 }),
    task({ id: 'sub-b', task: '跑一遍后端用例', isSub: true, parentId: 'session-main', startedAt: now - 20000, updatedAt: now - 400, etaAnchorAt: now - 400, etaAnchorMin: 2 }),
  ],
  live: { status: 'running', steps: 3, startAt: now - 60000, lastActivityAt: now },
  activeCount: 3,
})
const target = (cls, id) => ({
  className: cls,
  getAttribute: (k) => (k === 'data-task-id' ? id : null),
})

// T1: 默认只显示主任务，子任务不铺开
fetchQueue = [payload()]
let el = applyFresh()
await tick()
check('T1 默认显示主任务', el._innerHTML.indexOf('功能开发') >= 0 && el._innerHTML.indexOf('审计 D 盘散落残留') < 0, el._innerHTML.slice(0, 160))
check('T1 子任务默认折叠(无列表)', el._innerHTML.indexOf('dpg-sublist') < 0, el._innerHTML.slice(0, 160))
check('T1 主任务行有"子 2"折叠按钮', el._innerHTML.indexOf('dpg-subtoggle') >= 0 && el._innerHTML.indexOf('2▸') >= 0, el._innerHTML.slice(0, 200))
check('T1 子任务不占标签栏(只有一个主任务时无标签栏)', el._innerHTML.indexOf('dpg-tabs') < 0, el._innerHTML.slice(0, 200))

// T2: 点"子 2 ▸" → 展开子任务列表（名字/已用/预计还需）
el.listeners.click({ target: target('dpg-btn dpg-subtoggle', null) })
await tick()
check('T2 点开显示子任务列表', el._innerHTML.indexOf('dpg-sublist') >= 0, el._innerHTML.slice(0, 200))
check('T2 列表含两条子任务名', el._innerHTML.indexOf('↳ 审计 D 盘散落残留') >= 0 && el._innerHTML.indexOf('↳ 跑一遍后端用例') >= 0, el._innerHTML.slice(0, 400))
check('T2 每条带已用/预计还需', el._innerHTML.indexOf('已用') >= 0 && el._innerHTML.indexOf('预计还需') >= 0, el._innerHTML.slice(0, 400))
check('T2 展开后按钮变 ▾', el._innerHTML.indexOf('2▾') >= 0, el._innerHTML.slice(0, 200))

// T3: 点子任务 → 切到子任务详情（带 ↳ 子任务标记 + 返回父任务）
el.listeners.click({ target: target('dpg-subitem', 'sub-a') })
await tick()
check('T3 点子任务切到子任务详情', el._innerHTML.indexOf('dpg-task">审计 D 盘散落残留') >= 0 && el._innerHTML.indexOf('dpg-task">功能开发') < 0, el._innerHTML.slice(0, 300))
check('T3 子任务详情带"↳ 子任务"标记', el._innerHTML.indexOf('↳ 子任务') >= 0, el._innerHTML.slice(0, 300))
check('T3 子任务详情带"返回父任务"按钮', el._innerHTML.indexOf('dpg-back') >= 0, el._innerHTML.slice(0, 300))
check('T3 锁定保存到 localStorage', storage['dsh-progress-pinned'] === 'sub-a', storage['dsh-progress-pinned'])

// T4: 点"返回父任务" → 回到主任务
el.listeners.click({ target: target('dpg-btn dpg-back', 'session-main') })
await tick()
check('T4 返回父任务', el._innerHTML.indexOf('功能开发') >= 0 && el._innerHTML.indexOf('↳ 子任务') < 0, el._innerHTML.slice(0, 300))

// T5: 父子关联拿不到（父不在列表）→ 子任务单独成标签并标"↳ 子"
delete storage['dsh-progress-pinned']
fetchQueue = [{
  ok: true,
  task: task({ id: 'sub-orphan', task: '孤儿任务', isSub: true, parentId: 'dead-parent' }),
  tasks: [task({ id: 'sub-orphan', task: '孤儿任务', isSub: true, parentId: 'dead-parent' })],
  live: { status: 'running', steps: 1, startAt: now - 5000, lastActivityAt: now },
  activeCount: 1,
}]
el = applyFresh()
await tick()
check('T5 父缺失时子任务仍可见', el._innerHTML.indexOf('孤儿任务') >= 0, el._innerHTML.slice(0, 200))
check('T5 子任务带 ↳ 标记', el._innerHTML.indexOf('↳ 子任务') >= 0, el._innerHTML.slice(0, 200))

// T6: 后端把子任务放在 task 首位（跟随最新）→ 仍显示主任务，不被子任务顶掉
fetchQueue = [payload()]
fetchQueue = [Object.assign(payload(), { task: payload().tasks[1] })]
el = applyFresh()
await tick()
check('T6 跟随最新时优先主任务', el._innerHTML.indexOf('dpg-task">功能开发') >= 0 && el._innerHTML.indexOf('dpg-task">审计') < 0, el._innerHTML.slice(0, 200))

// T7: 折叠成圆点后仍可点开（回归：新增按钮不影响收起/展开）
el.listeners.click({ target: target('dpg-btn', null) })
await tick()
check('T7 点收起按钮折叠', el.className.indexOf('dpg-collapsed') >= 0, el.className)
el.listeners.click({ target: target('whatever', null) })
await tick()
check('T7 折叠态点击展开', el.className.indexOf('dpg-collapsed') < 0, el.className)

// T8: 面板带 × 隐藏按钮，点了进隐藏态（只留 12px 淡点）
fetchQueue = [payload()]
el = applyFresh()
await tick()
check('T8 面板带隐藏按钮', el._innerHTML.indexOf('dpg-hide') >= 0, el._innerHTML.slice(0, 140))
el.listeners.click({ target: target('dpg-btn dpg-hide', null) })
await tick()
check('T8 点 × 进入隐藏态', el.className.indexOf('dpg-hidden') >= 0, el.className)
check('T8 隐藏态不渲染任务正文', el._innerHTML.indexOf('dpg-task') < 0, el._innerHTML.slice(0, 120))

// T9: 点隐藏小点恢复
el.listeners.click({ target: target('dpg-idle-dot', null) })
await tick()
check('T9 点小点恢复显示', el.className.indexOf('dpg-hidden') < 0, el.className)
check('T9 恢复后重新渲染任务', el._innerHTML.indexOf('dpg-task') >= 0, el._innerHTML.slice(0, 140))

// T10: 收起成 40px 小圆点后，点击时手抖 10px 仍要能点开
// 回归：拖动阈值 8px 会把小圆点上的抖动误判成拖动，随后吞掉 click → "收起点不开"
fetchQueue = [payload()]
el = applyFresh()
await tick()
await new Promise((r) => setTimeout(r, 300))   // 收起按钮有 250ms 防连点
el.listeners.click({ target: target("dpg-btn", null) })
await tick()
check("T10 先收起", el.className.indexOf("dpg-collapsed") >= 0, el.className)
el.listeners.pointerdown({ target: target("dpg-dot", null), clientX: 100, clientY: 100, button: 0, pointerId: 1 })
el.listeners.pointermove({ clientX: 110, clientY: 102 })
el.listeners.pointerup({})
el.listeners.click({ target: target("dpg-dot", null) })
await tick()
check("T10 小圆点手抖后仍能点开", el.className.indexOf("dpg-collapsed") < 0, el.className)

// T11: 真拖动（50px）不该被当成点击，保持收起
await new Promise((r) => setTimeout(r, 300))
el.listeners.click({ target: target("dpg-btn", null) })
await tick()
el.listeners.pointerdown({ target: target("dpg-dot", null), clientX: 100, clientY: 100, button: 0, pointerId: 1 })
el.listeners.pointermove({ clientX: 150, clientY: 100 })
el.listeners.pointerup({})
el.listeners.click({ target: target("dpg-dot", null) })
await tick()
check("T11 真拖动后不展开", el.className.indexOf("dpg-collapsed") >= 0, el.className)

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail > 0 ? 1 : 0)
