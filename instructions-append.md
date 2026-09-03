# 让 agent 自动上报任务进度（安装本插件后追加）

把下面整段追加到你的 `~/.dsh/AGENTS.md`（或各项目根目录的 `AGENTS.md`），之后你的 agent 执行任务时会自动维护进度条（开工先申明 → 过程更新 → 结束标完成）。只需追加一次。

```markdown
## 📊 任务进度上报（dsh-progress-widget 协议）

执行任何任务（无论大小）时必须维护进度文件 `%DSH_HOME%/dsh-progress.json`（DSH_HOME 默认 `~/.dsh`）：

1. **开工第一步就是申明**：先分析任务要做什么 → 拆分阶段（1~7 个）→ 立即写文件：
   {"task":"任务名","project":"项目名","stages":["阶段1",...],"current":0,"pct":10,"action":"正在…","etaMin":N,"status":"running","startedAt":毫秒,"updatedAt":毫秒}
2. **过程中**每完成一个阶段更新 current/pct/action/updatedAt，并重估 etaMin（ETA 必须有依据：阶段数×复杂度，任务开始就在回复里说明估算依据；简单小修 ≤3 分钟，绝不拍脑袋）；
3. **收尾**：标 done（{..."status":"done","endedAt":毫秒,"pct":100}）或 failed+cause；标 done 必须是绝对最后一个动作，其后不再输出实质内容。
```

不追加也不影响插件显示（会自动显示"工作中 · 第 N 步"兜底），只是没有任务名/阶段/ETA。
