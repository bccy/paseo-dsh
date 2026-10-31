# dsh-bridge 全量审查（2026-10-31，供主编复核）

基线：`9298c28`。本机读取的 DSH 安装为 `0.2.1-rc.5`。范围是 `dsh-bridge/` 的 18 个 lib 模块、package 和 Cordis patch；交叉阅读了相关 plugin 消费者、harness、FIELD-NOTES 撤回/多会话/MCP 部分、2026-10-20 与 2026-10-29 审查、P003 设计/裁决/排除项。

本轮未改产品、Git、profile、凭据或已安装包，未重启、未调用模型，未对外提 issue。新增验证仅使用真实产品模块 + 合成服务 + 私有临时文件 + loopback HTTP。**复现成立不等于验证了真机 UI；真机后续门禁单列。**

## 结论

- 建议保留 direct-provider 插件这条交付路径，保留 DSH 原生 profile、agent、session、approval 等实现的复用；当前收益真实存在，尤其是 Paseo 移动端统一界面和会话语义。
- 不能据此认为当前内部实现已经最优。桥包含了自有文件恢复事务、MCP 客户端、会话编排、血缘推断和展示投影，维护成本已明显超过“协议翻译”。应先把文件撤回正确性和 MCP 取消/结果保真补齐，再收窄内部 API 接触面。
- 本轮确认 **2 个 P1 + 6 个 P2**。最重要的两个均为“返回成功但文件没有回到应有状态”，是既有断言未覆盖的生命周期组合，不是已有测试失败。

## 可复跑证据

```bash
python3 docs/audits/20261031/reproductions/run.py --case bridge
```

输出保存在 `test-results.json`。脚本会在审查 scratch 内建私有目录，最后删除全部样本文件；图片缓存探针的 `TMPDIR` 只对独立子进程生效，不会碰正常 UID 缓存。运行结果 exit 0 表示 **8 个断言确认当前缺陷能够复现**，不是“产品修复通过”。

### BR-01 · P1 · 文件恢复顺序跨进程重置，撤回恢复成中间版本

**状态：真实 FileSnapshots 模块、真实私有文件已复现。**

- 位置：`dsh-bridge/lib/file-snapshots.js:232`（`#captureSequence = 0`）、`:304`（捕获时递增）、`:476-486`（恢复只按 `captureSeq` 比大小）。
- 触发：同一会话在一次 bridge 生命周期内已有编辑记录；daemon/plugin/bridge 重启后继续编辑同一路径，再撤到重启前的消息。持久 journal 没清空，内存计数器却归零。
- 证据：第一实例的目标文件捕获序号 2、备份 `ORIGINAL`；第二实例捕获序号 1、备份 `AFTER_FIRST_EDIT`。撤到旧消息时选中序号 1，实际恢复 `AFTER_FIRST_EDIT`，`restored` 仍报告 1 条成功。
- 影响：文件内容恢复错误；用户看到成功回执而无失败项。恢复前 rescue 只保存最新工作内容，不会纠正选错的 pre-image。
- 修法方向：将排序身份改为**同一 root journal 跨进程单调、持久可比较**的序号。可在拥有会话写租约时，从该 journal 的高水位初始化一次，再给所有 root/child 捕获分配序号；初始化和并发捕获需串行化。不要只增加时间戳后按 wall clock 排序，也不要直接按 commit 顺序替换（已覆盖的并行父/子逆序提交会回归）。已有旧 journal 中发生过重置的次序并不能凭现有字段完整重建，需保留对象和原始 journal，并明确迁移/人工恢复边界。
- 门禁：同一持久 journal 的两个实例/两个进程；重启前后同文件多次写；不同文件交错；父子捕获顺序与提交顺序相反；legacy 无 `captureSeq` 数据；恢复后再编辑再撤。
- 历史关系：原 `harness/file-snapshot-check.mjs:272-288` 检查单实例并行捕获先后，缺跨实例持久性检查。不是已记录的 rescue 文件名跨进程时钟问题。

### BR-02 · P1 · 文件计划形成过早，漏掉尚在执行的子代理编辑并清掉恢复索引

**状态：真实 PaseoHarnessServer.revert + 真实 FileSnapshots，合成精确异步时序已复现。**

- 位置：`dsh-bridge/lib/server.js:2207`（先读文件计划）、`:2260`（等待 flush）、`:2273-2276`（之后才取消/等待 child 并用旧计划恢复）、`:2286-2294`（prune/trim/GC）。
- 精确顺序：
  1. root 文件的 capture/commit 已完成；另一个 child 文件 capture 已完成，tool 尚未 commit。
  2. root 空闲；`revert(both)` 只 settle root，随后 `planRestore` 只得到 root 文件。
  3. `session.append(marker)` 后等待 `sessions.flush`；独立 child 在这个允许的窗口完成文件写入和 journal commit。
  4. flush 成功；bridge 确实 interrupt child，并成功等到 child 已结束。
  5. 用第 2 步的旧计划恢复 root 文件；遗漏 child 新文件；prune/trim 随后清掉 child 刚提交的 journal 行。
- 证据：回执 `kind:"success"`；root 文件 restored 1；应删除的 child 文件仍是 `CHILD_LATE_WRITE`；deleted 0；剩余 journal 行数 0；interrupt 记录包含 child。
- 影响：用户撤回覆盖的子任务写入仍保留，且自动恢复索引被清走。
- **不是历史已接受的 3 秒 timeout 边界**：本例 child 在 interrupt/join 时已经完全结束，没有任何“恢复之后又写”的行为，仍必然漏恢复。
- 修法方向：明确分阶段事务。先验证令牌与操作可行性；建立该 root 的撤回 barrier，限制新 prompt、派生和被撤子任务的编辑接入；等待 root 与相关被撤 child 的执行/快照 commit 队列收敛；在冻结点重新计算 surface 和文件计划，再 append/flush 与恢复。或者保留“flush 前不取消 child”的产品约束，但必须在 flush 后子任务收敛后**重新生成最终文件计划**，处理此时读 journal 失败的“对话已撤、文件未撤”回执，且只对实际已处理的范围清理恢复索引。不能仅移动一行 `planRestore` 而没有失败/并发策略。
- 门禁：child 在 plan/append/flush/interrupt/join/restore 各边界完成写入；已有文件和新建文件；pending capture 与提交队列；join timeout；未被撤的旧 child 不被取消；失败路径保留 journal；两个独立 root 不互相阻塞。
- 历史关系：FIELD-NOTES #59–62 已处理“子编辑归并”“按派发锚取消”，但现有 `rewind-merge` 及 e2e 用例没有冻结计划期间提交这一组合。

### BR-03 · P2 · 孙任务归属取根会话最新消息，误归到后来无关回合

**状态：真实 observeDelegatedTurn/ChildAnchors 纯对象场景已复现。**

- 位置：`dsh-bridge/lib/server.js:1819-1830`，尤以 `latestHumanAnchor(root)`；后续消费者 `snapshotAnchorFor`、`cancelWithdrawnDelegations`。
- 触发：root 消息 10 派出的 child 仍在后台运行；root 又收到无关消息 20；旧 child 此时派出 grandchild。grandchild 的 header 正确指向 child，但桥把其 anchor 记成根的最新 20。
- 证据：parent 的已知派发锚是 10，grandchild 被记录成 20；`withdrawnSince(20, root)` 只选中 grandchild。
- 影响：撤消息 20 会取消本应属于消息 10 的孙任务，并可能回退其文件，违反“旧指令的子任务继续运行”的策略。
- 修法方向：优先复用直接父任务当前 activation 的持久派发来源/已知 anchor；只在直接父为 root 且已证实本次派发归属时读根消息。多级血缘保留 root + dispatch/activation 标识；来源无法证明则 fail open 并给诊断，不能把“最新”当来源。
- 门禁：老 child 运行期间根收新消息再派孙；父 child 由新根回合续接后派孙；同 root 两个并发 child；缺祖先；环；两 root。
- 历史关系：现有测试验证 root/seq 不串台与 turn-start 刷锚，没有验证多级异步派发的因果关系。

### BR-04 · P2 · 恢复只防最后一个路径组件的 symlink，祖先目录仍可重定向写入

**状态：真实 FileSnapshots 私有目录已复现。**

- 位置：`dsh-bridge/lib/file-snapshots.js:521`、`:543-550`；注释 `:506-508` 的保证比实现强。
- 触发：`workspace/file` 被正常捕获后，`workspace` 被移动并换成指向另一目录的符号链接；另一目录存在同名普通文件。
- 证据：`lstat(workspace/file)` 看到的是符号链接父目录下的普通文件，恢复把另一个目录的 `UNRELATED_OUTSIDE_FILE` 改成 `WORKSPACE_ORIGINAL`，报 restored 1、skipped 0。
- 影响：恢复写到捕获时不是同一个对象的位置。这里只验证了私有同用户文件，不声称本机已遭利用或具有 OS 越权。
- 修法方向：记录并复核捕获时的 canonical path/父目录身份，对中间 symlink 变化拒绝恢复；最终文件使用不跟随链接的打开方式。要宣称抵抗并发恶意路径替换，则需目录句柄相对操作/相应原生能力，不能再用单次 `lstat` 充当完整边界。拒绝时保留备份和 journal。
- 门禁：末端链接、祖先链接、新建路径父目录变化、目录替换、普通合法目录、出现拒绝后对象和 journal 保留。
- 历史关系：已有 `file-snapshot-check` 只覆盖末端 symlink (`:298-314`)；本项是不同路径层级。

### BR-05 · P2 · 排队的 build/plan-off 意图恢复时被丢弃

**状态：真实 bridge.createSession + 合成 DSH resume seam 已复现；插件打开顺序由 server lane 复核。**

- 位置：`dsh-bridge/lib/server.js:3329-3333`。
- 触发：持久会话已有 `plan/mode active:true`；Paseo open 选 build。`DshSession.open()` 先 `setPlan(false)`，此时 bridge 尚未物化 agent；之后 loadCommands 触发 resume。
- 证据：`planSet` 回 `{active:false,outcome:"queued"}`；createSession 取出 false 并删除，只有 wanted true 才调用 set；恢复后实际 active 仍 true，set 调用 0 次。DSH rc.5 `dsh-plan-mode/lib/index.js:343-395` 明确从持久 projection 读 active，需 `set(agent,false)` 才写回。
- 修法：存在 queued intent 时 `planMode.set(handle.agent,wanted)`，覆盖 true 和 false；异常不能把 agent 已发为 ready 却丢掉未应用意图。是否要接受 DSH pending 的 `false` 另需核双向契约，不能只把 pending 布尔解释为“有无”。
- 门禁：新/恢复会话 × plan/build；持久 plan=true/false；已有 open turn 的 pending=false；服务缺失；同进程两会话。

### BR-06 · P2 · MCP gateway 丢弃执行的 AbortSignal

**状态：真实 gateway 注册函数 + loopback 延迟 HTTP，取消已复现；stdio 静态同样缺调用者 signal。**

- 位置：`dsh-bridge/lib/mcp-gateway.js:547-550`（`execute(args)` 未接 exec）、`mcp-http.js:130-163`（只有内部 timeout controller）、`mcp-stdio.js:269-289`（pending 只有 timeout）。三个元工具均未传播 execution signal。
- 证据：tools/call 到达本地 server 后取消 exec.signal；HTTP 连接未取消，gateway 等待并成功返回 `SIDE_EFFECT_COMPLETED`。原生 DSH MCP client `lib/index.js:140-147` 明确向 callTool 传 `execution.signal`，图片 admission 前还检查取消。
- 影响：用户取消回合后已在执行的 MCP 调用继续等待，可能继续完成远端动作；结果若含图片还会继续本地落盘。不能保证任意 MCP 服务能撤销已执行动作，但本实现连请求放弃/取消协商都没做。
- 修法：贯穿 exec.signal；HTTP 合并调用者取消与 timeout；stdio 撤销自身 pending 并按 MCP 协议发取消通知，不能用杀进程代替取消；共享初始化请求的一个 caller 取消不应连带其他 caller；图片写入前再次检查 abort。
- 门禁：请求发出前取消、握手期间取消、调用中取消、完成后晚取消；两并发调用只取消一个；超时与取消分类；stdio 不退出且后续调用仍可用；取消后不写图片。

### BR-07 · P2 · MCP structuredContent 被丢弃为“成功空内容”

**状态：真实 gateway + 合法合成 MCP result 已复现。**

- 位置：`dsh-bridge/lib/mcp-gateway.js:567-568`，输出 schema 也无 structuredContent。
- 触发：服务返回 `{content:[],structuredContent:{answer:42}}`，或文本之外还带有重要结构字段。
- 证据：gateway 返回 `{server:"fake",tool:"structured",content:"",images:[]}`；42 完全消失。该结果有合法 result 对象，所以“no result object”守卫抓不到。
- 影响：模型认为调用成功却拿不到主要结果；接收附加 MCP server 时是一种能力退化。原生 DSH client `lib/index.js:196-239` 为 structuredContent 建 schema 并保留原值。
- 修法：输出 schema 保留结构化结果；无可用文本时提供 JSON 文本投影；同时检查目标 tool 的 outputSchema / execution.taskSupport 等语义，避免把任务式结果当普通结果。不要让额外字段只是进入日志却仍然不进入模型可见输出。
- 门禁：纯文本、纯结构、混合、图片+结构、isError、空对象、错误 schema；重放保留等价语义。

### BR-08 · P2 · 图片临时缓存没有验证目录归属，staging 会跟随预置 symlink

**状态：在独立 TMPDIR 内真实 hostImagePath 已复现。**

- 位置：`dsh-bridge/lib/image-host-path.js:91`（可预测 UID 目录）、`:123`（PID staging 名）、`:130-142`（先复用再 mkdir；copyFileSync 写 staging）。
- 触发：另一用户先占据共享临时目录中的固定 UID 名，或已有目录不再是预期私有目录，并在可预测 staging 名处放 symlink。
- 证据：私有模拟目录预置 `digest.jpg.<pid>.tmp -> victim`；`hostImagePath` 把 victim 的 `KEEP_ME` 改成 `ATTACHMENT_BYTES` 并返回 jpg。`mkdir({recursive:true,mode:0700})` 不验证/修复已存在目录的 owner 或 mode，`rename` 保护的是 target，不保护写 staging 时的 symlink。
- 影响：在此前提下可误写其他同权限文件，或者错误复用攻击者的同尺寸图片。没有声称当前部署是多用户或正在被利用。
- 修法：使用受控私有 cache root；lstat/owner/mode 校验放在任何复用之前；staging 使用随机排他创建/不跟随链接；检查已有 target 为真实文件。保持同一附件的稳定最终路径以免 replay 多出图片行。
- 门禁：安全新目录、既存他人目录/宽权限目录、目录链接、target链接、staging链接、同尺寸替换、正常复用、失败后不丢工具结果。

## 不应重复登记为新缺陷的边界

- `files`-only 撤回未声明：P003 明确有意排除，不能为了补菜单声称已支持。
- 记忆插件可能召回被撤内容、bash/pwsh/外部编辑和大文件不被恢复：已有边界；但产品文案应避免将编辑工具级完整文件恢复描述为“只撤 AI 的改动”，它不能区分同文件上的后续人工 edits。
- 子代理审批不走根卡片：P003 已明确在宿主只读子通道下保持未批准，非本轮新增。
- root+seq 隔离、同 callId 的 pending identity、非首条消息守卫、先 flush 再宣告成功、compaction 不折叠：当前代码保持了这些修复，不应回退。
- HTTP SSE 先 `response.text()` 等 EOF：2026-10-29 已登记暂缓，不当作新发现；真实长连接服务仍需流式消费门禁。
- alpha 的 retained-projection 改动不能自动推导 `snapshot()` 已不兼容。主代理已核 alpha d.ts，`snapshot/stateOf` 仍同步；因此不登记“P003 snapshot async 已坏”。

## 改进方向与阶段

1. **先完成撤回事务与 durable journal 的正确性闭环。** 单列恢复子系统的职责、序号模型、freeze/commit/cleanup 状态、部分失败和人工恢复方案。把 BR-01/02 的组合测试纳入必跑；恢复正确之前避免扩展撤回范围。
2. **MCP gateway 应是工具发现优化层，不应再自有整套残缺传输语义。** 保留 lazy schema 节省上下文的产品价值；评估构建时 bundle 成熟 MCP client 或受支持的 DSH 封装，保持“安装不跑脚本”。如果继续手写，必须补 signal、structured output、版本协商与通用 server-request 处理；“内嵌 base64”本身不意味着永远不能打包依赖。
3. **内部 API 通过窄适配面接触。** 将 agent create/resume、投影、model selection、permission、文件 journal 分成边界清晰模块；消费者依赖桥的 versioned shape，而非同时知道几十个 ctx 服务的具体时机。DSH API 存在性检查以外增加少量行为合同：恢复状态、取消、scope disposal、持久序号。
4. **区分进程级与会话级资源预算。** 当前 bridge 输入 `#partial`、stdio readline、HTTP `response.text` 无字节上限；live session/event 订阅不提前过滤内部事件。这是规模/异常输入风险，未在生产测出 OOM，不虚报事故。应设可测上限、拒绝路径、流式解析/背压，再根据实测决定进程分池，而非继续无限共享。
5. **减少状态猜测。** 以派发/activation 元数据取代“根最新消息”因果推断；以真实 unavailable/unknown 取代 catalog/skills 任意 catch 后的空值。允许缺服务时合理降级，但诊断需说明缺哪部分。
6. **文件操作和缓存守卫以实际对象为准。** 从“字符串 path + lstat 最后组件”提升为捕获/恢复对象身份契约。把用户可见的恢复完成度与未追踪文件持久记录起来；仅 stderr 一次告警不能证明下次重开时仍知道这个缺口。

## 覆盖清单

| 文件 | 阅读/对账焦点 | 验证/结论 |
| --- | --- | --- |
| `lib/index.js` | loader ready、stdio life、question/approval waterfall、file hooks | 无新增阻断；低层 timeout/dispose 仍需行为门 |
| `lib/server.js` | 全部 request handler、create/close/shutdown、per-session maps、history、child、revert、P003 | BR-02/03/05；P003 snapshot async 候选经主编核实撤回 |
| `lib/transport.js` | NDJSON、双向 id、abort、EOF、flush | 线性扫描已修；输入上限/输出失败与背压为风险项 |
| `lib/approval.js` | ownership、single allow、timeout、cancel | 与原生 waterfall 一致；child 不抢根审批为有意边界 |
| `lib/session-projections.js` | live/cold/controller/migration/dispose | 不复活 agent；保留三种结果语义 |
| `lib/paseo-system-envelope.js` | legacy/versioned/user-wrapper/source | 依赖 Paseo parser 契约，需版本行为对照；无新增确认问题 |
| `lib/archived-lineage.js` | root/subagent/fork/cycle | 既有纯函数合同保留 |
| `lib/subagent-archive.js` | scope、registry、active skip、partial error | 既有 archive 语义；列表到写入间状态变化为残余竞态，未单列缺陷 |
| `lib/child-anchors.js` | root+seq scope、delete | 纯存储正确；调用者因果问题 BR-03 |
| `lib/delegated-cancel.js` | cancel policy、scoped view、error | server 确实绑定 root；没有跨 root 扫描回归 |
| `lib/snapshot-owners.js` | delegated ancestry、pending key | 归并/失联 fail-open 有意；因果来源不能只靠 root |
| `lib/file-snapshots.js` | capture/commit/order、restore/rescue、prune/trim/GC | BR-01/04；BR-02 跨 server 生命周期 |
| `lib/revert.js` | token、首条、surface、scope | 既有原则保留；files-only 有意不支持 |
| `lib/surface.js` | rewind vs compaction、seq preservation | 保留正确语义；大量 rewind 的 span Set 有规模成本，未测出线上问题 |
| `lib/image-host-path.js` | image projection/cache、history whitelist | BR-08；history 保留 seq，过滤后不破 inherited seq 边界 |
| `lib/mcp-gateway.js` | definition/schema/client lifetime、result mapping、images | BR-06/07；normalization/pathSegment 守卫保留 |
| `lib/mcp-http.js` | handshake/session epoch/cache、SSE/errors/timeout | BR-06；SSE EOF 是既有项；响应错误 body 尚无通用脱敏机制（待专项） |
| `lib/mcp-stdio.js` | lazy spawn、env、pending、cache、exit/dispose | BR-06；使用 scrubbedParentEnv、死进程拒绝缓存已有修复 |
| `package.json` | exports、profile依赖、可分发边界 | 依赖内部 package 稳定性是长期成本，交由主编能力矩阵 |
| `cordis.patch.yml` | prompt variable、ask-user/workspace、禁 stdout/HMR | 当前正确；升版须验证实际 composition，而非只看文件存在 |

## 复现与真机验证的边界

8 个复现均可重复、均不调用模型。BR-01/04/08 是真实文件系统行为；BR-06/07 是真实网关对 loopback MCP；BR-02/03/05 是真实桥逻辑配合明确的合成服务时序。相应真实 DSH turn、Paseo UI、取消后服务行为、各平台文件系统和真实 profile 重启仍应在后续修复验收里跑，不从这些探针夸大推出“真机全验”。

适用顺序：修 BR-01/02 并扩展负向回归 → 重生成内嵌桥 → bridge-assets-check → 相关离线与假桥门 → 隔离真 profile 的模型/父子/恢复测试 → 用户真实移动端与原版/补丁宿主验收 → 再考虑发布。当前审查只交付方案，未执行这一修复/发布流程。
