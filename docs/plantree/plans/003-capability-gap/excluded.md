# P003 B/C 档明细：不做的部分与理由

显式列出「不排期」的项，避免下一轮又把它们当缺口重新调研一遍。B 档可对外提交的文字已交付于 [upstream-issues.md](upstream-issues.md)，尚未提交到外部服务。

---

## C 档：无数据源（显式排除）

| 项 | 理由 | 证据 |
|---|---|---|
| `totalCostUsd` 会话成本 | DSH 全包**无货币成本字段**。`pricing` 的命中全是 token 预算语境（compaction 的「shadow pricing」、attachment 的「request pricing」），不是金额。 | `grep totalCostUsd\|costUsd` 在 `@deepseek-ai/*/lib/types/*.d.ts` 零命中 |
| `maxThinkingTokens` | 桥的 `initialize` **已支持 `maxTokens`** 并存入 `sessionRoutes`（`dsh-bridge/lib/server.js:937`、`:944`），但语义是**输出上限**，不等于「思考 token 上限」。Paseo 的 `AgentRunOptions.maxThinkingTokens` 在 DSH 侧没有等价概念。 | 同上；桥侧已有字段但插件从未传 |
| `toolPolicy.preapproved` | DSH 无「预批准指定 MCP 工具」概念，权限由 profile 的 preset 决定。自造等价物违反仓库「不要自造协议形状」硬约束。 | `provider.ts:1245-1248` 注释已写明 |

---

## C 档：刻意不声明（**不要当缺陷修**）

| 项 | 理由 |
|---|---|
| `session.revert.files` | 桥没有 files-only 撤回——文件回滚是 `both` 的一部分（`revert.js:126` 的 `revertScope()` 只接受 `conversation`/`both`）。声明一个后端兑现不了的能力，比菜单里少一项更糟。原文见 `provider.ts:79-81`。 |

**如果将来要做**：拆 `both` 里的文件那一半成独立 scope，需要先证明「只回文件、不动对话」在 DSH 侧语义自洽。当前不做。

---

## B 档：上游写死（需 Paseo 协作，不在本仓实现）

### B-1 `supportsNativePaseoTools` 硬编码 false
- 位置：`packages/server/src/server/agent/plugin-provider.ts:1708`。
- 后果：60+ Paseo 原生工具（`create_agent`、`list_workspaces`、`create_schedule`、`browser_*` 等，目录见 `packages/protocol/src/paseo-tool-presentation/catalog.ts:140-400`）拿不到原生注入。
- **注**：这不等于 DSH 没有工具——DSH 有自己的全套工具，且 Paseo 的 MCP server 经 gateway 注入。缺的是「Paseo 原生工具目录」这一套。
- 界面上：`tool-call-details.tsx:616-624` 的 `buildPaseoUnknownSections` 对这些工具有语义化渲染，但原生注入通道不可用；经 MCP gateway 调用的工具仍可能显示，不能据此断言那些渲染永远不会出现。
- **我们能做的**：向上游提 issue 说明 `supportsNativePaseoTools: false` 让插件 provider 永久失去这条路径，而 `launchContext.paseoTools` 是宿主内部对象不是协议字段。

### B-2 `ProviderCommand` 无 `kind` 字段
- 位置：`packages/plugin/src/server/provider.ts:358-362`（只有 `name`/`description`/`argumentHint`）；宿主 `plugin-provider.ts:1315` 硬编码 `kind: "command"`。
- 原生 provider 能返回 `kind: "skill"`（`codex-app-server-agent.ts:824`、`opencode/v2/commands.ts:35`）。
- 后果：`packages/app/src/utils/agent-command-autocomplete.ts:79-83` 的 `filterInlineSkillCommandEntries` 只放行 `kind === "skill"`，所以 **DSH 的 skill 在正文内联 `/` 输入时不出现在补全里**。
- **本仓已尽力**：`session.ts:665-680` 保留了 skill 名，只是协议没地方放 kind。
- **我们能做的**：向上游提 issue，请求 `ProviderCommand` 增加可选 `kind`。

### B-3 `usageSession` 未实现 + 需 `registerUsageSource`
- `plugin-provider.ts` 无 `usageSession`（grep 0 命中），原生 `acp-agent.ts:1815` 有。
- 数据链：`UsageSourceRegistry.discoverAgent()` 需要 `agents.usageSession(agentId)` 返回非 null（`packages/server/src/server/plugins/usage-sources/index.ts:139-143`），否则**直接返回空数组**（静默无卡片）。
- **两件事缺一不可**：① 宿主补 `usageSession`；② 插件侧 `registerUsageSource`。
- 但注意：DSH 侧也**没有账号额度/余额数据源**，所以即使打通，也没有真实数据可显示。这一项双重受阻，**优先级最低**。

---

## B 档附：7 个被整体丢弃的可选扩展点

`plugin-provider.ts` 对下列方法 grep 均为 0（`AgentClient`/`AgentSession` 上有、插件桥没实现）：

| 方法 | 原生谁在用 | 影响 |
|---|---|---|
| `tryHandleOutOfBand` | pi:1640、omp:1257、codex:5142 | **影响最大**：插件 provider 无法处理 `/compact` 这类不打断回合的旁路命令 |
| `usageSession` | claude:3585、pi:1210、omp | 见 B-3 |
| `listFeatures` | claude、opencode、pi、omp | 只能走 `session.config.settings` 降级映射 |
| `resolveCreateConfig` | opencode:1404 | 无法在创建时改配置 |
| `isCreateConfigUnattended` | opencode、acp | 无 unattended 判定 |
| `resolveDefaultModeId` | codex:7478 | 无法按环境决定默认模式 |
| `resolveConfiguredModel` | claude/models.ts:26 | 配置模型无法补 thinkingOptions |

**未验证**：上游是否有意不实现（例如安全边界），**没找到注释说明**。标为推断，提 issue 时如实说明。

---

## 关于 `timeline.plugin` 能力位的澄清
我们**没有声明**这个能力位，但**实际在用** `type:"plugin"` 的 item（`session.ts:2246` 发 stream-stats 行）。

- 结论：**声明与否都不影响**。Paseo 宿主代码里**零处**按这个能力位门控（全仓 grep 只命中定义处 `provider.ts:24` 与一个测试 fixture）；`timeline.item` 里 `type:"plugin"` 直接透传，只校验 `pluginId === loaded.id`（`runtime.ts:1177-1187`）。
- 这是 Paseo 侧的**未接线能力位**，不是本仓缺陷。**不要为它排期。**

---

## 明确不是差距的项（界面本身没有）
- **checkpoint**：Paseo App 层无此概念（grep 只命中 sqlite row-store）。
- **MCP 工具列表独立界面**：不存在，只有宿主级开关。
- **token 速率显示**：宿主无此界面（我们的 stream-stats 是插件自己渲染的，属于加分项）。
- **运行中切 provider**：界面设计限制，原生 provider 同样不行。
- **voice / desk pet / terminal / file explorer / git / worktree**：宿主独占，与 provider 无关，DSH 一个都不缺。
