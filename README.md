# task-progress-bar（dsh-progress-widget）

DeepSeek Harness（DSH）任务进度条插件：你发消息，网页底部**立刻显示任务**——阶段进度、百分比、当前动作、已用时间、预计剩余时间；任务结束自动告诉你"✅ 已结束"。

- 独立 DOM 悬浮窗，**不注入任何 dsh UI 槽位**，不会影响对话界面；
- 可拖动（位置记忆）、可收起为小圆点；空闲时半透明小灰点不打扰；
- **任务生命周期完全自动驱动**（不依赖 agent 自觉）：你发消息=任务开始、干活=步数实时计数、回复完成=立即"已结束"；
- 多窗口同时干活也互不干扰：各自独立跟踪，显示最近活跃任务 + "N 个任务进行中"角标。

## 安装

```bash
# 从 GitHub 安装（推荐，无需 npm）
dsh plugin --profile web add github:uuhihj/task-progress-bar

# 或 pin 版本
dsh plugin --profile web add github:uuhihj/task-progress-bar#v0.1.0

# 或从 DSH 插件市场（设置页 → 插件市场 → 搜索 task-progress-bar）一键安装
```

本地开发：`dsh plugin --profile web add link:<本仓库绝对路径>`，改代码重启 dsh 即生效。

安装后**重启 dsh web**，页面底部会出现进度条。

## 显示状态

| 情况 | 显示 |
|---|---|
| 你发消息 | 立即出现任务条（标题自动总结成短名：问题修复 / 功能开发 / 方案咨询…） |
| 任务进行中 | `~阶段 2/3 · 实施修复（自动估计）· 45% · 第 N 步 · 已用 X · 预计还需约 Y 分钟` |
| agent 上报了精确阶段 | 显示真实阶段（无 `~` 标注） |
| 任务完成 | 绿色"✅ 已结束 · 用时 X"→ 30 秒自动淡出 |
| 多任务并发 | 最近活跃任务 + 橙色角标"N 个任务进行中" |
| 完全空闲 | 半透明小灰点（点击可展开说明） |

## 工作原理

- **自动层（任务本身驱动，核心）**：任务生命周期由 dsh 事件流自动判定——开始=用户消息后的 `turn/start`、进行=`step/start` 计数、结束=`turn/end`（每轮回复完成立即结束）。自动阶段模板按任务类型套用（修复/开发/分析/整理/方案/安装…），带"自动估计"标注；标题用关键词映射成短名；ETA = 消息复杂度 × 项目基线 × 进展动态修正。
- **上报层（可选增强）**：agent 维护进度文件叠加语义（真实阶段名、精确百分比、更准 ETA、当前动作）。有上报显示真实阶段，无上报纯自动运行。
- **过期防误杀**：agent 上报的 running 任务超过 `max(2 分钟, 上报ETA×1.5)` 且系统无任何活跃任务时才判残留失效——长步骤任务绝不误杀，忘了标 done 也不会永久卡住。

## agent 上报协议（可选）

文件：`$DSH_HOME/dsh-progress.json`（DSH_HOME 默认 `~/.dsh`）

```json
{
  "task": "任务名",
  "project": "项目名（可选）",
  "stages": ["调研", "方案", "实现", "验证", "收尾"],
  "current": 2,
  "pct": 55,
  "action": "正在编辑 lib/index.js",
  "etaMin": 8,
  "status": "running",
  "startedAt": 1788300000000,
  "updatedAt": 1788300000000
}
```

| 字段 | 说明 |
|---|---|
| `task` | 任务名（建议总结性短名） |
| `project` | 项目名（可选，显示为徽章） |
| `stages` | 阶段列表（1~7 个） |
| `current` | 当前阶段索引（0 起） |
| `pct` | 当前阶段内进度 0~100 |
| `action` | 当前动作（人类可读） |
| `etaMin` | 预计剩余分钟（每阶段完成重新估算） |
| `status` | `running` / `done` / `failed` / `cancelled`（failed 可加 `cause`） |
| `startedAt` / `updatedAt` | 毫秒时间戳 |

agent 行为约定：开工第一步写 running；每阶段更新；任务真正结束标 `done`（最后一个动作）。

## 交互

- 按住拖动，位置自动记忆（localStorage），刷新不丢；
- 右上"–"收起为小圆点（显示阶段数/✓/!），点圆点展开；
- 点击与拖动自动区分（位移超过阈值才算拖动）。

## 接口

`GET /dsh-progress/status` → `{ ok, task, live, activeCount }`

## License

MIT
