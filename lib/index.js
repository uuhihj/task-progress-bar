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

function readTask() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.task === 'string' && Array.isArray(parsed.stages)) {
      return parsed
    }
  } catch (err) {}
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
  if (t.length > 20) t = t.slice(0, 20) + '…'
  return t
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

export function apply(ctx) {
  const disposers = []
  const live = { status: 'idle', steps: 0, startAt: 0, lastActivityAt: 0 }
  const taskMap = new Map()
  const userTextMap = new Map()
  let doneList = []

  // —— 每轮注入提醒（方案 C）：让 agent 知道进度上报协议（参考 dsh-prompt-injector 安全模式）——
  const PROTOCOL_TEXT =
    '执行任务时维护任务进度文件 $DSH_HOME/dsh-progress.json：开工第一步写 {"task":"总结性任务名","stages":["阶段1",...],"current":0,"pct":10,"action":"正在…","etaMin":N,"status":"running","startedAt":毫秒,"updatedAt":毫秒}；每完成一个阶段更新 current/pct/action/etaMin/updatedAt；任务真正结束才标 {"status":"done","pct":100,"endedAt":毫秒} 且这是最后一个动作。ETA 按阶段数×复杂度推算并在回复中说明依据，简单任务≤3分钟。'
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
          if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
          const freshUser = ((payload && payload.messages) || []).find((m) => m && m.source && m.source.kind === 'user')
          if (!freshUser) return decision
          decision.messages.push({
            id: 'dpg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text: PROTOCOL_TEXT }],
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

  function taskOf(sid) {
    let t = taskMap.get(sid)
    if (!t) {
      t = { active: false, open: false, title: '', project: '', startedAt: 0, steps: 0, lastActivityAt: 0 }
      taskMap.set(sid, t)
    }
    return t
  }
  function endTask(sid) {
    const t = taskMap.get(sid)
    if (!t || !t.active) return
    t.active = false
    const ended = Date.now()
    doneList.push({ title: t.title, project: t.project, startedAt: t.startedAt, endedAt: ended, at: ended })
    doneList = doneList.filter((d) => ended - d.at < DONE_KEEP_MS)
    if (taskMap.size > 64) {
      const oldest = taskMap.keys().next().value
      if (oldest) taskMap.delete(oldest)
    }
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const sid = (session && session.id) ? String(session.id) : 'default'
      const type = event.type
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
              task.title = summarizeTitle(t)
              task.lastActivityAt = Date.now()
            }
          }
        }
        return
      }
      if (type === 'turn/start') {
        const task = taskOf(sid)
        const pendingText = userTextMap.get(sid) || ''
        task.open = true
        if (!task.active) {
          // 立即开任务（标题先用 pending 文本或"处理中"，稍后由 user/message 回填）
          task.active = true
          task.startedAt = Date.now()
          task.steps = 0
          task.lastActivityAt = Date.now()
          task.title = pendingText ? summarizeTitle(pendingText) : '处理中'
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

  function buildTask() {
    // 增强层优先：agent 上报的 running 任务（含阶段/动作/ETA）。
    // 过期判定三重防误杀：①超过 max(2分钟, 上报ETA×1.5) 未更新 ②且系统无任何活跃任务 ③才失效回退自动层。
    // 长步骤（agent 正在等命令）时该会话 turn 仍打开 → 系统活跃 → 绝不失效。
    const nowMs = Date.now()
    const fileTask = readTask()
    if (fileTask && fileTask.status === 'running') {
      const fileAge = nowMs - Number(fileTask.updatedAt || 0)
      const eta = Number(fileTask.etaMin) || 0
      const staleLine = Math.max(FILE_STALE_MS, eta * 60000 * 1.5)
      if (fileAge <= staleLine || activeCount() > 0) {
        const active = latestActiveTask()
        // 秒级倒计时锚点：agent 每次写文件（updatedAt）即重新锚定"此刻还剩多久"（协议语义：etaMin=当前剩余）。
        // etaMin<=0 时不下发锚点，前端退回"<1 分钟"显示。
        const anchored = eta > 0 ? { etaAnchorAt: Number(fileTask.updatedAt) || nowMs, etaAnchorMin: eta } : {}
        return {
          ...fileTask, auto: false, steps: active ? active.steps : 0, activeCount: activeCount(),
          ...anchored,
        }
      }
    }
    // 自动层：最近活跃任务
    const active = latestActiveTask()
    if (active) {
      const elapsedMs = nowMs - active.startedAt
      const totalEtaMin = estimateEta(active.title, active.project) // 总估算（分钟）
      // 自动阶段模板（方案 C）：按关键词猜阶段，步数推进（每 3 步进一阶段）
      const stages = guessStages(active.title)
      const total = Math.max(1, stages.length)
      const current = Math.min(total - 1, Math.floor(active.steps / 3))
      const stagePct = Math.min(100, Math.round(((active.steps % 3) / 3) * 100))
      // 剩余倒计时（取代旧的"只增不减"）：取"时间倒计时"与"按进度重估"的较小值 → 随时间连续递减；
      // 允许为负 = 已超预估，由前端显示"已超预估 X"。
      const progress = Math.min(0.99, (current + stagePct / 100) / total)
      const byTimeMin = totalEtaMin - elapsedMs / 60000
      const byProgressMin = totalEtaMin * (1 - progress)
      const remainMin = Math.min(byTimeMin, byProgressMin)
      return {
        task: active.title,
        project: active.project,
        stages, current, pct: stagePct,
        action: '', etaMin: Math.max(0, Math.round(remainMin)), status: 'running', steps: active.steps, auto: true,
        autoStage: true,
        startedAt: active.startedAt, updatedAt: active.lastActivityAt,
        etaAnchorAt: nowMs, etaAnchorMin: remainMin, etaTotalMin: totalEtaMin,
        activeCount: activeCount(),
      }
    }
    // 最近完成的任务（2 分钟内）
    if (doneList.length) {
      const d = doneList[doneList.length - 1]
      if (Date.now() - d.at < DONE_KEEP_MS) {
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

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-progress/status',
    handler: (req, res) => {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, task: buildTask(), live, activeCount: activeCount() }))
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
