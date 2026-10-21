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

    function renderTask(t) {
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
      if (t.project) h.push('<span class="dpg-proj">' + esc(t.project) + '</span>')
      if (t.activeCount && t.activeCount > 1) h.push('<span class="dpg-proj dpg-multi">' + t.activeCount + ' 个任务进行中</span>')
      h.push('<span class="dpg-right"><button class="dpg-btn" title="收起">–</button></span>')
      h.push('</div>')
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
        var etaTxt
        if (t.etaAnchorAt && isFinite(Number(t.etaAnchorMin))) {
          // 秒级倒计时：锚点剩余 − 锚点以来经过的时间；为负 = 已超预估（橙色，数字继续走）
          var remainMs = Number(t.etaAnchorMin) * 60000 - (Date.now() - Number(t.etaAnchorAt))
          etaTxt = remainMs > 0
            ? ' · 预计还需 ' + fmtDur(remainMs)
            : ' · <span style="color:#f59e0b">已超预估 ' + fmtDur(-remainMs) + '</span>'
        } else {
          etaTxt = ' · 预计还需 ' + fmtEta(t.etaMin)
        }
        h.push('<span class="dpg-meta">' + elapsedTxt + etaTxt + '</span>')
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
      var t = lastTask && !taskStale(lastTask) ? lastTask : null
      if (!t) return null
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

    function fetchStatus() {
      fetch('/dsh-progress/status', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (!d || !d.ok) return
          lastTask = d.task
          lastLive = d.live
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
      } catch (err) {}
      var style = document.createElement('style')
      style.textContent = [
        '#dsh-progress-widget{position:fixed;left:50%;transform:translateX(-50%);bottom:110px;z-index:2147482990;min-width:280px;max-width:56vw;background:rgba(20,22,28,.88);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px 12px;color:#e8e8e8;font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);cursor:grab}',
        '#dsh-progress-widget:active{cursor:grabbing}',
        '#dsh-progress-widget.dpg-collapsed{min-width:0;padding:6px;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center}',
        '#dsh-progress-widget.dpg-idle{min-width:0;padding:5px;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;background:rgba(20,22,28,.35);border-color:rgba(255,255,255,.15);box-shadow:none;cursor:pointer}',
        '#dsh-progress-widget.dpg-idle:hover{background:rgba(20,22,28,.7)}',
        '.dpg-idle-dot{width:6px;height:6px;border-radius:50%;background:#64748b;opacity:.7}',
        '.dpg-row1{display:flex;align-items:center;gap:8px}',
        '.dpg-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}',
        '.dpg-pulse{animation:dpg-blink 1.2s ease infinite}',
        '@keyframes dpg-blink{50%{opacity:.35}}',
        '.dpg-task{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}',
        '.dpg-proj{color:#64748b;font-size:11px;white-space:nowrap;background:rgba(255,255,255,.08);border-radius:4px;padding:1px 6px}',
        '.dpg-multi{color:#f7d9a0;background:rgba(230,162,60,.18);border:1px solid rgba(230,162,60,.4)}',
        '.dpg-right{margin-left:auto;display:flex;gap:6px}',
        '.dpg-btn{border:none;background:rgba(255,255,255,.1);color:#e8e8e8;border-radius:5px;width:18px;height:18px;line-height:16px;text-align:center;cursor:pointer;padding:0;font-size:12px}',
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
        '.dpg-collapsed-label{position:absolute;font-size:11px;font-weight:800;color:#fff}',
      ].join('\n')
      ;(document.head || document.documentElement).appendChild(style)

      el = document.createElement('div')
      el.id = 'dsh-progress-widget'
      el.style.display = 'none'
      ;(document.body || document.documentElement).appendChild(el)
      // 恢复上次拖到的位置（没有则用默认底部居中）
      restorePos()

      el.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.className === 'dpg-btn') return
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
        if (!drag.moved && dx * dx + dy * dy > 25) drag.moved = true
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
        // 无论拖没拖，都吞掉随后的 click（防止双击换状态）；点击由这里直接处理
        suppressClick = true
        setTimeout(function () { suppressClick = false }, 0)
        if (!wasMoved) {
          toggle()
        } else {
          savePos()
        }
      })
      el.addEventListener('click', function (e) {
        if (suppressClick) { suppressClick = false; return }
        if (e.target && e.target.className === 'dpg-btn') {
          toggle()
        }
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
