// dsh-progress-widget host half v2.1: task lifecycle fully event-driven, multi-session.
// 每个会话（sessionId）独立跟踪任务：用户消息→turn/start 开任务；step 计数；空闲自动结束。
// 多会话并发时：进度条显示最近活跃任务 + activeCount（并发数）。
// agent 进度文件（dsh-progress.json）为可选增强层：有则显示阶段/动作/ETA，无则纯自动。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// 旧版单文件：所有会话共写一个文件，谁最后写谁覆盖——别人的任务条会突然退回"自动估计"。
// 新版按会话分文件：dsh-progress/<会话id>.json，各写各的、物理上不可能互相覆盖。
// 旧文件仍保留读取（老 agent 还在往里写），作为兼容层。
const PROGRESS_FILE = path.join(DSH_HOME, 'dsh-progress.json')
const PROGRESS_DIR = path.join(DSH_HOME, 'dsh-progress')
const PROGRESS_DIR_KEEP_MS = 24 * 60 * 60 * 1000
const BASELINE_FILE = path.join(DSH_HOME, 'dsh-progress-baselines.json')
const DONE_KEEP_MS = 2 * 60 * 1000
const IDLE_END_MS = 10 * 60 * 1000 // 兜底：turn 打开但 10 分钟无活动视为卡死结束
const FILE_STALE_MS = 2 * 60 * 1000 // agent 上报任务 2 分钟未更新视为残留失效
const SWEEP_MS = 4000

// 上次成功解析的进度文件读数：文件正在被写入（半截 JSON）时用它顶 2 秒，
// 避免任务条因为一次坏读数突然整块消失。
let lastGoodTask = null
let lastGoodAt = 0
let lastCleanAt = 0
const BAD_READ_GRACE_MS = 2000
const lastGoodByKey = new Map()
function parseProgressFile(file, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.task === 'string' && Array.isArray(parsed.stages)) {
      lastGoodByKey.set(key, parsed)
      lastGoodAt = Date.now()
      return parsed
    }
  } catch (err) {
    // 只在"文件存在但读坏了"时兜底；文件被删掉要立刻消失（与旧行为一致）
    if (err && err.code !== 'ENOENT') {
      const prev = lastGoodByKey.get(key)
      if (prev && Date.now() - lastGoodAt < BAD_READ_GRACE_MS) return prev
    }
    lastGoodByKey.delete(key)
  }
  return null
}
// 读全部上报任务：①新目录下每个会话一份 ②旧单文件（兼容老 agent）
// 每条带 reportId（会话 id 或 legacy），供上层生成不冲突的任务 id、并在合并时定位到发起会话。
function readFileTasks() {
  const out = []
  let names = []
  try {
    names = fs.readdirSync(PROGRESS_DIR).filter((n) => n.endsWith('.json'))
  } catch (err) { names = [] }
  const alive = new Set()
  for (const name of names) {
    const full = path.join(PROGRESS_DIR, name)
    alive.add(full)
    const parsed = parseProgressFile(full, full)
    if (parsed) out.push({ ...parsed, reportId: parsed.session ? String(parsed.session) : name.replace(/\.json$/, ''), source: 'dir' })
  }
  // 顺手清理超过 24 小时没更新的分文件（避免无限堆积），含读坏的历史文件。
  // /status 每秒会调这里，清理按 60 秒节流，别每次都 stat 一遍。
  // 每个会话一个文件、活跃会话通常个位数，逐次 stat 的开销可忽略，不做节流（节流会让刚超期的文件多留一轮）
  for (const name of names) {
    const full = path.join(PROGRESS_DIR, name)
    try {
      const st = fs.statSync(full)
      if (Date.now() - st.mtimeMs > PROGRESS_DIR_KEEP_MS) { fs.unlinkSync(full); lastGoodByKey.delete(full) }
    } catch (err) {}
  }
  const legacy = parseProgressFile(PROGRESS_FILE, PROGRESS_FILE)
  if (legacy) out.push({ ...legacy, reportId: legacy.session ? String(legacy.session) : 'legacy', source: 'legacy' })
  return out
}
function readBaseline(project) {
  try {
    const p = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
    const entry = p && typeof p === 'object' ? p[project] : null
    if (entry && typeof entry === 'object') {
      const n = Number(entry['默认'] ?? entry['default'])
      if (isFinite(n) && n > 0) return n
    }
  } catch (err) {}
  return 3
}
function textOf(msg) {
  try {
    if (!msg) return ''
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
        .trim()
    }
    if (typeof msg.content === 'string') return msg.content.trim()
    return ''
  } catch (err) { return '' }
}
// 轻度总结：关键词映射成短任务名；无命中则清洗兜底
const TITLE_MAP = [
  [/修|bug|报错|错误|不行|失败|坏了|出问题|异常|打不开/, '问题修复'],
  [/开发|实现|做|写|加一个|新增|功能|插件|脚本|搭|改|修改|优化|完善/, '功能开发'],
  [/为什么|原因|分析|查|排查|看看|看一下/, '问题分析'],
  [/整理|分类|移动|清理|重命名|归档|归纳/, '文件整理'],
  [/安装|部署|配置|接入/, '安装部署'],
  [/测试|验证|检查|试用/, '测试验证'],
  [/总结|回顾|复盘/, '总结'],
  [/方案|建议|怎么办|怎么弄|如何|怎么处理|给点/, '方案咨询'],
  // 英文任务：中文规则匹配不到时兜底（用户偶尔用英文派活）
  [/\b(fix|bug|error|broken|crash|fail(ed|ure)?)\b/i, '问题修复'],
  [/\b(implement|add|build|create|feature|write|refactor)\b/i, '功能开发'],
  [/\b(why|analy[sz]e|investigate|check|debug|look into|figure out)\b/i, '问题分析'],
  [/\b(clean|organi[sz]e|sort|move|rename|archive)\b/i, '文件整理'],
  [/\b(install|deploy|setup|configure|migrate)\b/i, '安装部署'],
  [/\b(test|verify|validate|smoke)\b/i, '测试验证'],
  [/\b(summary|summari[sz]e|retro|retrospective|review)\b/i, '总结'],
  [/\b(plan|proposal|approach|options|how (do|to))\b/i, '方案咨询'],
]
function summarizeTitle(text) {
  const raw = String(text || '').trim()
  if (!raw) return '新任务'
  for (const [re, label] of TITLE_MAP) {
    if (re.test(raw)) return label
  }
  let t = raw
  t = t.replace(/^(请你帮我|请你|帮我|麻烦你|麻烦|请|帮我一下|帮忙|能不能|可不可以|你给我|你帮我|你来|给我|你觉得|你怎么|你告诉我|那你|那你觉得|我想|我要)/, '')
  t = t.replace(/[。！!？?\s,，]+$/, '')
  t = t.trim()
  if (!t) return '新任务'
  const stop = t.search(/[。！!？?]/)
  if (stop > 0) t = t.slice(0, stop)
  if (t.length > 20) {
    // 英文按单词边界截，避免出现 "implement a hal…" 这种断词
    if (/^[\x20-\x7E]*$/.test(t)) {
      const cut = t.slice(0, 20)
      const sp = cut.lastIndexOf(' ')
      t = (sp > 8 ? cut.slice(0, sp) : cut).trim() + '…'
    } else {
      t = t.slice(0, 20) + '…'
    }
  }
  return t
}
// 子智能体任务名：不走 TITLE_MAP 归类（否则一堆子任务全都叫"问题修复"、分不清谁是谁），
// 优先用派发描述（subagent/descriptor 的 label），拿不到才用任务文本清洗截断。
function summarizeSubTitle(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return '子任务'
  let t = raw.replace(/^(请你帮我|请你|帮我|麻烦你|麻烦|请|帮我一下|帮忙|能不能|可不可以|你给我|你帮我|你来|给我)/, '').trim()
  const stop = t.search(/[。！!？?\n]/)
  if (stop > 0) t = t.slice(0, stop)
  if (t.length > 24) t = t.slice(0, 24) + '…'
  return t || '子任务'
}
// 自动阶段模板：按任务关键词猜阶段（方案 C 兜底，标注"自动估计"）
function guessStages(text) {
  const t = String(text || '')
  if (/修|bug|报错|错误|不行|失败|异常|打不开/.test(t)) return ['定位问题', '实施修复', '验证结果']
  if (/开发|实现|功能|插件|脚本|新增|搭建/.test(t)) return ['实现', '验证', '收尾']
  if (/为什么|原因|分析|排查|查|看看/.test(t)) return ['收集信息', '分析原因', '给出结论']
  if (/整理|分类|清理|移动|归档|归纳/.test(t)) return ['盘点现状', '分类处理', '校验交付']
  if (/方案|建议|怎么办|怎么弄|如何/.test(t)) return ['分析需求', '拟定方案', '交付方案']
  if (/安装|部署|配置|接入/.test(t)) return ['准备', '执行安装', '验证生效']
  return ['处理中', '收尾']
}
// 有逻辑的 ETA 估算：问题复杂度（字数）× 项目类型系数
function estimateEta(text, project) {
  const len = String(text || '').length
  let base
  if (len < 20) base = 2
  else if (len < 80) base = 3
  else if (len < 200) base = 5
  else if (len < 500) base = 8
  else base = 12
  const proj = readBaseline(project)
  return Math.max(1, Math.min(60, Math.round((base * proj) / 6)))
}

// —— ETA 先验与在线学习（0.4.0）——
// 内置先验：来自 1481 个真实 turn 的实测统计，含义是"跑到第 N 步时，之后通常还要多久（秒）"。
// 分发时这是通用经验值；每个用户装机后用他自己的样本自动修正（存在 DSH_HOME 下，不碰代码目录）。
const ETA_PRIOR = [
  [1, 2, 66, 234],
  [2, 3, 55, 240],
  [3, 5, 60, 300],
  [5, 10, 72, 294],
  [10, 16, 66, 306],
  [16, 26, 138, 618],
  [26, Infinity, 186, 618],
]
function priorFor(step) {
  const s = Math.max(1, Math.floor(Number(step) || 1))
  for (const r of ETA_PRIOR) if (s >= r[0] && s < r[1]) return { p50: r[2], p75: r[3] }
  return { p50: 180, p75: 900 }
}
const STATS_FILE = path.join(DSH_HOME, 'dsh-progress-stats.json')
const STATS_MAX = 400
let statsCache = null
let statsDirty = false
let statsLastWrite = 0
function loadStats() {
  if (statsCache) return statsCache
  try {
    const p = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
    statsCache = (p && Array.isArray(p.samples))
      ? p.samples.filter((x) => x && isFinite(x.s) && isFinite(x.r)).slice(-STATS_MAX)
      : []
  } catch (err) { statsCache = [] }
  return statsCache
}
// 本机样本够 20 条就用本机分位数，否则退回内置先验
function learnedFor(step) {
  try {
    const s = Math.max(1, Math.floor(Number(step) || 1))
    const bucket = ETA_PRIOR.find((r) => s >= r[0] && s < r[1])
    if (!bucket) return null
    const arr = loadStats()
      .filter((x) => x.s >= bucket[0] && x.s < bucket[1])
      .map((x) => x.r)
      .sort((a, b) => a - b)
    if (arr.length < 20) return null
    return { p50: arr[Math.floor(arr.length * 0.5)], p75: arr[Math.floor(arr.length * 0.75)], n: arr.length }
  } catch (err) { return null }
}
function recordSamples(rows) {
  if (!Array.isArray(rows) || !rows.length) return
  const all = loadStats()
  for (const r of rows) all.push(r)
  while (all.length > STATS_MAX) all.shift()
  statsCache = all
  statsDirty = true
}
function flushStats() {
  if (!statsDirty) return
  const now = Date.now()
  if (now - statsLastWrite < 15000) return
  statsLastWrite = now
  statsDirty = false
  try {
    const tmp = STATS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: now, samples: statsCache }))
    fs.renameSync(tmp, STATS_FILE)
  } catch (err) {}
}

export const name = 'dsh-progress-widget'
export const inject = ['webServer', 'agents']

// 可配置项（在 profile 的 cordis.patch.yml 里按 id 覆盖 config；取不到就用默认值，行为与旧版一致）
const DEFAULT_CONFIG = {
  protocolHint: true,   // 每轮注入"维护进度文件"提醒（约 150 字）；关掉后只剩自动估算
  pollMs: 1000,         // 前端轮询间隔
  doneHoldMs: 30000,    // 终态任务在面板上停留多久
  doneKeepMs: 120000,   // 终态任务在内存里保留多久（供"已结束"显示）
  maxTasks: 64,         // 最多跟踪多少个会话任务，超出按"最久没活动"淘汰
}
export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, (config && typeof config === 'object') ? config : {})
  const disposers = []
  const live = { status: 'idle', steps: 0, startAt: 0, lastActivityAt: 0 }
  const taskMap = new Map()
  const userTextMap = new Map()
  let doneList = []

  // —— 每轮注入提醒（方案 C）：让 agent 知道进度上报协议（参考 dsh-prompt-injector 安全模式）——
  // 每轮注入的上报协议：附带当前会话 id（agent.id===session.id），
  // 进度文件里的 session 字段让插件能把上报任务和本会话任务精确合并成一条（不靠时间猜测）。
  function protocolText(sid) {
    const who = String(sid || '')
    return '执行任务时维护**你自己的**进度文件 $DSH_HOME/dsh-progress/<你的会话id>.json（目录不存在就建；文件名就用会话 id，例如 $DSH_HOME/dsh-progress/' + (who || 'session-xxx') + '.json）。⚠️**千万不要写 $DSH_HOME/dsh-progress.json 那个单文件**——那里是所有会话共用的旧位置，谁写谁覆盖，会把别人的任务条顶掉。开工第一步写 {"task":"总结性任务名","session":"' + who + '","stages":["阶段1",...],"current":0,"pct":10,"action":"正在…","etaMin":N,"status":"running","startedAt":毫秒,"updatedAt":毫秒}；session 必须原样填当前会话 id（插件据此把你这条上报合并到本会话的任务上，避免同一任务显示两条）。' +
      '⚠️**每完成一个可交付的小步就更新** current/pct/action/etaMin/updatedAt，不要只在阶段边界更新；**任何单步预计超过 60 秒的，先在 action 里写清"正在做什么（第 N/M 个）"再去做**，做完立刻更新一次。action 要写具体动作（如"渲染第 7/24 张"），不要写"处理中/排队中"这类空话。' +
      '⚠️遇到报错、等待用户确认、卡住不动时，立刻写 {"status":"blocked","issue":"一句话说清卡在哪","updatedAt":毫秒}，恢复后改回 status:"running"；插件会把 blocked 显示成橙色并展示 issue，用户就不会以为还在跑。' +
      '任务真正结束才标 {"status":"done","pct":100,"endedAt":毫秒}。ETA 按阶段数×复杂度推算并在回复中说明依据，简单任务≤3分钟。'
  }
  const hookedAgents = new WeakSet()
  function installAgentHook(agent) {
    if (!agent || !agent.id || !agent.ctx) return
    if (hookedAgents.has(agent)) return
    hookedAgents.add(agent)
    try {
      agent.ctx.on('agent/pre-step', async (payload, next) => {
        let decision
        try {
          decision = await next()
        } catch (error) {
          throw error
        }
        try {
          if (!cfg.protocolHint) return decision
          if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
          const freshUser = ((payload && payload.messages) || []).find((m) => m && m.source && m.source.kind === 'user')
          if (!freshUser) return decision
          decision.messages.push({
            id: 'dpg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text: protocolText(agent.id) }],
            // 0.2.1 的 session format v4 拒收 {kind:'plugin', plugin:'xxx'} 旧包装，
            // 第三方插件必须用生产者自己的 kind：plugin:<包名>（与内核迁移函数 producerKind 的映射一致）。
            source: { kind: 'plugin:dsh-progress-widget', form: 'notice', summary: '任务进度上报协议' },
          })
          return decision
        } catch (err) {
          return decision
        }
      })
    } catch (err) {}
  }
  try {
    disposers.push(ctx.on('agent/created', ({ agent }) => installAgentHook(agent)))
  } catch (err) {}

  // 子智能体会话识别：header.delegationDepth>0 即子智能体派出的会话；
  // 父会话 id 只在 header.parentSession 存在时采用（拿不到就不硬猜）。
  function markLineage(task, session) {
    try {
      const hd = session && session.header
      if (!hd || !task) return
      if (typeof hd.delegationDepth === 'number' && hd.delegationDepth > 0) task.isSub = true
      if (task.isSub && hd.parentSession) task.parentId = String(hd.parentSession)
    } catch (err) {}
  }
  function subTitleOf(task, text) {
    if (task && task.subLabel) return task.subLabel
    return summarizeSubTitle(text)
  }

  function taskOf(sid) {
    let t = taskMap.get(sid)
    if (!t) {
      t = { active: false, open: false, title: '', project: '', startedAt: 0, steps: 0, lastActivityAt: 0, sid, isSub: false, parentId: '', subLabel: '', subTitled: false, _stepTimes: [], todoDone: 0, todoTotal: 0, etaSmooth: 0 }
      taskMap.set(sid, t)
      enforceCapacity(sid)
    }
    return t
  }
  function endTask(sid) {
    const t = taskMap.get(sid)
    if (!t || !t.active) return
    t.active = false
    const ended = Date.now()
    // 学到一条真实样本：某个 step 发生时刻离任务结束还有多久（用于本机自校正 ETA）
    try {
      if (Array.isArray(t._stepTimes) && t._stepTimes.length) {
        const rows = []
        t._stepTimes.forEach((at, i) => {
          const remainSec = (ended - at) / 1000
          if (remainSec > 0 && remainSec < 7200) rows.push({ s: i + 1, r: Math.round(remainSec) })
        })
        recordSamples(rows)
        flushStats()
      }
    } catch (err) {}
    t._stepTimes = []
    doneList.push({ title: t.title, project: t.project, startedAt: t.startedAt, endedAt: ended, at: ended })
    doneList = doneList.filter((d) => ended - d.at < cfg.doneKeepMs)
    enforceCapacity(sid)
  }
  // 淘汰"最久没有活动"的会话（旧实现删最早插入的，长会话会被误删）
  function enforceCapacity(skipSid) {
    if (taskMap.size <= cfg.maxTasks) return
    let victim = null
    let oldestAt = Infinity
    for (const [otherSid, other] of taskMap) {
      if (otherSid === skipSid) continue
      const at = Number(other.lastActivityAt) || 0
      if (at < oldestAt) { oldestAt = at; victim = otherSid }
    }
    if (victim) taskMap.delete(victim)
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const sid = (session && session.id) ? String(session.id) : 'default'
      const type = event.type
      // 子智能体派发描述：label 就是用户能看懂的那句话（如"审计 D/E 散落残留"），
      // 它是子任务名的首选来源，比截断任务正文准确得多。
      if (type === 'subagent/descriptor') {
        const dd = event.data || {}
        const label = dd && typeof dd.label === 'string' ? dd.label.trim() : ''
        if (label) {
          const sub = taskOf(sid)
          sub.subLabel = label
          sub.isSub = true
          markLineage(sub, session)
          if (sub.active) { sub.title = label; sub.lastActivityAt = Date.now() }
        }
        return
      }
      // 待办清单：agent 用 todo 工具时会写全量列表 → 这是"还剩几件事"的最可靠信号
      if (type === 'todo/write' || type === 'todo/update') {
        const td = event.data || {}
        const todos = Array.isArray(td.todos) ? td.todos : []
        if (todos.length) {
          const tk = taskOf(sid)
          let done = 0
          for (const it of todos) {
            const st = it && it.status ? String(it.status) : ''
            if (st === 'completed') done++
          }
          tk.todoDone = done
          tk.todoTotal = todos.length
          tk.lastActivityAt = Date.now()
        }
        return
      }
      if (type === 'user/message') {
        const d = event.data
        const src = d && d.source
        if (src && src.kind === 'user') {
          const t = textOf(d)
          if (t) {
            userTextMap.set(sid, t)
            // 用户消息在 step/start 之后才进事件流：回填正在运行任务的标题（总结后）
            const task = taskMap.get(sid)
            if (task && task.active) {
              markLineage(task, session)
              if (task.isSub) {
                // 子任务只在第一条任务描述时命名，后续追问不改名（避免名字乱跳）
                if (!task.subTitled) { task.title = subTitleOf(task, t); task.subTitled = true }
              } else {
                task.title = summarizeTitle(t)
              }
              task.lastActivityAt = Date.now()
            }
          }
        }
        return
      }
      if (type === 'turn/start') {
        const task = taskOf(sid)
        markLineage(task, session)
        const pendingText = userTextMap.get(sid) || ''
        task.open = true
        if (!task.active) {
          // 立即开任务（标题先用 pending 文本或"处理中"，稍后由 user/message 回填）
          task.active = true
          task.startedAt = Date.now()
          task.steps = 0
          task._stepTimes = []
          task.todoDone = 0
          task.todoTotal = 0
          task.etaSmooth = 0
          task.lastActivityAt = Date.now()
          task.title = pendingText ? (task.isSub ? subTitleOf(task, pendingText) : summarizeTitle(pendingText)) : '处理中'
          if (task.isSub && pendingText) task.subTitled = true
          task.project = ''
          try {
            const cwd = (session && session.header && session.header.cwd) ? String(session.header.cwd) : ''
            if (cwd) task.project = path.basename(cwd)
          } catch (err) {}
        } else {
          task.lastActivityAt = Date.now()
        }
        if (pendingText) userTextMap.delete(sid)
        if (live.status === 'idle') live.status = 'running'
        if (!live.startAt) live.startAt = Date.now()
        live.lastActivityAt = Date.now()
        return
      }
      if (type === 'step/start') {
        const task = taskOf(sid)
        if (task.active) {
          task.steps++
          if (!Array.isArray(task._stepTimes)) task._stepTimes = []
          task._stepTimes.push(Date.now())
          task.lastActivityAt = Date.now()
        }
        live.steps++
        live.lastActivityAt = Date.now()
        if (!live.startAt) live.startAt = Date.now()
        if (live.status === 'idle') live.status = 'running'
        return
      }
      if (type === 'turn/end') {
        const task = taskOf(sid)
        if (task.active) {
          task.open = false
          task.lastActivityAt = Date.now()
          // 本轮真正结束 → 立即结束任务（显示"已结束"），下轮 turn/start 会开新任务
          endTask(sid)
        }
        return
      }
    } catch (err) {}
  }))

  try {
    disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      const st = String(status || 'idle')
      live.status = st
      live.lastActivityAt = Date.now()
      if (st === 'running' && !live.startAt) live.startAt = Date.now()
      if (agent && agent.id && st === 'running') {
        const task = taskMap.get(String(agent.id))
        if (task && task.active) task.lastActivityAt = Date.now()
      }
      // 注意：idle 事件不再直接结束任务——dsh 的 maintenance 阶段也报 idle，
      // 轮次之间会误杀正在进行的任务；结束统一由 sweep 按"turn 已结束且超时"判定。
    }))
  } catch (err) {}

  // 周期兜底：turn 打开但 10 分钟无活动 → 视为卡死结束（防 turn 永不 end 的极端情况）
  const sweepTimer = setInterval(() => {
    try {
      const now = Date.now()
      for (const [sid, t] of taskMap) {
        if (t.active && t.open === true && now - t.lastActivityAt > IDLE_END_MS) endTask(sid)
      }
    } catch (err) {}
  }, SWEEP_MS)

  function latestActiveTask() {
    let latest = null
    for (const [, t] of taskMap) {
      if (!t.active) continue
      // >= 保证同毫秒并发时，后开的任务优先显示
      if (!latest || t.lastActivityAt >= latest.lastActivityAt) latest = t
    }
    return latest
  }
  function activeCount() {
    let n = 0
    for (const [, t] of taskMap) if (t.active) n++
    return n
  }

  // 自动层单个任务的展示载荷（buildTask 与 listActiveTasks 共用，保证字段一致）
  function autoTaskPayload(t, nowMs) {
    const elapsedMs = nowMs - t.startedAt
    // 自动阶段模板（方案 C）：按关键词猜阶段，步数推进（每 3 步进一阶段）
    const stages = guessStages(t.title)
    const total = Math.max(1, stages.length)
    const current = Math.min(total - 1, Math.floor(t.steps / 3))
    const stagePct = Math.min(100, Math.round(((t.steps % 3) / 3) * 100))
    // 0.4.0 ETA：按"当前跑到第几步"查分位数（本机学习优先、内置先验兜底），
    // 不再用消息字数猜总时长（实测字数与真实耗时几乎无关，旧算法普遍高估 2-6 倍）。
    const elapsedSec = Math.max(0, elapsedMs / 1000)
    // 三档优先级：待办完成度（最准，能提前知道还剩几件事）> 本机学习 > 内置先验
    const todoTotal = Number(t.todoTotal) || 0
    const todoDone = Number(t.todoDone) || 0
    let prior
    let etaSrc
    if (todoTotal >= 2 && todoDone >= 1) {
      const perItemSec = elapsedSec / todoDone
      const left = Math.max(0, todoTotal - todoDone)
      prior = { p50: Math.max(10, perItemSec * left), p75: Math.max(30, perItemSec * left * 2.2) }
      etaSrc = 'todo'
    } else {
      const learned = learnedFor(t.steps)
      prior = learned || priorFor(t.steps)
      etaSrc = learned ? 'local' : 'prior'
    }
    const overLimit = Math.min(prior.p75, Math.max(prior.p50 * 1.8, prior.p50 + 60))
    const overSec = elapsedSec - overLimit
    let remainMin
    if (overSec > 30) {
      // 已超过这类任务的 P75 耗时 → 报负数，前端显示"已超预估 X 分钟"（诚实，不继续假装还剩几秒）
      remainMin = -Math.max(1, Math.round(overSec / 60))
    } else {
      // 中位剩余随时间收缩，但保底 5 秒，避免一路掉到 0 还在跑
      remainMin = Math.max(5, prior.p50 - elapsedSec * 0.6) / 60
    }
    // 平滑：跳到一个新的 step 桶时分位数会突变，用 35% 逼近避免数字跳变
    const prevSmooth = Number(t.etaSmooth)
    t.etaSmooth = isFinite(prevSmooth) && prevSmooth !== 0 ? prevSmooth + (remainMin - prevSmooth) * 0.35 : remainMin
    if (Math.abs(t.etaSmooth - remainMin) < 0.03) t.etaSmooth = remainMin
    const totalEtaMin = elapsedMs / 60000 + Math.max(0, t.etaSmooth)
    return {
      id: t.sid || '',
      isSub: !!t.isSub,
      parentId: t.parentId || '',
      task: t.title,
      project: t.project,
      stages, current, pct: stagePct,
      action: '', etaMin: Math.max(0, Math.round(t.etaSmooth)), status: 'running', steps: t.steps, auto: true,
      autoStage: true,
      startedAt: t.startedAt, updatedAt: t.lastActivityAt,
      etaAnchorAt: nowMs, etaAnchorMin: t.etaSmooth, etaTotalMin: totalEtaMin,
      // 0.4.0：ETA 的可解释字段（前端可选用）
      etaBasis: etaSrc,
      etaP75Min: Math.round(prior.p75 / 60),
      todoDone: t.todoDone || 0, todoTotal: t.todoTotal || 0,
    }
  }

  function buildTask() {
    const list = listActiveTasks()
    // agent 上报（或合并后的）任务优先展示：它包含真实阶段/动作/ETA
    // 主任务优先：子智能体的任务不顶掉父任务，父任务结束才退到子任务
    const reported = list.find((t) => t.auto === false && t.isSub !== true) || list.find((t) => t.auto === false)
    if (reported) return { ...reported, activeCount: activeCount() }
    const mainTask = list.find((t) => t.isSub !== true)
    if (mainTask) return { ...mainTask, activeCount: activeCount() }
    if (list.length) return { ...list[0], activeCount: activeCount() }
    // 最近完成的任务（2 分钟内）
    if (doneList.length) {
      const d = doneList[doneList.length - 1]
      if (Date.now() - d.at < cfg.doneKeepMs) {
        return {
          task: d.title, project: d.project, stages: [], current: 0, pct: 100,
          action: '', etaMin: 0, status: 'done', steps: 0, auto: true,
          startedAt: d.startedAt, endedAt: d.endedAt, updatedAt: d.endedAt,
          activeCount: 0,
        }
      }
    }
    return null
  }

  // 可切换的任务列表：每个会话的活跃任务；若文件上报任务声明了 session 且该会话活跃，
  // 则把它合并进该会话条目（同一任务只显示一条：精确归属、不做时间猜测）。
  function listActiveTasks() {
    const nowMs = Date.now()
    const out = []
    for (const [sid, t] of taskMap) {
      if (!t.active) continue
      const p = autoTaskPayload(t, nowMs)
      p.id = p.id || String(sid)
      p.activeCount = activeCount()
      out.push(p)
    }
    // 逐条处理所有上报（每会话一份 + 兼容旧单文件）。blocked 也要显示，
    // 否则"卡住了"在界面上等于不存在，用户只会以为还在跑。
    const reportsByKey = new Map()
    for (const rep of readFileTasks()) {
      const key = String(rep.reportId || 'legacy')
      const prev = reportsByKey.get(key)
      if (!prev || (Number(rep.updatedAt) || 0) >= (Number(prev.updatedAt) || 0)) reportsByKey.set(key, rep)
    }
    for (const fileTask of reportsByKey.values()) {
      const fileStatus = String(fileTask.status || '')
      if (fileStatus !== 'running' && fileStatus !== 'blocked') continue
      const fileAge = nowMs - Number(fileTask.updatedAt || 0)
      const eta = Number(fileTask.etaMin) || 0
      const staleLine = Math.max(FILE_STALE_MS, eta * 60000 * 1.5)
      // 过期不再直接丢弃：保留最后一次真实阶段与动作，只标注"真实进度已中断 N 分钟"。
      // 旧行为是整段丢掉、退回按关键词猜的阶段模板——用户会以为那是真实进度。
      const staleStale = fileAge > staleLine && activeCount() === 0
      const staleInfo = staleStale ? { staleReport: true, staleMin: Math.max(1, Math.round(fileAge / 60000)) } : {}
      const anchored = (fileStatus === 'running' && !staleStale && eta > 0)
        ? { etaAnchorAt: Number(fileTask.updatedAt) || nowMs, etaAnchorMin: eta }
        : {}
      const fileStartedAt = Number(fileTask.startedAt) || 0
      const ownerId = fileTask.session ? String(fileTask.session) : ''
      const owner = ownerId ? out.find((x) => x.id === ownerId) : null
      if (owner) {
        // 精确合并：任务名/阶段/动作/ETA 用 agent 上报值，会话 id/步数/开始时间保留自动层
        out[out.indexOf(owner)] = {
          ...owner,
          task: fileTask.task || owner.task,
          project: fileTask.project || owner.project,
          stages: Array.isArray(fileTask.stages) && fileTask.stages.length ? fileTask.stages : owner.stages,
          current: Number(fileTask.current) || 0,
          pct: Number(fileTask.pct) || 0,
          action: fileTask.action || '',
          etaMin: Math.max(0, Number(fileTask.etaMin) || 0),
          status: fileStatus,
          issue: fileStatus === 'blocked' ? String(fileTask.issue || '') : '',
          auto: false,
          autoStage: false,
          updatedAt: Math.max(Number(owner.updatedAt) || 0, Number(fileTask.updatedAt) || 0),
          startedAt: Number(owner.startedAt) || fileStartedAt || nowMs,
          ...staleInfo,
          ...anchored,
        }
      } else {
        // 没声明 session 或该会话已不活跃：保留独立条目（不猜测归属）
        out.push({
          ...fileTask,
          // 每条上报一个独立 id：旧版全都叫 'file'，多会话时后一条会顶掉前一条
          id: 'file:' + String(fileTask.reportId || 'legacy'),
          fileSource: fileTask.source || 'legacy',
          auto: false,
          steps: 0,
          activeCount: activeCount(),
          status: fileStatus,
          issue: fileStatus === 'blocked' ? String(fileTask.issue || '') : '',
          startedAt: fileStartedAt || nowMs,
          ...staleInfo,
          ...anchored,
        })
      }
    }
    out.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    return out
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-progress/status',
    handler: (req, res) => {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, task: buildTask(), tasks: listActiveTasks(), live, activeCount: activeCount(), config: { pollMs: cfg.pollMs, doneHoldMs: cfg.doneHoldMs } }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, task: null, live, activeCount: 0 }))
      }
    },
  }))

  ctx.effect(() => () => {
    clearInterval(sweepTimer)
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}
