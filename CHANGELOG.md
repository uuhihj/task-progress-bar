# Changelog

All notable changes to this project will be documented in this file.

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
