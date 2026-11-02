# 给 AI Agent 的说明

这个文件有两个用途，按你来的目的看对应那节。

---

## 一、如果你是被用户叫来"安装这个东西"的

完整的分步指令在 [README 的「复制这段给你的 AI Agent」](./README.md#-复制这段给你的-ai-agent推荐)
一节。照那份走，不要自己发明流程。

动手前必须先完整读 [docs/ADOPTION.md](./docs/ADOPTION.md)——它解释了架构和已知的坑，
跳过它几乎必然踩到配置里的两个陷阱。

四条最容易犯的错，先记住：

1. **不要自己编模型配置。** 用 `npx paseo-dsh probe` 探测出结果（仓库里的
   `tools/probe-provider.mjs` 是同一个实现的瘦启动器），原样采用。
2. **安装命令是 `paseo plugin add npm:paseo-dsh`。** 它会打印一条「Plugins are trusted,
   unsandboxed code...」安全提示——先把原文转述给用户并取得同意，再执行安装。
   插件首次加载会自己建好 DSH profile，**不需要再跑 `install.sh`**。
3. **不要把 API key 写进任何会被提交的文件**。它在 `~/.dsh/.credentials.yaml`。
4. **装完/改完配置后跑 `npx paseo-dsh doctor`** 确认全绿，再重启 daemon。

---

## 二、如果你是被叫来"改这个仓库"的

### 架构是三段，别搞混

```
Paseo  ⇄  paseo-plugin/（direct provider 插件，跑在 daemon fork 出的 plugin-process 子进程里）
              ⇄  dsh-bridge/（stdio JSON-RPC，一个连接的所有会话共用一个子进程）
                 ⇄  DSH profile
```

- **Paseo 源码不需要改，DSH 也不需要 fork。** 两边都走公开扩展点。
- **插件不在 daemon 进程里**：宿主用 `fork()` 把它起成独立的 `plugin-process` 子进程，它只能
  经 provider 连接与插件 API 和 daemon 交互（`paseo` 句柄只在 hook / RPC handler 的回调上下文
  里拿得到，`connect()` 里没有）。所以**看不到 daemon 内存**，任何"宿主到底做了什么"的断言
  只能在宿主自己的代码上做（见 `harness/host-contract-sim.mjs`）。
- **唯一的例外是 `local-patches/`**：它改写**已安装的** `@getpaseo/server` dist，因为上游
  没有对应的扩展点（撤回后截断宿主 history、重放时补 `turnId`）。它**不是发布产物**——`npm
  publish` 出去的包里没有它，装不装都不影响插件本体；不装时各项行为如何降级见 README 与
  [docs/REWIND.md](./docs/REWIND.md)。它是给维护者的可选加速项，macOS 桌面版自带签名 CLI
  根本打不了补丁。
- `paseo-plugin/server/*.ts` 是 Paseo 那一侧的契约实现；`dsh-bridge/lib/*.js` 是
  运行时的桥接。**中间那层协议是这个仓库自己定的**，改它要同时改两边。
- 桥的 profile 是 `dsh-base` + `dsh-paseo-bridge`（见 `server/bootstrap.ts`）。`@deepseek-ai/dsh-web-app`
  会按 id 把 base 的 `plan-mode` 行 `disabled: true`（`dsh-web-app/cordis.patch.yml`），于是桥的
  `paseo/plan/get|set` 只能回答 "not mounted"，插件会把 Plan 模式从能力里摘掉。叠加了 web-app 的
  profile（例如 `dsh-prime-memory` 需要它的 `webServer`/`connection`）在 `cordis.patch.yml` 末尾加
  `- id: plan-mode` + `disabled: false` 即可恢复（按 id 合并，base 的 `config.section` 保留）；改完用
  `dsh --profile <name> --dump-config` 和桥的 `paseo/catalog`.`planMode` 验证。实测对照：
  `base+bridge` plan 可用，`+web-app` 不可用，`+web-app+补丁` 又可用。

### 改之前先读

- [docs/FIELD-NOTES.md](./docs/FIELD-NOTES.md) — 八十余条真实缺陷（编号到 84，含 `b`/`c`
  补记与 DSH 升版教训；历史段落里 22–25、46–47 有重号，引用旧条目时带标题）。里面有整整一类错误叫
  **静默降级**（把不知道的东西当成成功、把不支持的能力悄悄丢掉）。改动前先看一遍，
  避免重新发明这些 bug。
- [docs/ADOPTION.md](./docs/ADOPTION.md) 第 4 节 — 教训按主题归纳。
- [docs/FULL-AUDIT-20261020.md](./docs/FULL-AUDIT-20261020.md) — 2026-10-20 全量审查：
  8 个 P1 的成因与修法、有意偏差清单、未修项与待用户决定项。改动前先看有没有踩在同一处。
- [docs/FULL-AUDIT-20261029.md](./docs/FULL-AUDIT-20261029.md) — 2026-10-29 全量审查：
  6 路只读审查的逐条裁决（成立 / 改修法 / 驳回 / 暂缓）、对应修复提交、有意偏差与未做的
  真机项。**这次的教训之一是审查流程本身**：主编排漏审一处删除，把 `setPermission` 弄丢了。
- [docs/FULL-AUDIT-20261102.md](./docs/FULL-AUDIT-20261102.md) — 2026-11-02 全量审查：
  21 路只读审查的逐条发现，以及修复轮的落地结果（fixed / blocked / 暂缓）与待用户决定项。

### 硬性约束

| 约束 | 原因 |
|---|---|
| **不要自造协议形状** | Paseo 自己的 Codex / Claude 适配器就是权威协议文档。提问卡和计划卡的形状必须和它一致，否则界面会以奇怪的方式坏掉 |
| **能力声明要和数据源一致** | 声明了什么，UI 就长成什么样。漏声明 = 功能消失（不报错）；过度声明 = 用户选了却被丢弃（更糟） |
| **失败要响亮** | 不认识的输入类型发 `request.failed`，不要发 `request.completed`；翻译不了的内容块抛错，不要跳过 |
| **取消是取消回合，不是杀进程** | 杀进程会连会话一起报废 |
| **不要硬编码某个人的 provider/model** | 这个仓库是给别人用的。路由从 profile 读，读不到就带说明失败 |
| **能复用的代码或逻辑，不要自己写** | 上游已经有的实现（DSH 的 `session.append` 表面替换、compaction 折叠、`dsh-rewind` 的 git 快照；Paseo 适配器已经验证过的形状）比我们现编的可靠，也免得下次上游一改就跟不上。复用前先核目标版本的 API 与语义（版本范围满足≠可运行），复用时把边界写进注释；确实没有可复用的，再自己写并在 `docs/` 留痕。 |
| **替换已在跑的实现，要能删掉一整块代码** | 上一条管"新写的东西先找上游"；已经在跑的自有实现，只有上游提供了**稳定的等价能力**（公开 API 或宿主原生行为，例如上游真正修掉 #4667、宿主自己刷新撤回后的时间线之后，`local-patches` 的撤回补丁就可以删——当前 #4667 仍 open，补丁仍在用）、换完能**删掉一整块代码**时才换，并在同一个提交里删旧实现。把自己的代码换成对 DSH **内部服务**的调用不算减负：依赖从"自己能控制的代码"挪到"上游没有稳定承诺的内部 API"，升级时会静默失效，而且 `dsh-api-contract-check` 只看 import、看不见服务调用。不做成批的"总体迁移"；修 bug 就单独修，不要借迁移的名义一起做。教训：2026-10-31 的迁移分支运行时代码只净减 55 行，换来 13 个没有检查兜底的内部符号和一次 CI 变红，DSH alpha 已经改掉其中两处语义。 |
| **不要注册 `before("agent.session_open")`** | 宿主对带这个 hook 的插件，每次起停都会 `invalidatePluginSessions()`，于是**所有 agent（任何 provider）下一次提问前都会被 reload**。想拿 `paseo` 句柄就用 `on("agent.turn_started")` / `on("agent.turn_ended")` 或一条 RPC 在回调上下文里取 |
| **改了 `dsh-bridge/` 必须重生成内嵌桥** | `paseo-plugin/server/bridge-assets.ts` 是桥的 base64 内嵌副本，供插件自举 profile（Paseo 安装插件不跑脚本）。跑 `node paseo-plugin/scripts/generate-bridge-assets.mjs`（`npm publish` 的 `prepack` 也会跑），并提交生成结果 |

### 跟 DSH 升版

**这个仓库没有官方支持，跟版是长期成本。** 桥直接依赖 DSH 的内部组装包（见 [docs/HARNESS.md](./docs/HARNESS.md)
里的 `dsh-api-contract-check.mjs`），这些包**没有 API 稳定性承诺**；上游改一个提示词变量、
一个 schema 字段或一个异步就绪时机，功能就会**静默失效**——不报错、不崩，只是没了。所以：

**只跟稳定线。** `rc` 是某个版本的收尾，`alpha` 是下一个版本的开头，两者差的是成百上千个提交
（实测 `0.2.1-rc.5` → `0.2.2-alpha.2` 相差 2161 个提交）。alpha 里那些「插件需迁移」的条目
（异步 session projection、`tools.resolve/executable`、Cordis Timer 返回值、official-bundles
import）等它走完 rc 再跟，那时改动才定型。

**先读 release notes，再决定跑多少检查。** GitHub `deepseek-ai/deepseek-harness` 有逐版
changelog（`npm view` 看不到）。关键判据是**上游改动落在哪一层**：UI / Web / 桌面壳层对桥零
影响；提示词变量、插件 schema、异步就绪时机、工具 API 形状则影响高。用 `npm pack` 比对桥依赖
的那几个包的 `lib/` 逐文件差异，比读 changelog 更能定性——实测 `0.2.1-rc.2` → `rc.5` 当时的五个硬依赖
包**逐文件 0 差异**（现在是八个，以契约检查的清单为准），那就不必做全量验证。

**升级顺序固定，前一步红就不要往下走：**

```bash
# 0. 备份当前状态，记录基线
dsh --version && npm ls -g --depth=0 | grep dsh
node paseo-plugin/bin/paseo-dsh.mjs doctor        # 升级前基线，留档对比

# 1. 装新版
npm install -g @deepseek-ai/dsh@<version>

# 2. 契约级：桥依赖的内部 API 还在不在（秒级、纯离线）
node harness/dsh-api-contract-check.mjs

# 3. 资产新鲜度：内嵌桥与源码一致（必须在 plugin-check 之前）
node harness/bridge-assets-check.mjs

# 4. 安装完整性
node paseo-plugin/bin/paseo-dsh.mjs doctor

# 5. 真实回合：这一步 doctor 替代不了
node harness/plugin-check.cjs                     # 含真实模型回合（默认一次性 DSH_HOME）

# 6. 离线回归（动到对应区域时）
node harness/plugin-build-check.mjs
node harness/frame-reader-check.mjs
node harness/transport-frame-check.mjs
node harness/mcp-http-check.mjs
node harness/mcp-stdio-check.mjs

# 7. 重启进程让新版生效
paseo daemon restart
```

**为什么 `doctor` 全绿不算数。** 它只查安装完整性（CLI/版本/profile/桥文件/路由/key），查不出
回合层失败和空模型目录——`docs/FIELD-NOTES.md` 第 58 条就是这么漏过去的。而且
`paseo-plugin/lib/doctor.mjs` 的 `compareCore` **只比 `major.minor.patch`、忽略预发布后缀**，
所以 `0.2.2-alpha.2` 甚至 `0.3.0-alpha.1` 都会被判通过。**doctor 永远不会拦住你升到一个破坏性
版本**，唯一的判据是 `plugin-check.cjs` 跑通。

**为什么 `bridge-assets-check` 必须在 `plugin-check` 之前**，见「改完怎么验证」。

**重启前确认生效路径。** 磁盘上换版本不会影响已运行的进程（Node 已经把旧模块读进内存）。
`dsh --version` 看的是磁盘，`ps -o lstart= -p <pid>` 看的是进程启动时间——两者对不上就是还没生效。
`paseo daemon restart` 会重启 worker 并保留 supervisor 的启动方式，不必手工杀进程。**注意它也会
换掉 Web 端口**，重启后以新端口为准。如果当前会话就跑在那个 `dsh` 子进程里，重启会终止它——
先确认会话历史在 `~/.dsh/sessions`（不丢），再决定是否接受中断。

### MCP 注入与 gateway

Paseo 把它的 MCP server 通过 `config.mcpServers` 交给 provider，插件把它翻成 DSH 启动时的
`--patch` 覆盖层（`server/dsh-process.ts` 的 `mcpEntries()`）。**gateway 现在支持两种传输**：

| 传输 | 谁走 | 挂载方式 |
|---|---|---|
| Streamable HTTP | Paseo 自己的 server（工具数十个、schema 数十 KB） | gateway，三个元工具 `mcp_list_tools` / `mcp_tool_schema` / `mcp_call_tool` |
| stdio，**在白名单里** | 当前只有 `server_browser`（Server Browser 插件的 bridge，工具二十余个、schema 约 20 KB） | 同上，gateway 起子进程说 stdio JSON-RPC |
| stdio，不在白名单 | 用户自己配的 stdio MCP | 原生 `@deepseek-ai/dsh-mcp-client`，全量 schema |

- **白名单是硬要求，不是优化**：`GATEWAY_STDIO_SERVERS`（`server/dsh-process.ts`）只放
  `server_browser`。用户自配的 stdio MCP 一旦被代理，就从"工具直接可用"退化成"每用一次
  要先查两次 schema"，这是能力回归——只有**工具多、调用少、能力窄**的 server 才值得代理。
- **stdio 客户端是手写的**（`dsh-bridge/lib/mcp-stdio.js`），不是引
  `@modelcontextprotocol/client`：桥整个被打成 base64 嵌进 `server/bridge-assets.ts` 随插件
  分发，装不了依赖，所以只实现了 gateway 需要的三个方法（`ensureInitialized` /
  `listTools` / `callTool`）。
- **legacy SSE 仍然按名字拒绝**，不要为它猜一个传输。

### 改完怎么验证

界面不可信，断言要打在协议层：

```bash
node harness/dsh-api-contract-check.mjs      # 桥依赖的 DSH 内部 API 还在不在（秒级、纯离线）
node paseo-plugin/bin/paseo-dsh.mjs doctor   # 一眼看安装是否完整：CLI/版本/profile/bridge/路由/key
# 下面三条起真实 dsh：route-test 默认一次性 DSH_HOME；catalog / probe 仍读写真实 profile
node harness/catalog.mjs      # provider / 模型 / 每个模型的真实思考档位
node harness/probe.mjs        # 端到端提问往返（耗 token）
node harness/route-test.mjs   # 逐条路由跑真实回合（耗 token）
cd paseo-plugin && npx tsc --noEmit
```

改**这个 checkout** 时一律用 `node paseo-plugin/bin/paseo-dsh.mjs ...` 跑本地源码的
doctor/probe；`npx paseo-dsh` 解析的是**已发布到 npm 的包**，可能与工作区不一致（落后或超前），
拿它自检会把"非当前代码"的行为当成通过。

**动了插件层（`paseo-plugin/server/*.ts`）就一定跑 `harness/plugin-check.cjs`**——
它断言的是事件形状，而事件形状错了界面不会报错，只会悄悄不对。运行步骤写在那个文件
的头部注释里（插件是 TS，要先编成 CJS 才能 require）。

注意它**不是纯离线**：不设 `DSH_BINARY` 时会起真实 `dsh --profile` 跑真实模型回合（耗
token），并且加载插件会把内嵌桥写进所用 `DSH_HOME` 的 profile（默认是一次性克隆；
`--allow-real-profile` 时是 live profile）。所以**跑它之前先跑 `node harness/bridge-assets-check.mjs`**：
内嵌桥若是旧的，真机检查就跑在旧桥上"假绿"，用真实 home 时还会把旧桥装进 live profile。
再跑 `node harness/plugin-check.cjs --self-test`：它只验证编译产物加载与图片块翻译，不碰
profile/模型；改过 `plugin-check` 的判据后这一步能最快抓到编译或导入错误（T03/T04 的判据回归
在 `harness/harness-gates-check.mjs`）。

同一条编译流程还带几个假 `dsh` 驱动的回归脚本，动到对应区域时一并跑：
`harness/subagent-check.cjs`（子会话可见性）、`harness/steer-check.cjs`（插话回执）、
`harness/mcp-injection-check.cjs`（Paseo 注入的 MCP server 是否真的落到 `--patch`：HTTP 与
白名单 stdio 走 gateway、非白名单 stdio 仍原生、sse 按名字拒绝）、
`harness/assistant-stream-check.cjs`（助手文本流式：同 id 增长快照、`id === messageId`、
经 Paseo 规则投影后合并成一行）、`harness/image-check.cjs`（图片工具结果：带 `hostPath` 的
图片块**恰好**多出一条 markdown `assistant_message`、路径逐段编码、无 `hostPath` 不出行、
过 `ProviderEventSchema`、`history: "replay"` 重建同一条）。
这批假桥脚本各自用**一次性 `DSH_HOME`**，不会改写你 `~/.dsh` 里正在用的 profile；
**真实 profile/模型脚本（`plugin-check`、`route-test`、`tools`、`stream-probe`、`rewind-e2e` 系列）
也默认使用一次性 `DSH_HOME`（`harness/isolated-dsh-home.cjs`：克隆源
profile、凭据只做 symlink、退出清理），`--allow-real-profile` 才会读写真实 home；
`rewind-native-check` 面对运行中的 daemon 无法隔离，必须显式 `--allow-real-daemon`。**
完整判定在 `harness/harness-gates-check.mjs` 的 HP-05 段。

**逐脚本的离线检查清单（断言什么、动了哪里必跑）在 [docs/HARNESS.md](./docs/HARNESS.md)。**
改了代码先在那里按改动区域查必跑项；新增检查也登记到那里，不要加回本文件——本文件会整份注入
DSH 会话，超过 64 KiB 的工作区指令预算时 DSH 会丢掉用户的 `~/.dsh/AGENTS.md`（FIELD-NOTES 第 77 条）。

客户端脉冲这条链最容易"看着对但静默失效"（`Animated` 在 RN Web 上只跑一段就停、`setValue`
推不到原生 view、客户端不折叠只改 `metadata` 的 item），所以断言要打在数据层。

**动了流式（`agent/assistant-stream` / `paseo/assistant-delta`）还要跑真实端到端**
`node harness/stream-probe.mjs`：它用真实 `dsh --profile paseo` 断言一步内出现多个
增长快照、且首个 delta 远早于 durable `assistant/message`。插件层的假桥检查只能证明
折叠，证明不了桥真的订阅到了 DSH 的瞬时帧。

**注意一个反直觉的坑**：`waitFor` 式的等待会匹配到上一条陈旧事件。换阶段时清空事件数组，
或按 `turnId` 过滤——有一次就是因为匹配到了被取消那一回合的事件，误判成"取消后对话
无法继续"，差点去改一段本来正确的代码。

### 撤回（rewind）

撤回实现跨越 DSH 会话日志、桥与插件三层，**离线断言全绿不等于能用**（曾经两次出现
"mock 通过、真实 append 必挂"）。改到撤回或 `dsh-bridge/` 时按顺序跑：

```bash
node harness/revert-check.mjs          # 令牌/区间/前置/回执/文件层/canary 顺序/共享进程接线
node harness/rewind-notice-check.cjs   # 完成提示的客户端半（文案/计数/旧 notice 过滤/live 监视器）；动了撤回文案或客户端监视器必跑
node harness/rewind-notice-delivery-check.mjs  # 完成报告能否确定到达时间线、降级窗口（--degraded/--degraded-late）；动了 report 落行逻辑或宿主 rewind 时序必跑
node harness/surface-check.mjs         # 只折撤回缝、compaction 保留、尾随日志事件
node harness/file-snapshot-check.mjs   # 写前备份；动了 capture 读/序号绑定、skip 载入、planRestore 的 unrecoverable、restore 目录身份复核必跑
node harness/snapshot-lifecycle-check.mjs  # 捕获序号跨重启续数、旧 journal 歧义拒绝（纯离线）
node harness/factory-ownership-order-check.mjs  # beginOwner 接线、live agent 的 runMaintenance 存在性（依赖本机 DSH，不进 CI）
node harness/file-mutation-gate-check.mjs      # 文件写入闸门：freeze 排空在飞写入、超时重开准入（纯离线，进 CI）
node harness/rewind-transaction-check.mjs      # 撤回事务；动了 settleDelegatedWork/cancelWithdrawnDelegations 的返回形状、票据清理、scope 条件化或 files.error 回执必跑（依赖本机 DSH，不进 CI）
node harness/rewind-merge-check.mjs    # 父子归并；动了 child-anchors 的 recordDelegatedTurn 或 observeDelegatedTurn/snapshotAnchorFor 必跑
node harness/revert-shape-probe.mjs    # 纯内存离线（用本机已装 @deepseek-ai/dsh-session，DSH_SESSION_MODULE 可覆盖路径）：旧写法必抛、新写法通过
node harness/replay-fidelity-probe.mjs <session.v4.jsonl.zstd>  # 真实日志重放保真
node harness/host-contract-sim.mjs     # 宿主契约：canary 在补丁版被截掉、原版存活（见下）
node harness/local-patches-check.mjs   # 补丁脚本门禁：CALL 区域外的语句必须 fail closed、checker 与 apply --check 复用 host-fields/upstream-history 判定（纯离线 fixture）
node harness/rewind-e2e.mjs            # 真 dsh --profile paseo，3 回合端到端（耗 token）
node harness/rewind-merge-e2e.mjs      # 真机父子归并：父写+子代理写 → both 撤回 → 两文件都删（耗 token）
node harness/rewind-native-check.mjs   # 经真实 daemon 的撤回（耗 token；见下）
```

**三条不能破的约束**（都是真机踩出来的）：

1. 撤回的替换事件必须是 `user/message` + `source.kind="paseo-rewind"`：DSH 日志 v4 要求
   `system/developer/assistant` 消息处于打开的 turn/step 内，空闲时追加会让整份日志被判 corrupt。
2. append 之后必须 `await sessions.flush(session)`：宿主回执后立刻读日志重建时间线。
3. 重放折叠只折本桥撤回缝；compaction 的 replace 不折，否则重开会话丢压缩前对话。

**第四条：撤回提示（canary）必须在 `request.completed` 之前发出。** 宿主的时间线只能追加、
协议里没有"删行"事件，所以插件用一条通知自证这次撤回到底刷没刷新。可见性分三层：**live 投递
看不到**（撤回期间宿主持有 run lock，`enqueueSessionEvent` 把通知压进 `stagedEvents`，run
settle 时一起丢弃）；**原版宿主**在 `revert()` 返回后的 force-hydrate 里从 provider history
重放（`accept()` 先入 history、`streamHistory()` 重放），于是它出现在重建后的时间线，告诉用户
执行 Reload agent 或重开会话；**打过截断补丁的宿主**在 `revert()` 内被 `truncateHistoryFrom`
截掉（预期行为，看不到）。**顺序就是机制本身**——放到回执之后，补丁宿主上它也会留下来，变成
「时间线没刷新」的误报。文件作用域（`scope: "files"`）的撤回不动对话，不发。依据是已装宿主
0.14.0 的 `plugin-provider.js` / `agent-manager.js`；**未在「未打补丁宿主 + 真实 daemon」上
复验**，复验前别删改 canary。

**`harness/host-contract-sim.mjs`** 是这条规则的唯一直接证据：它直接 import 宿主真实的
`plugin-provider.js`（只读），驱动一次撤回，再断言 canary 在**补丁版被截掉、原版存活**；
判据取自宿主文件里有没有 `truncateHistoryFrom`，所以宿主改了行为却没改文件时也会红。
用法 `node harness/host-contract-sim.mjs [host-agent-dir] [compiled-plugin-dir]`，宿主目录默认
从已装 CLI 推（`PASEO_CLI_ROOT` 可覆盖）。**要跑原版那一半，解包出来的 `package/dist` 必须
再套一层带 `node_modules` 软链的包装目录**，否则 `zod` 之类的 bare specifier 解析不到；做法写在
该文件头部注释里。**动了 canary 文案、发出顺序或 `rewind-canary.ts` 必跑。**

**`harness/rewind-native-check.mjs`** 走的是 `agent-manager.rewind()`，所以**它需要打过
`rewind` 补丁、并且正在运行的 daemon**——清单里前面那些离线脚本走的是桥的 `paseo/revert`，
**根本到不了宿主的 `revert()`**，只有这条路径能覆盖宿主侧那一半。**耗 token**：创建 agent、
两个回合、撤回、再问一次。改撤回的宿主侧行为后跑它，跑完人工核对
「被撤消息消失、无 loading、session id 不变、模型看不到被撤内容」。

真机验收要用**新会话**（能力位只对新会话生效）：发两条消息 → 撤回第二条 → 消息消失、
无 `/rewind` 行/回合页脚、编辑工具改的文件恢复、模型不知道被撤内容、重开会话仍正确。

### 提交前

- 跑一遍 `node --check` / `tsc --noEmit`
- 确认没有引入任何具体的 provider 名、模型 id、base URL、密钥
- 用户本机的真实路径（如 `/Users/<你>`、`/home/<你>`）不要出现在任何文件里；测试夹具里的虚构路径不算
- 本文件只放规则和指针，长清单放 `docs/`：它会整份注入 DSH 会话，体积超预算会挤掉用户自己的 `~/.dsh/AGENTS.md`

## 三、发布流程（硬性）

**产物推送必须等用户本机测试通过并明确确认。** 本地改完可以先 commit 代码（push 是否要先问，按用户自己的规则），
但 `npm publish`、`npm deprecate`、目录收录（paseo.cafe 等）、打 tag、发 Release 一律
等用户说"测试通过"之后再动。

顺序固定为：

1. 用户提需求
2. 本地改动 + 自测（见上面的验证命令）
3. 交回用户，在真实环境里测试
4. 用户明确确认
5. 才推产物到各平台

违反这条的代价很具体：0.2.8 修了 `{{cwd}}` 却漏了 DSH 0.2.1 的 catalog 异步物化，用户装到
一个"能装、模型列表却是空"的版本，比不发布更糟。已误发的坏版本用
`npm deprecate paseo-dsh@<ver> "..."` 兜底（registry 必须显式指向 npmjs，默认镜像发不了）。
