# 给 AI Agent 的说明

这个文件有两个用途，按你来的目的看对应那节。

---

## 一、如果你是被用户叫来"安装这个东西"的

完整的分步指令在 [README 的「复制这段给你的 AI Agent」](./README.md#-复制这段给你的-ai-agent推荐)
一节。照那份走，不要自己发明流程。

动手前必须先完整读 [docs/ADOPTION.md](./docs/ADOPTION.md)——它解释了架构和已知的坑，
跳过它几乎必然踩到配置里的两个陷阱。

三条最容易犯的错，先记住：

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
Paseo  ⇄  paseo-plugin/（direct provider 插件，跑在 daemon 进程里）
              ⇄  dsh-bridge/（stdio JSON-RPC，每个会话一个子进程）
                 ⇄  DSH profile
```

- **Paseo 源码不需要改，DSH 也不需要 fork。** 两边都走公开扩展点。
- `paseo-plugin/server/*.ts` 是 Paseo 那一侧的契约实现；`dsh-bridge/lib/*.js` 是
  运行时的桥接。**中间那层协议是这个仓库自己定的**，改它要同时改两边。

### 改之前先读

- [docs/FIELD-NOTES.md](./docs/FIELD-NOTES.md) — 四十余条真实缺陷（编号到 45，含 4 条
  `b`/`c` 补记）。里面有整整一类错误叫
  **静默降级**（把不知道的东西当成成功、把不支持的能力悄悄丢掉）。改动前先看一遍，
  避免重新发明这些 bug。
- [docs/ADOPTION.md](./docs/ADOPTION.md) 第 4 节 — 教训按主题归纳。

### 硬性约束

| 约束 | 原因 |
|---|---|
| **不要自造协议形状** | Paseo 自己的 Codex / Claude 适配器就是权威协议文档。提问卡和计划卡的形状必须和它一致，否则界面会以奇怪的方式坏掉 |
| **能力声明要和数据源一致** | 声明了什么，UI 就长成什么样。漏声明 = 功能消失（不报错）；过度声明 = 用户选了却被丢弃（更糟） |
| **失败要响亮** | 不认识的输入类型发 `request.failed`，不要发 `request.completed`；翻译不了的内容块抛错，不要跳过 |
| **取消是取消回合，不是杀进程** | 杀进程会连会话一起报废 |
| **不要硬编码某个人的 provider/model** | 这个仓库是给别人用的。路由从 profile 读，读不到就带说明失败 |
| **能复用的代码或逻辑，不要自己写** | 上游已经有的实现（DSH 的 `session.append` 表面替换、compaction 折叠、`dsh-rewind` 的 git 快照；Paseo 适配器已经验证过的形状）比我们现编的可靠，也免得下次上游一改就跟不上。复用前先核目标版本的 API 与语义（版本范围满足≠可运行），复用时把边界写进注释；确实没有可复用的，再自己写并在 `docs/` 留痕。 |
| **改了 `dsh-bridge/` 必须重生成内嵌桥** | `paseo-plugin/server/bridge-assets.ts` 是桥的 base64 内嵌副本，供插件自举 profile（Paseo 安装插件不跑脚本）。跑 `node paseo-plugin/scripts/generate-bridge-assets.mjs`（`npm publish` 的 `prepack` 也会跑），并提交生成结果 |

### 改完怎么验证

界面不可信，断言要打在协议层：

```bash
npx paseo-dsh doctor          # 一眼看安装是否完整：CLI/版本/profile/bridge/路由/key
node harness/catalog.mjs      # provider / 模型 / 每个模型的真实思考档位
node harness/probe.mjs        # 端到端提问往返
node harness/route-test.mjs   # 逐条路由跑真实回合
cd paseo-plugin && npx tsc --noEmit
```

**动了插件层（`paseo-plugin/server/*.ts`）就一定跑 `harness/plugin-check.cjs`**——
它断言的是事件形状，而事件形状错了界面不会报错，只会悄悄不对。运行步骤写在那个文件
的头部注释里（插件是 TS，要先编成 CJS 才能 require）。

同一条编译流程还带几个假 `dsh` 驱动的回归脚本，动到对应区域时一并跑：
`harness/subagent-check.cjs`（子会话可见性）、`harness/steer-check.cjs`（插话回执）、
`harness/mcp-injection-check.cjs`（Paseo 注入的 MCP server 是否真的落到 `--patch`）、
`harness/assistant-stream-check.cjs`（助手文本流式：同 id 增长快照、`id === messageId`、
经 Paseo 规则投影后合并成一行）、`harness/image-check.cjs`（图片工具结果：带 `hostPath` 的
图片块**恰好**多出一条 markdown `assistant_message`、路径逐段编码、无 `hostPath` 不出行、
过 `ProviderEventSchema`、`history: "replay"` 重建同一条）。

还有十个**离线**脚本，直接 require 编译产物、不需要 daemon（运行步骤写在各自头部注释里）。
下面清单里穿插的 `subagent-check.cjs` 归档用例与 `archive-registry-check.mjs` **不属于这十个**：
前者是假 `dsh` 驱动的，后者要真 profile。

- `harness/timeline-check.cjs` — `TimelineBuilder` 的工具行状态机：`tool/call` → `tool/result`、
  重复 `tool/call` 不能把完成行重置回 running 或清空输出、`turn/end`（含 `aborted`）要把仍
  running 的工具收成 `canceled`。**动了 `server/timeline.ts` 必跑。**
- `harness/newest-check.cjs` — `client/newest.ts` 的"哪一行是最新、该不该脉冲"：位置判定、
  提交批次（回放历史不闪）、窗口、交接、时钟。**动了客户端脉冲条件必跑。**
- `harness/tool-call-check.cjs` — `client/tool-call-data.ts` 的工具行映射（图标、命令、diff、
  截断）。**动了工具行渲染必跑。**
- `harness/thinking-check.cjs` — 思考行折叠预览：结束后取**第一行**、运行中取最后一个首行已终结
  的段落、标签恒为 `思考`（都是 DSH 的行为，逐字移植在 `client/thinking-text.ts`）。
  **动了思考行显示必跑。**
- `harness/subagent-check.cjs` 里另有归档用例：假桥的 replay 列表带一条 `archived: true` 的
  子会话，断言它**不被重放播报**（归档重启后必须仍然成立）；还断言归档往返本身——有打开的
  会话时代为转发、**没有**打开的会话时经一次性 probe 仍能往返、以及 registry 拒绝的 id 必须
  `request.failed`。**动了 `dsh-bridge/`、`replaySubagents()` 或 provider 的归档分支必跑。**
  但假桥证明不了"真实 profile 里到底有没有 `workspaceRegistry`"：改过桥的 bundle patch 或
  桥入口后，一定要在真 `dsh --profile paseo` 上跑一次 `harness/archive-registry-check.mjs`
  ——它把 `paseo/archive` 作为**第一帧**发（不发 `initialize`，和插件的一次性 probe 同形状），
  断言请求到达了真 registry。`@deepseek-ai/dsh-workspace` 只在 web bundle 里，缺了就是
  "composes no workspace registry"；桥入口漏等 profile 装载时则是**不发 initialize 就必现**。
- `harness/archived-lineage-check.mjs` — 纯模块离线检查（无需 profile/daemon）：桥里的
  `dsh-bridge/lib/archived-lineage.js` 必须逐字等价于 DSH 的 `underArchivedSession`——自身
  或任一 `origin:"subagent"` 祖先在 `archivedSessionIds` 即算已归档，fork 不继承、环路要终止。
  **动了这个模块、`listSessions` 的归档过滤或 `paseo/subagents` 的 `archived` 判定必跑。**
- `harness/image-host-path-check.mjs` — 纯模块离线检查（无需 profile/daemon）：桥里的
  `dsh-bridge/lib/image-host-path.js` 给 `tool/result` 的每个图片块**追加** `hostPath`，原有
  字段一个不动；attachments 缺失、`imageHostPath` 抛错（无效 ref 抛 `AttachmentError`）、
  返回非字符串、或事件不是 `tool/result` → **原样返回**。`historyEvents` 把同一规则用在
  `history()` 的重放投影上（`{type, seq?, time?, data}`）。**动了这个模块、桥的三处注入点或
  `history()` 的事件投影必跑。**
- `harness/sweep-check.cjs` — 原生扫光的几何：mask 曲线的停点、阶梯 alpha 的对称性与平铺、
  1.5s/0.3s/2-3 行程、`steps(48)`。**动了 `client/sweep-*.ts` 必跑。** iOS 上跑不了，这些
  数字就是"与 DSH 一致"的唯一凭据。
- `harness/style-check.cjs` — `client/tokens.ts` 的共享样式常量表（Phase 1 把工具行每个数值
  收进这里；13 还是 14、2×2 方块还是圆点、8% 还是 20% 底纹，漂移了在截图里都照样渲染，
  所以断言表本身，React 组件刻意不断言）。**动了 `client/tokens.ts` 或行样式必跑。**
- `harness/locale-check.cjs` — 客户端显示 locale 的纯函数解析链（`DSH_PASEO_LANG` 与
  `LANG`/`LC_ALL` 的优先级）和标签表覆盖：每个工具名在**两种语言**下都要有值，英文列是
  中文列的复制也要抓出来。**动了 `client/locale.ts` 或标签表必跑。**
- `harness/context-usage-check.cjs` — 用编译后的真实 `DshSession`、只替换进程传输，断言
  上下文占用的上报边界（打开会话上报已用量与容量、回合内合并更新、压缩后下降、未知容量
  清除旧值、无效计数拒绝、切模型时迟到的旧响应不能覆盖、关闭后不再发）。参数是编译输出
  目录：`node harness/context-usage-check.cjs <dir>`。**动了 `server/dsh-process.ts` 的用量
  读取或 `DshSession` 的用量上报必跑。**

离线清单之外还有四个容易被当成同类、其实不是的：`harness/tools.mjs`（真 `dsh` 的工具目录
转储）、`harness/subagent-live.mjs`（实机子会话可见性）、`harness/fake-dsh-bridge.mjs`
（上面几个假桥脚本共用的 scripted 替身，不是独立检查脚本），以及
`harness/session-calls.mjs`——**诊断工具，不是回归**：它读 `$DSH_HOME/sessions` 下的会话
日志，把每个 `tool/call` 的参数**键**与同一会话里 `request/header` 真正下发给模型的 schema
做 diff，报出未声明的键并以 `exit 1` 结束。用来回答"我到底发出去了什么"：界面和模型读到的
转写都是渲染，不能当证据。它刻意绕开两个坑——会话日志是**多帧** zstd
（`zlib.zstdDecompressSync` 只解第一帧，会把 1.6 MB 的会话读成 172 字节的头部），以及
**绝不静默跳过**解不开的文件。用法：`node harness/session-calls.mjs --list` /
`--latest` / `--session <id>`，可再加 `--tool <name>`、`--raw`。

客户端脉冲这条链最容易"看着对但静默失效"（`Animated` 在 RN Web 上只跑一段就停、`setValue`
推不到原生 view、客户端不折叠只改 `metadata` 的 item），所以断言要打在数据层。

**动了流式（`agent/assistant-stream` / `paseo/assistant-delta`）还要跑真实端到端**
`node harness/stream-probe.mjs`：它用真实 `dsh --profile paseo` 断言一步内出现多个
增长快照、且首个 delta 远早于 durable `assistant/message`。插件层的假桥检查只能证明
折叠，证明不了桥真的订阅到了 DSH 的瞬时帧。

**注意一个反直觉的坑**：`waitFor` 式的等待会匹配到上一条陈旧事件。换阶段时清空事件数组，
或按 `turnId` 过滤——有一次就是因为匹配到了被取消那一回合的事件，误判成"取消后对话
无法继续"，差点去改一段本来正确的代码。

### 提交前

- 跑一遍 `node --check` / `tsc --noEmit`
- 确认没有引入任何具体的 provider 名、模型 id、base URL、密钥
- 用户本机路径（`/Users/...`）不要出现在任何文件里
