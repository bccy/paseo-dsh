# P003 计划复核（2026-10-31）

裁决：目标成立，修正设计后执行全部 A 档五项；B 档只交付上游问题草稿。
基线为工作区（HEAD `2b3bb3c`，另有 jobs 未提交改动，保留），DSH 0.2.1-rc.5、Paseo 0.14.0。

1. **审批入口改正**：`dsh-user-approval` 的 `approval/asked`、`approval/decided` 是日志事实，
   交互入口是 `approval/request` waterfall。复用 DSH ACP 的归属过滤和 allow-once/reject 语义，
   不手工写审计事件。策略只有 `ask`/`never`，不存在计划所称 `always-allow`。
   用一次性 profile 和无副作用测试工具请求真实 approval，验证 ask/decided；无需执行危险操作。
   profile 当前拒绝审批不能作为从产品中删除审批支持的依据，never 必须保留自动拒绝。
2. **提示词作用域改正**：通过 create/resume 的 `setup(agentCtx, agent)` 和真实 agent scope 注册，
   无需自建 scope。保留返回的 disposer，关闭、失败与重新初始化清理。`interpolate:false` 保留
   用户文字中的 `{{...}}`，附加独立 section，不覆盖 profile 原有人设。
3. **历史漏项补齐**：`image-host-path.js` 的 `REPLAYED_EVENT_TYPES` 也必须加入 workflow/goal，
   否则实时可见、重开消失。goal 有 clear tombstone，不能只读 `data.goal`。
4. **状态语义**：workflow agent 用 seq 配对，阶段来自 agent-start.phase；stopReason 是
   completed/cancelled/error。goal.phase 与工具执行状态不是同一概念，active goal 不能在 turn/end
   被工具收尾逻辑改成 canceled。同一会话清除/再建目标更新同一状态行。
5. **投影**：controller.projections 返回 sequenced（含 asOfSeq）、migration-required 或 null，
   不可把缓存提示伪装为精确快照。保留原形，不复活 agent；显式 keys 对缺失键报错。
6. **范围表述纠正**：未渲染的内部事件不是 53 个缺陷；MCP gateway 已提供 Paseo 工具，
   native injection 缺失不等于用户没有 create_agent/browser 能力。13 个能力位已实现也不等于
   systemPrompt 等配置已兑现。
7. **验证顺序改正**：生成内嵌桥 → bridge-assets-check → 插件/真机检查。
   原计划把生成放在校验之后会先检查旧资产。增加真实历史重放、失败、取消和跨会话隔离验证。

复核依据：当前安装包 `dsh-user-approval/lib/index.js`、`dsh-acp/lib/index.js`、
`dsh-system-prompt/lib/index.js`、`dsh-api-session-controller/lib/index.js`、
`dsh-tool-workflow/lib/types/types.d.ts`、`dsh-goal/lib/types/domain.d.ts`；
本仓历史白名单与 TimelineBuilder；Paseo 公开 provider 文档和本机 provider/schema 源码。
验收输出汇入 [evidence.md](evidence.md)。本任务交付源码与证据，不发布 npm 产物。


## 恢复执行补充裁决

8. **投影前置组合**：真实基础 profile 不挂 sessionStats 和 agentPreset 单元；这不是读取器丢字段。分别在基础 profile 验证缺键错误、在临时 profile 挂载原生 session-stats 和 preset registry 后验证真实数值。不能为了通过测试伪造空值，也不擅自为用户改 preset。
9. **审批协商与退出**：新增 negotiated permission 门控；用真实 DshProcess + DshSession 的脚本化 stdio 对端验证并发、超时、晚答、关闭和进程退出，不能只检查桥 mock。
10. **后台 workflow 不从属于父回合终态**：DSH 的 run_in_background 由 jobs 持有，run-end 可晚于 turn/end。合成状态行从普通工具的回合收尾集合中分离；仅冷历史收尾时关闭残缺运行态。加入真实后台回合与正常工具收尾的双向对照。
11. **plugin-check 的计时断言**：原断言取所有统计行的第一条，工具步骤没有瞬时文本帧时可以不带 firstTokenMs。改为只看本次提问的行，并要求实际存在有限、非负的 firstTokenMs；不把其他提问或旧行当成通过。真实日志显示工具步骤后有正常文本步骤，原断言因此假红。
