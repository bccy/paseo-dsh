# P003：上游问题草稿

三项仅交付问题描述，未创建外部 issue。对照版本为已安装 Paseo 0.14.0，源码参照 `getpaseo/paseo` 同版本 provider / app 契约。是否有意限制尚无上游确认，不作为事实断言。

## B-1：让 direct provider 声明原生 Paseo 工具支持

**建议标题**：Expose an opt-in native Paseo tools contract for direct provider plugins

**现象与复现**：注册一个 direct provider，在 `session.open` 检查配置。当前只能收到宿主注入的 MCP servers；`PluginAgentClient` 返回的 `supportsNativePaseoTools` 始终是 false（安装包 `agent/plugin-provider.js:1401`，对应源码 `plugin-provider.ts:1708`）。原生 OMP 等适配器可以走 launchContext 中的原生工具通道，公开插件协议不能声明和接收等价数据。

**影响**：插件必须使用 MCP 适配层，不能选择同样的原生工具注入通道。paseo-dsh 已通过 MCP gateway 提供 Paseo 工具，因此这不是“用户没有 create_agent / browser 工具”。工具展示也不能简单断言为永远不可见。

**建议**：明确是否允许 direct provider 选择原生工具注入；如允许，新增可协商的能力及公开配置/调用契约，默认保持 MCP。避免同时注入两套，保留调用者 agent 身份、权限和工具 schema。

**上游验收建议**：默认插件仍收到 MCP；声明且协商成功的插件收到原生通道；工具可调用且归属正确；无重复工具；未协商时按旧行为运行。

## B-2：ProviderCommand 保留 skill 类型

**建议标题**：Preserve command kind when mapping direct provider slash commands

**现象与复现**：插件通过 `session.commands` 返回可用技能。`ProviderCommand` 只有 name / description / argumentHint；宿主映射固定 `kind: "command"`（安装包 `plugin-provider.js:1034`，源码 `:1316`）。App 的 `filterInlineSkillCommandEntries()` 只接受 `source === "provider" && kind === "skill"`，所以正文中的 `/` 内联补全不显示这些技能。

**建议**：公开协议新增可选 `kind: "command" | "skill"`，缺省 command；schema 与宿主映射保留该字段。插件在有真实 skill 来源时填 skill，不根据名字猜类型。

**上游验收建议**：旧插件兼容；skill 出现在内联补全；command 不错误混入；顶层斜杠菜单和 dispatch 保持原有名称与执行行为。

## B-3：usage source 能发现 direct provider 会话

**建议标题**：Expose usage-session identity for direct provider usage sources

**现象与复现**：direct provider 配合 `registerUsageSource` 仍无法建立 agent 级用量来源。`PluginAgentSession` 没有 `usageSession`；`UsageSourceRegistry.discoverAgent()` 在 `agents.usageSession(agentId)` 为 null 时直接返回空（安装包 `plugins/usage-sources/index.js:85-90`）。

**建议**：为插件公开稳定的 usage session/provider/account 身份描述和失效规则，使已注册 usage source 能匹配会话。不要把消息 token 用量当成账户额度，也不要把未知额度填成零。

**上游验收建议**：真实数据源能发现对应会话；切 provider/account 后旧缓存失效；未提供描述或数据源时保持空且可诊断；插件卸载后清理注册。

**paseo-dsh 边界**：当前 DSH 没有账户额度/余额数据源，所以上游接通发现链也不等于本插件能立即展示额度。这是协议缺口与数据缺口共同阻塞的低优先级项。

## 其余可选扩展点

`tryHandleOutOfBand`、`listFeatures`、`resolveCreateConfig`、`isCreateConfigUnattended`、`resolveDefaultModeId`、`resolveConfiguredModel` 与上述 `usageSession` 的清单和影响保留在 [excluded.md](excluded.md)。本次不替宿主补协议，也不改宿主 dist。
