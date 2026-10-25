// dsh-progress-widget client half: task progress bar.
// Independent DOM like dsh-sysmon — never touches dsh UI slots, cannot break the page.
window.__ModuleLoader__.load({
  id: 'dsh-progress-widget',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var POLL_MS = 1000
    var DONE_HOLD_MS = 30000
    var STALE_RUNNING_MS = 30 * 60 * 1000

    var el = null
    var collapsed = false
    var idleExpanded = false
    var drag = null
    var suppressClick = false
    var lastTask = null
    var lastLive = null
    var doneAt = 0
    var consumedKey = ''
    var timer = null
    var lastTasks = []
    var pinnedId = ''
    var lastCollapseAt = 0
    var subExpanded = false
    var hidden = false      // 本会话彻底隐藏（只留一个几乎看不见的小点，点它恢复）
    var lastSig = ''        // 上次渲染的结构签名：签名不变时只更新数字，不重建 DOM

    function taskKey(t) {
      return (t.task || '') + '@' + (t.updatedAt || 0) + '@' + (t.status || '')
    }

    function fmtDur(ms) {
      if (!ms || ms < 0) return '--'
      var s = Math.floor(ms / 1000)
      if (s < 60) return s + ' 秒'
      var m = Math.floor(s / 60)
      if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
      var h = Math.floor(m / 60)
      return h + ' 时 ' + (m % 60) + ' 分'
    }
    function fmtEta(etaMin) {
      if (etaMin == null || !isFinite(Number(etaMin))) return '--'
      var n = Number(etaMin)
      if (n < 1) return '<1 分钟'
      if (n < 60) return '约 ' + Math.round(n) + ' 分钟'
      return '约 ' + (n / 60).toFixed(1) + ' 小时'
    }
    // 剩余时间文案（秒级倒计时；为负显示"已超预估"，橙色）
    function etaText(t) {
      if (t.etaAnchorAt && isFinite(Number(t.etaAnchorMin))) {
        var remainMs = Number(t.etaAnchorMin) * 60000 - (Date.now() - Number(t.etaAnchorAt))
        if (remainMs > 0) return '预计还需 ' + fmtDur(remainMs)
        return '<span style="color:#f59e0b">已超预估 ' + fmtDur(-remainMs) + '</span>'
      }
      return '预计还需 ' + fmtEta(t.etaMin)
    }
    // 向上找带指定 class 的祖先（兼容 mock 无 closest 的环境）
    function closestOf(node, cls) {
      try {
        var n = node
        var want = String(cls).replace(/^\./, '')
        while (n) {
          if (n.className && String(n.className).split(/\s+/).indexOf(want) >= 0) return n
          if (typeof n.closest === 'function') { var r = n.closest(cls); if (r) return r }
          n = n.parentNode
        }
      } catch (err) {}
      return null
    }
    // 从点击目标往上找 data-task-id（'' = 跟随最新；null = 不是列表行）
    function itemIdFromEvent(e) {
      var node = e && e.target
      while (node) {
        if (typeof node.getAttribute === 'function') {
          var v = node.getAttribute('data-task-id')
          if (v !== null && v !== undefined) return v
        }
        node = node.parentNode
      }
      return null
    }
    function indexOfTask(id) {
      for (var i = 0; i < lastTasks.length; i++) if (lastTasks[i] && lastTasks[i].id === id) return i
      return -1
    }
    // 主任务 = 用户自己布置的任务；子智能体派出的会话（isSub）默认不占标签，保持简洁
    function mainTasks() {
      var out = []
      for (var i = 0; i < lastTasks.length; i++) if (lastTasks[i] && lastTasks[i].isSub !== true) out.push(lastTasks[i])
      return out
    }
    function subTasksOf(t) {
      var out = []
      if (!t || !t.id) return out
      for (var i = 0; i < lastTasks.length; i++) {
        var x = lastTasks[i]
        if (x && x.isSub === true && x.parentId === t.id) out.push(x)
      }
      return out
    }
    // 父子关联拿不到（父任务已结束/不在列表里）的子任务：单独成标签并标"↳ 子"（不猜测归属）
    function isOrphanSub(t) {
      return !!t && t.isSub === true && !(t.parentId && indexOfTask(t.parentId) >= 0)
    }
    function remainPlain(t) {
      if (!t) return '--'
      if (t.etaAnchorAt && isFinite(Number(t.etaAnchorMin))) {
        var ms = Number(t.etaAnchorMin) * 60000 - (Date.now() - Number(t.etaAnchorAt))
        if (ms > 0) return fmtDur(ms)
        return '超 ' + fmtDur(-ms)
      }
      if (t.etaMin != null && isFinite(Number(t.etaMin))) return fmtEta(t.etaMin)
      return '--'
    }
    function visibleTabs(cur) {
      var list = mainTasks()
      for (var i = 0; i < lastTasks.length; i++) if (isOrphanSub(lastTasks[i])) list.push(lastTasks[i])
      // 正在查看的子任务也占一个标签，用户一眼知道自己停在哪
      if (cur && cur.isSub === true && list.indexOf(cur) < 0) list.push(cur)
      return list
    }
    function savePin() {
      try { localStorage.setItem('dsh-progress-pinned', pinnedId) } catch (err) {}
    }
    function setPinned(id) {
      pinnedId = String(id == null ? '' : id)
      savePin()
      render()
    }
    // 跟随宿主皮肤：优先读 dsh 的 CSS 变量，取不到就退回原来的深色
    function palette() {
      var p = { bg: 'rgba(20,22,28,.88)', ink: '#e8e8e8', dim: '#94a3b8', line: 'rgba(255,255,255,.12)' }
      try {
        var cs = getComputedStyle(document.documentElement)
        var g = function (n) { var v = (cs.getPropertyValue(n) || '').trim(); return v || '' }
        p.bg = g('--dsw-alias-bg-layer-3') || p.bg
        p.ink = g('--dsw-alias-label-primary') || p.ink
        p.dim = g('--dsw-alias-label-secondary') || p.dim
        p.line = g('--dsw-alias-border-l2') || p.line
      } catch (err) {}
      return p
    }
    function setHidden(v) {
      hidden = !!v
      try { localStorage.setItem('dsh-progress-hidden', hidden ? '1' : '0') } catch (err) {}
      render()
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }
    function taskStale(t) {
      if (!t) return true
      var now = Date.now()
      var upd = Number(t.updatedAt) || 0
      if (t.status === 'running' && now - upd > STALE_RUNNING_MS) return true
      return false
    }
    function liveActive() {
      var l = lastLive
      if (!l) return false
      // idle 立即判为不活跃（回复完成即隐藏）；running 但 10 秒无活动视为卡住隐藏
      if (l.status === 'idle') return false
      if (l.status === 'running') {
        if (l.lastActivityAt && Date.now() - Number(l.lastActivityAt) > 10000) return false
        return true
      }
      return false
    }
    function statusColor(s) {
      if (s === 'done') return '#22c55e'
      if (s === 'failed') return '#ef4444'
      if (s === 'cancelled') return '#9ca3af'
      return '#4f8cff'
    }
    function statusLabel(s) {
      if (s === 'done') return '✅ 已结束'
      if (s === 'failed') return '❌ 失败'
      if (s === 'cancelled') return '⏹ 已取消'
      return ''
    }

    // 结构签名：任务切换/标签变化/展开状态变化才重建，其余只改数字
    function renderSig(t) {
      var tabs = visibleTabs(t).map(function (x) { return (x && x.id ? x.id : '') + ':' + (x && x.isSub ? 1 : 0) }).join(',')
      var kids = subTasksOf(t).map(function (x) { return x && x.id ? x.id : '' }).join(',')
      var stages = t.stages || []
      return [t.id, t.status, t.isSub ? 1 : 0, subExpanded ? 1 : 0, pinnedId, tabs, kids, stages.length, t.autoStage ? 1 : 0, t.action ? 1 : 0, collapsed ? 1 : 0].join('|')
    }
    // 签名不变时：只更新百分比 / 进度条宽度 / 已用与预计 —— 避免 innerHTML 重建打断 CSS 动画
    function patchTaskDom(t) {
      try {
        var q = function (sel) { return el.querySelector(sel) }
        var stages = t.stages || []
        var total = stages.length || 1
        var cur = Math.max(0, Math.min(total - 1, Number(t.current) || 0))
        var stagePct = Math.max(0, Math.min(100, Number(t.pct) || 0))
        if (t.auto && t.status === 'running' && stages.length) {
          var perStageMs = (Number(t.etaTotalMin) || 0) * 60000 / total
          if (perStageMs > 0) {
            var stageElapsed = (Date.now() - Number(t.startedAt || Date.now())) - cur * perStageMs
            stagePct = Math.max(stagePct, Math.max(0, Math.min(95, (stageElapsed / perStageMs) * 100)))
          }
        }
        var overall = t.status === 'done' ? 100
          : stages.length ? Math.min(95, Math.round(((cur + stagePct / 100) / total) * 100))
            : Math.max(0, Math.min(95, Number(t.pct) || 0))
        var pctEl = q('.dpg-pct')
        if (pctEl) pctEl.textContent = overall + '%'
        var fillEl = q('.dpg-fill')
        if (fillEl) fillEl.style.width = overall + '%'
        var metaEl = q('.dpg-meta')
        if (metaEl && t.status === 'running') {
          var startMs = Number(t.startedAt)
          var startTxt = ''
          if (startMs > 0) {
            var sd = new Date(startMs)
            startTxt = ' · 开始 ' + ('0' + sd.getHours()).slice(-2) + ':' + ('0' + sd.getMinutes()).slice(-2)
          }
          metaEl.innerHTML = '已用 ' + fmtDur(Date.now() - Number(t.startedAt || Date.now())) + ' · ' + etaText(t) + startTxt
        }
        return true
      } catch (err) {
        return false
      }
    }

    function renderTask(t) {
      var sig = renderSig(t)
      if (sig === lastSig && el && typeof el.querySelector === 'function') {
        var sig2 = el.getAttribute ? el.getAttribute('data-dpg-sig') : sig
        if (sig2 === sig && patchTaskDom(t)) return
      }
      lastSig = sig
      try { if (el && el.setAttribute) el.setAttribute('data-dpg-sig', sig) } catch (err) {}
      var stages = t.stages || []
      var hasStages = stages.length > 0
      var total = hasStages ? stages.length : 1
      var cur = Math.max(0, Math.min(total - 1, Number(t.current) || 0))
      var stagePct = Math.max(0, Math.min(100, Number(t.pct) || 0))
      // 空档期缓爬（仅自动层、仅进行中）：按时间在"当前阶段内"缓慢推进，封顶 95%，让进度条持续可见地变化；
      // 真实进度信号一到就以真实值为准（取 max，只往前不倒退）。
      if (t.auto && t.status === 'running' && hasStages) {
        var perStageMs = (Number(t.etaTotalMin) || 0) * 60000 / total
        if (perStageMs > 0) {
          var stageElapsedMs = (Date.now() - Number(t.startedAt || Date.now())) - cur * perStageMs
          var creepPct = Math.max(0, Math.min(95, (stageElapsedMs / perStageMs) * 100))
          stagePct = Math.max(stagePct, creepPct)
        }
      }
      var overall
      if (t.status === 'done') overall = 100
      else if (hasStages) overall = Math.min(95, Math.round(((cur + stagePct / 100) / total) * 100))
      else overall = Math.max(0, Math.min(95, Number(t.pct) || 0)) // 自动任务：后端给的时间比例
      var color = statusColor(t.status)
      var stageName = stages[cur] || ''
      var h = []
      h.push('<div class="dpg-row1">')
      h.push('<span class="dpg-dot" style="background:' + color + '"></span>')
      h.push('<span class="dpg-task">' + esc(t.task) + '</span>')
      if (t.isSub === true) h.push('<span class="dpg-subbadge">↳ 子任务</span>')
      if (t.project) h.push('<span class="dpg-proj">' + esc(t.project) + '</span>')
      var kids = subTasksOf(t)
      var btns = []
      if (t.isSub === true && t.parentId && indexOfTask(t.parentId) >= 0) btns.push('<button class="dpg-btn dpg-back" data-task-id="' + esc(t.parentId) + '" title="返回父任务">↰</button>')
      if (kids.length) btns.push('<button class="dpg-btn dpg-subtoggle" title="子任务 ' + kids.length + ' 个（点开看列表）">' + kids.length + (subExpanded ? '▾' : '▸') + '</button>')
      btns.push('<button class="dpg-btn dpg-hide" title="本会话隐藏进度条">×</button>')
      btns.push('<button class="dpg-btn" title="收起">–</button>')
      h.push('<span class="dpg-right">' + btns.join('') + '</span>')
      h.push('</div>')
      // 多任务标签页：直接点标签切换（比小角标更好点，防误触）；子任务默认折叠，不刷屏
      var tabs = visibleTabs(t)
      if (tabs.length > 1) {
        h.push('<div class="dpg-tabs">')
        for (var ti = 0; ti < tabs.length; ti++) {
          var tt = tabs[ti]
          var tsel = tt.id === t.id ? ' dpg-tab-sel' : ''
          var pre = tt.isSub === true ? '↳ ' : (ti + 1) + '. '
          h.push('<span class="dpg-tab' + tsel + '" data-task-id="' + esc(tt.id) + '" title="' + esc(tt.task) + ' · 已用 ' + fmtDur(Date.now() - Number(tt.startedAt || Date.now())) + '">' + pre + esc(tt.task) + (pinnedId && tt.id === pinnedId ? ' 🔒' : '') + '</span>')
        }
        if (pinnedId) h.push('<span class="dpg-follow" data-task-id="">跟随最新</span>')
        h.push('</div>')
      }
      // 子任务列表：点"子 N"才展开，每条可点进去看详情
      if (subExpanded && kids.length) {
        h.push('<div class="dpg-sublist">')
        for (var ki = 0; ki < kids.length; ki++) {
          var kt = kids[ki]
          h.push('<div class="dpg-subitem" data-task-id="' + esc(kt.id) + '">' +
            '<span class="dpg-subname">↳ ' + esc(kt.task) + '</span>' +
            '<span class="dpg-submeta">已用 ' + fmtDur(Date.now() - Number(kt.startedAt || Date.now())) + ' · 预计还需 ' + remainPlain(kt) + '</span></div>')
        }
        h.push('</div>')
      }
      if (t.status === 'running') {
        var stageLine
        if (hasStages) {
          stageLine = (t.autoStage ? '~' : '') + '阶段 ' + (cur + 1) + '/' + total + ' · ' + esc(stageName) + (t.autoStage ? '（自动估计）' : '')
        } else {
          stageLine = '实时跟踪' + (t.steps ? ' · 第 ' + t.steps + ' 步' : ' · 开始')
        }
        h.push('<div class="dpg-row2">')
        h.push('<span class="dpg-stage">' + stageLine + '</span>')
        h.push('<span class="dpg-pct">' + overall + '%</span>')
        h.push('</div>')
        h.push('<div class="dpg-bar"><div class="dpg-fill" style="width:' + overall + '%;background:' + color + '"></div></div>')
        h.push('<div class="dpg-row3">')
        if (t.action) h.push('<span class="dpg-action">⚙ ' + esc(t.action) + '</span>')
        var elapsedTxt = '已用 ' + fmtDur(Date.now() - Number(t.startedAt || Date.now()))
        var startTxt = ''
        var startMs = Number(t.startedAt)
        if (startMs > 0) {
          var sd = new Date(startMs)
          startTxt = ' · 开始 ' + ('0' + sd.getHours()).slice(-2) + ':' + ('0' + sd.getMinutes()).slice(-2)
        }
        h.push('<span class="dpg-meta">' + elapsedTxt + ' · ' + etaText(t) + startTxt + '</span>')
        h.push('</div>')
      } else {
        var endText = statusLabel(t.status)
        if (t.status === 'failed' && t.cause) endText += ' · ' + esc(t.cause)
        h.push('<div class="dpg-row2"><span class="dpg-done">' + endText + '</span><span class="dpg-meta">用时 ' + fmtDur(Number(t.endedAt || t.updatedAt || Date.now()) - Number(t.startedAt || t.updatedAt || Date.now())) + '</span></div>')
        h.push('<div class="dpg-bar"><div class="dpg-fill" style="width:' + overall + '%;background:' + color + '"></div></div>')
      }
      el.innerHTML = h.join('')
      el.className = 'dsh-progress-widget'
    }

    function renderLive() {
      var l = lastLive || {}
      var steps = l.steps || 0
      var parts = [steps > 0 ? '第 ' + steps + ' 步' : '思考中']
      if (l.startAt) parts.push('已用 ' + fmtDur(Date.now() - Number(l.startAt)))
      el.innerHTML =
        '<div class="dpg-row1">' +
        '<span class="dpg-dot dpg-pulse" style="background:#4f8cff"></span>' +
        '<span class="dpg-task">工作中</span>' +
        '<span class="dpg-right"><button class="dpg-btn" title="收起">–</button></span>' +
        '</div>' +
        '<div class="dpg-row3"><span class="dpg-action">' + parts.join(' · ') + ' · 任务阶段未声明</span></div>'
      el.className = 'dsh-progress-widget'
    }

    // 有效任务：running 直接有效；终态任务未消费显示 30 秒后消费（返回 null 则视为无任务）
    function effectiveTask() {
      // 手动锁定优先：锁定的任务若已结束（列表里没了）→ 解除锁定，回落到跟随最新
      if (pinnedId) {
        var pi = indexOfTask(pinnedId)
        if (pi >= 0) return lastTasks[pi]
        pinnedId = ''
        savePin()
      }
      var t = lastTask && !taskStale(lastTask) ? lastTask : null
      if (!t) return null
      // 跟随最新时优先显示主任务：子任务不抢父任务的位置（用户点开才看子任务）
      if (t.isSub === true) {
        var mains = mainTasks()
        var pick = null
        for (var mi = 0; mi < mains.length; mi++) {
          if (!pick || (Number(mains[mi].updatedAt) || 0) >= (Number(pick.updatedAt) || 0)) pick = mains[mi]
        }
        if (pick) t = pick
      }
      if (t.status === 'running') {
        doneAt = 0
        return t
      }
      var key = taskKey(t)
      if (consumedKey === key) return null
      if (doneAt === 0) {
        doneAt = Date.now()
        var k = key
        setTimeout(function () {
          if (doneAt && Date.now() - doneAt >= DONE_HOLD_MS) {
            doneAt = 0
            consumedKey = k
            // 持久化消费记忆：刷新页面/重开浏览器后旧 done 任务不再重现
            try { localStorage.setItem('dsh-progress-consumed', k) } catch (err) {}
            render()
          }
        }, DONE_HOLD_MS)
      }
      return t
    }

    function renderCollapsed(t, active) {
      var color = 'transparent'
      var label = ''
      if (t) {
        color = statusColor(t.status)
        if (t.status === 'running') {
          var total = (t.stages || []).length || 1
          var cur = Math.max(0, Math.min(total - 1, Number(t.current) || 0))
          label = (cur + 1) + '/' + total
        } else if (t.status === 'failed') {
          label = '!'
        } else if (t.status === 'done') {
          label = '✓'
        } else if (t.status === 'cancelled') {
          label = '×'
        }
      } else if (active) {
        color = '#4f8cff'
      }
      el.innerHTML =
        '<span class="dpg-dot" style="background:' + color + '"></span>' +
        (label ? '<span class="dpg-collapsed-label">' + label + '</span>' : '')
      el.className = 'dsh-progress-widget dpg-collapsed'
    }

    function render() {
      if (!el) return
      // 彻底隐藏：只留一个 12px 的淡点，点它恢复（不是死无对证）
      if (hidden) {
        el.style.display = ''
        el.className = 'dsh-progress-widget dpg-hidden'
        el.innerHTML = '<span class="dpg-idle-dot"></span>'
        return
      }
      var t = effectiveTask()
      var active = liveActive()
      // 无任务且不活跃 → 空闲形态（此时收起状态无效，只显示小灰点或说明面板）
      if (!t && !active) {
        el.style.display = ''
        if (idleExpanded) {
          el.className = 'dsh-progress-widget'
          el.innerHTML =
            '<div class="dpg-row1">' +
            '<span class="dpg-dot" style="background:#64748b"></span>' +
            '<span class="dpg-task">任务进度</span>' +
            '<span class="dpg-right"><button class="dpg-btn" title="收起">–</button></span>' +
            '</div>' +
            '<div class="dpg-row3"><span class="dpg-action">当前空闲 · 布置多步任务时自动显示进度</span></div>'
        } else {
          el.className = 'dsh-progress-widget dpg-idle'
          el.innerHTML = '<span class="dpg-idle-dot"></span>'
        }
        return
      }
      // 有内容（任务进行中 / 完成态 / 工作中）：收起圆点或完整展示
      el.style.display = ''
      if (collapsed) {
        renderCollapsed(t, active)
        return
      }
      if (t) {
        renderTask(t)
        return
      }
      renderLive()
    }

    function toggle() {
      var t = effectiveTask()
      var active = liveActive()
      if (!t && !active) {
        idleExpanded = !idleExpanded
        render()
        return
      }
      collapsed = !collapsed
      render()
    }

    function restartTimer() {
      if (timer) { try { clearInterval(timer) } catch (err) {} }
      timer = setInterval(fetchStatus, POLL_MS)
    }
    // 服务端下发的配置（cordis.patch.yml 里可改）优先于本地默认值
    function applyServerConfig(c) {
      if (!c || typeof c !== 'object') return
      var wantPoll = Number(c.pollMs)
      if (isFinite(wantPoll) && wantPoll >= 200 && wantPoll !== POLL_MS) { POLL_MS = wantPoll; restartTimer() }
      var wantHold = Number(c.doneHoldMs)
      if (isFinite(wantHold) && wantHold >= 1000) DONE_HOLD_MS = wantHold
    }
    function fetchStatus() {
      fetch('/dsh-progress/status', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (!d || !d.ok) return
          lastTask = d.task
          lastTasks = Array.isArray(d.tasks) ? d.tasks : []
          lastLive = d.live
          applyServerConfig(d.config)
          render()
        })
        .catch(function () {})
    }

    function savePos() {
      try {
        localStorage.setItem('dsh-progress-pos', JSON.stringify({ left: el.style.left, top: el.style.top }))
      } catch (err) {}
    }
    function restorePos() {
      try {
        var raw = localStorage.getItem('dsh-progress-pos')
        if (!raw) return false
        var pos = JSON.parse(raw)
        if (!pos || typeof pos.left !== 'string') return false
        var vw = window.innerWidth || document.documentElement.clientWidth || 1280
        var vh = window.innerHeight || document.documentElement.clientHeight || 800
        var l = parseInt(pos.left, 10) || 0
        var t = parseInt(pos.top, 10) || 0
        var w = el.offsetWidth || el.getBoundingClientRect().width || 280
        var h = el.offsetHeight || el.getBoundingClientRect().height || 40
        l = Math.max(0, Math.min(l, vw - w))
        t = Math.max(0, Math.min(t, vh - h))
        el.style.left = l + 'px'
        el.style.top = t + 'px'
        el.style.bottom = 'auto'
        el.style.transform = 'none'
        return true
      } catch (err) {
        return false
      }
    }

    function apply(ctx) {
      if (document.getElementById('dsh-progress-widget')) return
      // 恢复已消费的终态任务记忆：刷新后旧 done 任务不重现
      try {
        consumedKey = localStorage.getItem('dsh-progress-consumed') || ''
        pinnedId = localStorage.getItem('dsh-progress-pinned') || ''
        hidden = localStorage.getItem('dsh-progress-hidden') === '1'
      } catch (err) {}
      var style = document.createElement('style')
      style.textContent = [
        '#dsh-progress-widget{position:fixed;left:50%;transform:translateX(-50%);bottom:110px;z-index:2147482990;min-width:280px;max-width:56vw;background:var(--dpg-bg,rgba(20,22,28,.88));border:1px solid var(--dpg-line,rgba(255,255,255,.12));border-radius:10px;padding:8px 12px;color:var(--dpg-ink,#e8e8e8);font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);cursor:grab}',
        '#dsh-progress-widget:active{cursor:grabbing}',
        '#dsh-progress-widget.dpg-collapsed{min-width:0;padding:8px;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center}',
        '#dsh-progress-widget.dpg-idle{min-width:0;padding:5px;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;background:rgba(20,22,28,.35);border-color:rgba(255,255,255,.15);box-shadow:none;cursor:pointer}',
        '#dsh-progress-widget.dpg-idle:hover{background:rgba(20,22,28,.7)}',
        '.dpg-idle-dot{width:6px;height:6px;border-radius:50%;background:#64748b;opacity:.7}',
        '#dsh-progress-widget.dpg-hidden{min-width:0;width:12px;height:12px;padding:0;border-radius:50%;background:rgba(20,22,28,.45);border-color:rgba(255,255,255,.10);box-shadow:none;opacity:.5;cursor:pointer}',
        '#dsh-progress-widget.dpg-hidden:hover{opacity:1}',
        '.dpg-hide{font-size:12px;color:#94a3b8}',
        '.dpg-row1{display:flex;align-items:center;gap:8px}',
        '.dpg-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}',
        '.dpg-pulse{animation:dpg-blink 1.2s ease infinite}',
        '@keyframes dpg-blink{50%{opacity:.35}}',
        '.dpg-task{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}',
        '.dpg-proj{color:#64748b;font-size:11px;white-space:nowrap;background:rgba(255,255,255,.08);border-radius:4px;padding:1px 6px}',
        '.dpg-multi{color:#f7d9a0;background:rgba(230,162,60,.18);border:1px solid rgba(230,162,60,.4)}',
        '.dpg-tabs{display:flex;gap:6px;margin-top:6px;overflow-x:auto;padding-bottom:2px;cursor:default}',
        '.dpg-tab{flex:0 0 auto;min-height:32px;line-height:20px;padding:6px 12px;border-radius:6px;background:rgba(255,255,255,.08);font-size:13px;cursor:pointer;white-space:nowrap;max-width:46vw;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center}',
        '.dpg-tab:hover{background:rgba(255,255,255,.16)}',
        '.dpg-tab.dpg-tab-sel{background:rgba(79,140,255,.28);box-shadow:inset 0 0 0 1px rgba(79,140,255,.55)}',
        '.dpg-follow{flex:0 0 auto;min-height:28px;line-height:18px;padding:5px 10px;border-radius:6px;color:#94a3b8;font-size:12px;cursor:pointer;background:rgba(255,255,255,.05)}',
        '.dpg-right{margin-left:auto;display:flex;gap:6px}',
        '.dpg-btn{border:none;background:rgba(255,255,255,.1);color:#e8e8e8;border-radius:7px;width:26px;height:26px;line-height:24px;text-align:center;cursor:pointer;padding:0;font-size:14px}',
        '.dpg-btn:hover{background:rgba(255,255,255,.22)}',
        '.dpg-row2{display:flex;align-items:center;gap:8px;margin-top:4px}',
        '.dpg-stage{color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}',
        '.dpg-pct{font-weight:800;color:#fff}',
        '.dpg-bar{height:6px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:5px}',
        '.dpg-fill{height:100%;border-radius:3px;transition:width .6s ease}',
        '.dpg-row3{display:flex;gap:10px;margin-top:4px;color:#94a3b8;flex-wrap:wrap}',
        '.dpg-action{color:#94a3b8}',
        '.dpg-meta{margin-left:auto;color:#64748b;white-space:nowrap}',
        '.dpg-done{font-weight:700;color:#fff}',
        '.dpg-collapsed-label{position:absolute;font-size:12px;font-weight:800;color:#fff}',
        '.dpg-subbadge{color:#f7d9a0;background:rgba(230,162,60,.18);border:1px solid rgba(230,162,60,.4);border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap}',
        '.dpg-btn.dpg-subtoggle{width:auto;padding:0 7px;font-weight:700;color:#cbd5e1}',
        '.dpg-sublist{display:flex;flex-direction:column;gap:4px;margin-top:6px}',
        '.dpg-subitem{display:flex;align-items:center;gap:8px;min-height:30px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.06);cursor:pointer}',
        '.dpg-subitem:hover{background:rgba(255,255,255,.14)}',
        '.dpg-subname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dpg-submeta{color:#64748b;font-size:11px;white-space:nowrap}',
      ].join('\n')
      ;(document.head || document.documentElement).appendChild(style)

      el = document.createElement('div')
      el.id = 'dsh-progress-widget'
      el.style.display = 'none'
      // 皮肤变量（读不到就沿用旧深色，行为不变）
      try {
        var pal = palette()
        if (el.style && typeof el.style.setProperty === 'function') {
          el.style.setProperty('--dpg-bg', pal.bg)
          el.style.setProperty('--dpg-ink', pal.ink)
          el.style.setProperty('--dpg-dim', pal.dim)
          el.style.setProperty('--dpg-line', pal.line)
        }
      } catch (err) {}
      ;(document.body || document.documentElement).appendChild(el)
      // 恢复上次拖到的位置（没有则用默认底部居中）
      restorePos()

      el.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.className === 'dpg-btn') return
        // 任务标签/跟随按钮不是拖动区，点它们由 click 处理
        if (closestOf(e.target, '.dpg-tab') || closestOf(e.target, '.dpg-follow') || closestOf(e.target, '.dpg-subitem') || closestOf(e.target, '.dpg-subtoggle') || closestOf(e.target, '.dpg-back') || closestOf(e.target, '.dpg-hide')) return
        if (e.button !== 0) return
        // 收起/展开状态都可拖动；点击（位移小于阈值）在 pointerup 时直接切换展开收起
        var rect = el.getBoundingClientRect()
        drag = { x: e.clientX, y: e.clientY, l: rect.left, t: rect.top, moved: false }
        try { el.setPointerCapture(e.pointerId) } catch (err) {}
      })
      el.addEventListener('pointermove', function (e) {
        if (!drag) return
        var dx = e.clientX - drag.x
        var dy = e.clientY - drag.y
        if (!drag.moved && dx * dx + dy * dy > 64) drag.moved = true
        if (drag.moved) {
          el.style.left = Math.max(0, drag.l + dx) + 'px'
          el.style.top = Math.max(0, drag.t + dy) + 'px'
          el.style.bottom = 'auto'
          el.style.transform = 'none'
        }
      })
      el.addEventListener('pointerup', function () {
        if (!drag) return
        var wasMoved = drag.moved
        drag = null
        if (wasMoved) {
          // 拖动结束后吞掉随后的 click（避免拖完误触发）；普通点击则交给 click 事件
          suppressClick = true
          setTimeout(function () { suppressClick = false }, 0)
          savePos()
        }
      })
      el.addEventListener('click', function (e) {
        if (suppressClick) { suppressClick = false; return }
        // 隐藏态下点那一下小点 → 恢复显示
        if (hidden) { setHidden(false); return }
        // 明确的 × 按钮 → 本会话隐藏
        if (closestOf(e.target, '.dpg-hide')) { setHidden(true); return }
        // "子 N ▾" 只展开/收起子任务列表，不切换查看对象（防误触）
        if (closestOf(e.target, '.dpg-subtoggle')) { subExpanded = !subExpanded; render(); return }
        var itemId = itemIdFromEvent(e)
        if (itemId !== null) {
          // 点任务标签：切换并锁定；再点同项或"跟随最新"→ 解除锁定
          setPinned(itemId === '' || itemId === pinnedId ? '' : itemId)
          return
        }
        if (e.target && e.target.className === 'dpg-btn') {
          // 只有明确的收起按钮才收起（防误触）；250ms 内防连点
          if (Date.now() - lastCollapseAt > 250) { lastCollapseAt = Date.now(); toggle() }
          return
        }
        if (collapsed) { toggle(); return }                          // 收起的小圆点 → 展开
        if (!effectiveTask() && !liveActive()) { toggle(); return }   // 空闲小灰点 → 展开说明
        // 面板本体其它位置点击：不做任何事（点不精准也不会收起）
      })

      fetchStatus()
      timer = setInterval(fetchStatus, POLL_MS)
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            if (timer) clearInterval(timer)
            if (el && el.parentNode) el.parentNode.removeChild(el)
          }
        })
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
