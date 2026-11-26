# R F-01 复审（goal pill 运行动画）

状态: pass

## 判定

修复成立、可放行：运行位从「图标内 useAgent 旁路读」改为「agents.list 目录 push 的 status → goalRunningStep hold 状态机 → present 写 store.running → registration.update({icon}) 换模块级稳定图标」，pill 图标与 popover 鲸鱼读同一 store 字段，换环通道与 team pill 同构；工作区实测门禁全绿。

## 独立验证

- `cd paseo-plugin && npx tsc --noEmit` → exit 0。
- `node harness/goal-pill-check.cjs`（按 header 先 `tsc -p harness/goal-pill.tsconfig.json` 到仓内 gitignored `.dbg-f01-review`）→ `323/323 checks passed / OK`，exit 0。
- `HOST_APP=/home/yywl/apps/paseo node harness/goal-popover-render-check.cjs` → `269/269 checks passed / OK`，exit 0（host app 0.16.0-beta.2 提供 react/esbuild/jsdom，与已装 daemon 无关）。
- `node --check` 两 harness → 均 OK。
- 数据流独立核对（`goal-pill.tsx:657-675,466-475,497-511`）：目录 upsert status → goalRunningStep → store.running → mark 纳入去重 → `update({visible,label,title,icon:goalPillIcon(mark)})`；`registration.update` 契约含 icon，宿主 merge 后 replace 重发（`plugins/buttons/model.ts:120-133`）；hold 定时器在 removeAgent/cleanup 清理（`:684-688,:788-789`），到期重绘后 mark=false 不再排定时器（`:521-544`），无 4s 轮询叠加/无限重绘。
- 删除 useAgent：全仓 goal 侧无 `useAgent`/`makeGoalIcon`/`useGoalRunningMark` 代码引用（只剩注释/F-01 报告文字）；`goalPillIcon` 5 个 mark 覆盖旧 tone×running 全部视觉态（running 仅 active+armed→tone normal），`goal-polling.ts:131-133,557-563` 真值表未变。
- 宿主数据源源码核对（本机 0.17.4，`/home/yywl/apps/paseo-sync-0174`）：自主回合置 `lifecycle=running`+emitState（agent-manager.ts:5826-5827）、回合结束置 idle/error+emitState（`:3597-3631`）→ agent_state（session.ts:2220-2233）→ agent_update upsert（agent-updates-service.ts:274,333-343；status=lifecycle，agent-projections.ts:148）→ 插件目录订阅 upsert 带 status。数据源成立。
- 变异 3 处（仓内 gitignored 隔离副本 `.dbg-f01-mut`，工作区源码零改动；前后 6 文件 sha256 与基线一致）：A 恢复旧行为「updateAgent 忽略 status」→ 渲染 266/269（status-only 换环 3 红）+ goal-pill 322/323（status-only re-present 钉红）；B `update` 去掉 icon → 267/269 + 322/323（换图标钉红）；C running→idle 不开 hold → 266/269（hold/不重复 update 3 红）。

## 问题

| 级别 | 位置 | 问题 | 证据 |
|---|---|---|---|
| P3 | `client/goal-running.tsx:54-102`；`harness/goal-pill.tsconfig.json` | 新 hold 状态机无直接行为断言：goal-pill-check 只用源码正则钉调用点，渲染检查只覆盖 running→idle 开 hold、idle→running 清除；hold 到期重绘（`goal-pill.tsx:537-543`）、removeAgent/cleanup 清定时器（`:684-688/:788-789`）、error/undefined 折叠未覆盖，此类回归可三门禁全绿漏过。建议把 goal-running.tsx 加进 tsconfig files 并补 4-5 条纯函数断言。 | 两 harness 均未 require `./client/goal-running.js`；变 C 只证明间接路径可红。 |
| P3 | `docs/GOAL.md:133` | 新增「宿主在每回合——含后台 goal 轮次——都会推」是宿主行为断言，未标宿主版本+file:line（AGENTS.md 要求）；内容与 0.17.4 源码一致，建议补版本/行号或移入未验证。 | 需 `agent-manager.ts:5826-5827` 等源码行才能支撑，文档未给。 |

## 未验证项

1. 真机：本机 daemon 未运行（`paseo daemon status` pid null），未能实测「不打开 popover 时 pill 连续转环 / pause 即停 / 重开 disarmed 不转」；宿主推 running 帧为 0.17.4 源码链结论，置信高、未观测。验证：起 daemon 后新会话建 goal，观察 pill 角环与 `agent_update` 日志。
2. 换图标后的动画首帧/不重启：离线 jsdom 只断言 icon 值与 update 次数，未跑 WAAPI 动画（`status-ring.tsx` useLayoutEffect 启动，与 team pill 同路径，置信中）。
3. 未跑全量 `offline-checks.cjs`（任务书要求 Lead 并行跑）；`pill-contribution-check` 等相邻门禁未单独复跑。
4. `docs/HARNESS.md:1381,1407` 计数已同步 323/269，与实测一致（该文件在任务书 6 文件之外另有改动，已核对数字正确）。
