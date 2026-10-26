# Changelog

All notable changes to this project will be documented in this file.

## [0.4.1] - 2026-10-26

### Changed
- **npm 关键词补 `dsh-plugin`**：社区插件市场索引（如 dsh-plugin-market）靠 `keywords:dsh-plugin` 自动发现新包，之前缺这个关键词导致装不到「发现」页里。同时去掉对搜索无价值的中文关键词。

## [0.4.0] - 2026-10-25

### Changed
- **ETA 算法重做**：不再按消息字数猜总时长（实测估高 2–6 倍），改为按"已跑到第几步"查真实分位数。
- 三档优先级：待办完成度（`3/7 项`外推）> 本机在线学习 > 内置先验。
- 新增字段 `etaBasis`（todo/local/prior）、`etaP75Min`、`todoDone/todoTotal`，前端面板显示「3/7 项」。
- 已超判定改用 `min(P75, max(P50×1.8, P50+60s))`，短任务不会拖到 4 分钟才报超。

### Added
- **本机在线学习**：任务结束时把"第 N 步时还剩多久"记进 `$DSH_HOME/dsh-progress-stats.json`（上限 400 条、15 秒节流、原子写），攒够 20 条即替代内置先验。**纯本机，不联网。**

### Fixed
- 测试里写死了作者本机路径（`D:/workwork/...`），别人 clone 后跑不了 `npm test`；改用 `os.tmpdir()`。

## [0.3.0] - 2026-10-25

### Added
- **配置项**：`cordis.patch.yml` 可覆盖 `protocolHint / pollMs / doneHoldMs / doneKeepMs / maxTasks`（不写=默认，行为与 0.2.0 一致）。
- **协议注入开关**：`protocolHint: false` 可关掉每轮约 150 字的进度上报提醒，省 token。
- **本会话隐藏**：面板右上角 `×` 隐藏为 12px 淡点，点一下恢复（`–` 仍是常规收起）。
- **跟随皮肤**：颜色改为读宿主 CSS 变量，取不到才回落深色。

### Fixed
- 进度条每秒被 `innerHTML` 整块重建，CSS transition 被反复打断（现在结构不变时只更新数字与宽度）。
- 会话任务超过上限时淘汰"最早插入"的，长会话会被误删（改为淘汰"最久没活动"）。
- 进度文件被写到一半时任务条会整块消失（现在 2 秒内沿用上一次有效读数；文件被删仍立即消失）。
- 英文任务名匹配不到中文关键词表，会显示一长串原文（补了英文规则，并按单词边界截断）。

### Removed
- 删除残留的 `lib/index.js.bak-20261022`。

## [0.2.0] - 2026-10-22

### Changed
- 对外展示名定为 **鲸程**（Whale Run）；包名与仓库名保持 `dsh-progress-widget` / `task-progress-bar` 不变，避免打断已装用户。
- README 重写为面向新使用者的中文介绍：三种安装方式（npm / GitHub / 本地 link）、环境与版本要求、常见问题 FAQ、隐私说明、含子任务折叠的界面示意。
- `instructions-append.md` 更正为"已自动注入、无需手工抄"，只保留加强版可选规则。

### Added
- **子智能体任务显示（S2）**：识别子智能体会话（`header.delegationDepth > 0`）、记录父会话 id（`header.parentSession`，拿不到不硬猜），任务对象新增 `isSub` / `parentId`。
- 子任务命名走派发描述（`subagent/descriptor` 的 label），没有描述时用第一条任务正文清洗截断 24 字，不再套用 TITLE_MAP 归类名（此前多个子任务会全都叫"问题修复"，分不清）。
- 前端：标签栏默认只显示主任务；主任务行「子 N ▸」展开子任务列表（名字/已用/预计还需）；点子任务切换查看，详情带「↳ 子任务」标记与「↰ 返回父任务」；父子关联缺失时子任务单独成标签并标 `↳`；跟随最新时优先显示主任务。
- 测试：`test/subagent-tasks.test.mjs`（后端 14 项，隔离 DSH_HOME）、`test/client-subagent.test.mjs`（前端 18 项，mock DOM），`npm test` 一把跑完。

## [0.1.0] - 2026-09-02

### Added
- Task progress bar for DeepSeek Harness web (independent DOM floating widget, never touches dsh UI slots).
- **Fully event-driven task lifecycle**: task starts on your message, steps counted automatically, ends when the turn completes ("✅ 已结束" with elapsed time).
- Multi-session support: each conversation tracked independently; shows the most recently active task with an "N 个任务进行中" badge.
- Auto stage templates by task type (fix/develop/analyze/organize/plan/install...) with "~（自动估计）" marking when estimated.
- Smart task titles: keyword-mapped short names (问题修复 / 功能开发 / 问题分析 ...).
- Logical ETA estimation: message complexity × project baseline × live progress adjustment.
- Stale-task guard: agent-reported running tasks that stop updating expire automatically (triple-check: time × reported ETA × system activity) so a forgotten "done" never freezes the bar.
- Draggable (position remembered in localStorage), collapsible to a dot, idle state shows a small translucent dot.
- Per-turn protocol reminder injected into agent context (optional enhancement).
- README with full progress-file protocol for agent reporting.
