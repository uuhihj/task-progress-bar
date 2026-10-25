// dsh-progress-widget host half v2.1: task lifecycle fully event-driven, multi-session.
// 每个会话（sessionId）独立跟踪任务：用户消息→turn/start 开任务；step 计数；空闲自动结束。
// 多会话并发时：进度条显示最近活跃任务 + activeCount（并发数）。
// agent 进度文件（dsh-progress.json）为可选增强层：有则显示阶段/动作/ETA，无则纯自动。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROGRESS_FILE = path.join(DSH_HOME, 'dsh-progress.json')
const BASELINE_FILE = path.join(DSH_HOME, 'dsh-progress-baselines.json')
const DONE_KEEP_MS = 2 * 60 * 1000
const IDLE_END_MS = 10 * 60 * 1000 // 兜底：turn 打开但 10 分钟无活动视为卡死结束
const FILE_STALE_MS = 2 * 60 * 1000 // agent 上报任务 2 分钟未更新视为残留失效
const SWEEP_MS = 4000

// 上次成功解析的进度文件读数：文件正在被写入（半截 JSON）时用它顶 2 秒，
// 避免任务条因为一次坏读数突然整块消失。
let lastGoodTask = null
let lastGoodAt = 0
const BAD_READ_GRACE_MS = 2000
function readTask() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.task === 'string' && Array.isArray(parsed.stages)) {
      lastGoodTask = parsed
      lastGoodAt = Date.now()
      return parsed
    }
  } catch (err) {
    // 只在"文件存在但读坏了"时兜底；文件被删掉要立刻消失（与旧行为一致）
    if (err && err.code !== 'ENOENT' && lastGoodTask && Date.now() - lastGoodAt < BAD_READ_GRACE_MS) return lastGoodTask
  }
  return null
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
    return '执行任务时维护任务进度文件 $DSH_HOME/dsh-progress.json：开工第一步写 {"task":"总结性任务名","session":"' + String(sid || '') + '","stages":["阶段1",...],"current":0,"pct":10,"action":"正在…","etaMin":N,"status":"running","startedAt":毫秒,"updatedAt":毫秒}；session 必须原样填当前会话 id（插件据此把上报任务与本会话任务合并为一条，避免同一任务显示两条）；每完成一个阶段更新 current/pct/action/etaMin/updatedAt；任务真正结束才标 {"status":"done","pct":100,"endedAt":毫秒} 且这是最后一个动作。ETA 按阶段数×复杂度推算并在回复中说明依据，简单任务≤3分钟。'
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
      t = { active: false, open: false, title: '', project: '', startedAt: 0, steps: 0, lastActivityAt: 0, sid, isSub: false, parentId: '', subLabel: '', subTitled: false }
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
        if (task.active) { task.steps++; task.lastActivityAt = Date.now() }
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
    const totalEtaMin = estimateEta(t.title, t.project) // 总估算（分钟）
    // 自动阶段模板（方案 C）：按关键词猜阶段，步数推进（每 3 步进一阶段）
    const stages = guessStages(t.title)
    const total = Math.max(1, stages.length)
    const current = Math.min(total - 1, Math.floor(t.steps / 3))
    const stagePct = Math.min(100, Math.round(((t.steps % 3) / 3) * 100))
    // 剩余倒计时：取"时间倒计时"与"按进度重估"的较小值 → 随时间连续递减；为负=已超预估
    const progress = Math.min(0.99, (current + stagePct / 100) / total)
    const byTimeMin = totalEtaMin - elapsedMs / 60000
    const byProgressMin = totalEtaMin * (1 - progress)
    const remainMin = Math.min(byTimeMin, byProgressMin)
    return {
      id: t.sid || '',
      isSub: !!t.isSub,
      parentId: t.parentId || '',
      task: t.title,
      project: t.project,
      stages, current, pct: stagePct,
      action: '', etaMin: Math.max(0, Math.round(remainMin)), status: 'running', steps: t.steps, auto: true,
      autoStage: true,
      startedAt: t.startedAt, updatedAt: t.lastActivityAt,
      etaAnchorAt: nowMs, etaAnchorMin: remainMin, etaTotalMin: totalEtaMin,
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
    const fileTask = readTask()
    if (fileTask && fileTask.status === 'running') {
      const fileAge = nowMs - Number(fileTask.updatedAt || 0)
      const eta = Number(fileTask.etaMin) || 0
      const staleLine = Math.max(FILE_STALE_MS, eta * 60000 * 1.5)
      if (fileAge <= staleLine || activeCount() > 0) {
        const anchored = eta > 0 ? { etaAnchorAt: Number(fileTask.updatedAt) || nowMs, etaAnchorMin: eta } : {}
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
            auto: false,
            autoStage: false,
            updatedAt: Math.max(Number(owner.updatedAt) || 0, Number(fileTask.updatedAt) || 0),
            startedAt: Number(owner.startedAt) || Number(fileTask.startedAt) || nowMs,
            ...anchored,
          }
        } else {
          // 没声明 session 或该会话已不活跃：保留独立条目（不猜测归属）
          out.push({ ...fileTask, id: 'file', auto: false, steps: 0, activeCount: activeCount(), ...anchored })
        }
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
