# 关于"让 agent 上报进度"——现在不用手工抄了

**以前**：装完插件要你自己把一段协议抄进 `~/.dsh/AGENTS.md`，agent 才知道维护进度文件。

**现在（v0.2.0 起）**：插件每轮对话自动注入这段协议提醒（约 150 字），你什么都不用配。

所以本文件不再是指南，只留两个用途：

1. **想让它更严格**（比如每个任务都必须写阶段，而不是只在多步任务时写）：把下面加强版追加到 `~/.dsh/AGENTS.md`，覆盖默认提醒。
2. **想关掉默认提醒**（省那点上下文）：目前没有开关，需要改 `lib/index.js` 里 `protocolText` 的注入逻辑——改代码前先备份。

## 加强版规则（可选，追加到 AGENTS.md）

```markdown
## 📊 任务进度上报（鲸程 / dsh-progress-widget 协议）

执行任何任务（无论大小）时必须维护进度文件 `%DSH_HOME%/dsh-progress.json`（默认 `~/.dsh`）：

1. **开工第一步就申明**：先拆阶段（1~7 个）→ 立刻写 `{"task":"任务名","session":"当前会话 id","project":"项目名","stages":[...],"current":0,"pct":10,"action":"正在…","etaMin":N,"status":"running","startedAt":毫秒,"updatedAt":毫秒}`；
2. **过程中**每完成一个阶段更新 `current/pct/action/updatedAt`，重估 `etaMin`（ETA 必须有依据：阶段数×复杂度，简单小修 ≤3 分钟，不许拍脑袋）；
3. **收尾**标 `done`（`{"status":"done","pct":100,"endedAt":毫秒}`）或 `failed`+`cause`；标 done 必须是最后一个动作。

注意：进度文件是全局单文件。若里面正有**别的会话**的 running 任务（`updatedAt` 还在变），别覆盖它——你的任务由自动层承载显示。
```
