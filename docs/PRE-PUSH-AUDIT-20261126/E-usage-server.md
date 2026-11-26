# E 用量服务端 审查报告
状态: completed
范围: paseo-plugin/server/usage-stats.ts（1391 行，新增）、paseo-plugin/shared/usage.ts（397 行，新增）、paseo-plugin/test/usage-stats.test.cjs（1054 行，新增）；提交 15bd058、666b756。方法：三文件全文通读，与 server/session.ts / first-token.ts 的数据形状对照，git show 两个提交，只读抽样核对本机真实 DSH 会话日志（~/.dsh/sessions，未写入），并用实际 `parseSessionJsonl`/`UsageStatsEngine` 在 /tmp 副本上验证（仓库零写入）。

## 摘要
- 通过项：RPC 契约（shared/usage.ts 的入/出参 schema）与服务端返回逐字段一致，测试对两个 RPC 结果跑 `usageStatsSchema/usageDailySchema.parse`；增量缓存主路径正确（mtime+size 判定、跨重启命中、同文件追加重解析、删除裁剪、缓存损坏重建、原子 tmp+rename）；666b756 的 active 前置与 finally 复位有效，异常返回路径不会永久卡 active（挂死 IO 除外，见 P3）。
- **1 个 P1（必须修）**：DSH v4 的 seeded（fork）子会话日志开头保存了父会话事件前缀，引擎只读首行判 `isSubagent`、不跳过继承前缀，父会话每条 `assistant/message` 用量在子文件里再算一遍。实测本机 9/3131 个文件为 seeded，继承 432 条带 usage 调用、78,297,052 tokens 被双计（其中 3 个是 `delegationDepth:0`，会污染 main 口径）；4 个真实文件副本跑引擎：应计 279 条，实计 597 条（+114%）。
- 2 个 P2：会话目录发现失败被当作“全部文件已删除”，清空并落盘空缓存；损坏/不可读文件静默计 0、无日志、RPC 不暴露。
- 4 个 P3：大目录冷扫与缓存全量重写、retry/attempt 与 compaction 用量口径遗漏（已量化）、挂死 IO 无超时、小项清理。
- 测试质量：真实行为断言（临时目录 + 真 zstd + schema.parse），边界覆盖较好，且已登记 `harness/offline-checks.cjs:55` 与 docs/HARNESS.md:86-93；但所有夹具头固定 `isSeeded:false`（test/usage-stats.test.cjs:54-65），seeded/fork 前缀无回归——这是 P1 漏网的直接原因。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P1 | usage-stats.ts:287-306（另 855-874） | seeded/fork 子会话的继承父事件前缀未被跳过：父会话 `assistant/message` 的 token/时间戳在子会话文件里被重复统计；`delegationDepth:0` 的 seeded 头还会把父用量算进 main、污染 scope 拆分与 53 周热力图。fork 再 fork 会叠乘。 | 代码：`if (isRecord(header) && header.type === "session") { isSubagent = ...; continue; }` 之后全文照常计数，文件内无任何 `isSeeded`/`session/end-seed` 处理（grep 仅命中注释）。DSH 依据：`dsh-session/fork.d.ts` 的 `buildForkSeed`（复制源事件前缀）+ v4 格式 `restoreReleasedV4Artifact` 用 `session/end-seed{inherited:true}` 校验继承切点；`childSessionMeta` 写 `isSeeded/origin/delegationDepth`。实测：真实 seeded 文件事件 seq≤切点为继承前缀、own 从 cut+1 开始；实际引擎跑 4 个真实文件副本 279→597 条。 | 首行为 `header.isSeeded:true` 时，取最后一个 `session/end-seed`（`data.inherited===true`）的 seq 作切点，只统计 seq>切点的事件；找不到切点的 seeded 文件按 corrupt 处理。同步升 `CACHE_VERSION`（usage-stats.ts:55）让旧缓存重算，并补 seeded 夹具回归。 |
| P2 | usage-stats.ts:564-570, 938-945, 979-984 | `discoverSessionFiles` 把 readdir 失败 catch 成空结果，与“空目录”不可区分；随后 prune 把全部缓存条目删掉并持久化空缓存。瞬时 EACCES/EIO/EMFILE/挂载点丢失即命中：面板用量归零、缓存被清、恢复后需全量冷重扫（本机 3131 文件/1.22GB 压缩）。 | `catch { return; }`（:566-570）后 `seen` 为空 → 删除全部 `entries`（:938-945）→ `cacheMutated` 触发 `persistDiskCache`（:979-984）。per-file `fs.stat` 失败同样被 `catch(() => null)` 静默跳过（:591-592），其缓存条目随后被当作删除剪掉。 | 发现阶段返回“失败”标志并与空目录区分：失败时跳过 prune 与 persist、stderr 报一次；stat 失败的文件保留旧缓存条目。 |
| P2 | usage-stats.ts:875-892, 962-963；shared/usage.ts:37-42 | 损坏/不可读会话文件被静默缓存为空：超过 10s 的老文件永久计 0 条用量，catch 无任何日志；`corrupt` 计数只存在于 `refresh()` 返回值，RPC 的 `indexing{active,done,total}` 与后台 prewarm（丢弃返回值）都不暴露。用户看到的总量少了却没有任何提示。 | `catch { ... return { entry: {mtimeMs,size,isSubagent:false,calls:[],corrupt:true}, corrupt:true } }` 全程无 stderr；`startBackgroundPrewarm` 的 `void this.refresh().catch(...)` 只处理异常、不消费报告；`usageIndexingSchema` 无 corrupt 字段。 | 至少 stderr 汇总记录 corrupt 文件数与路径（一次/轮）；建议 indexing 契约增加 corrupt 计数并在 UI 提示“N 个会话不可读”。 |
| P3 | usage-stats.ts:555-614, 830-853, 899-990 | 大目录成本：每个 stats/daily RPC 触发一次全目录 walk；任何文件变更都全量重写整份缓存 JSON；活跃会话每次追加都整文件重解压（本机单文件最大 23.3MB 压缩）。 | 实测：walk 3131 文件 80ms/次；本机 sessions 共 3131 文件、1.22GB 压缩（抽样均 400KB，解压约 4GB）；抽样估算 ~12.3 万条调用 → 缓存 JSON 约 18MB 每次变更全量 `JSON.stringify`+写（未实测）。 | 加最小刷新间隔/防抖；缓存分片或按文件增量写；对追加型文件支持 (mtime,size,offset) 增量解析；stats/daily 复用最近一次扫描结果。 |
| P3 | usage-stats.ts:236-241, 375-458 | 只计 `assistant/message`。DSH 自己的 `tokenUsage` 投影还计 `assistant/attempt` 流内 usage，并按 (turn,step) 替换去重（`llm/retry-started` 断开替换槽）。重试/取消空消息的用量漏计；`compaction/summary.usage`（另有 provider 调用）也未计。 | DSH 依据：`@deepseek-ai/dsh-token-meter` 的 `usageOf()/tokenUsageProjectionDefinition`。实测 180 个真实日志抽样：assistant/attempt 98 个、75 个带 usage chunk、183,518 tokens（≈0.01% tokens、≈1% 调用数）；compaction/summary 3 次均带 usage、1,419,262 tokens（相对非缓存输入 ≈3.5%，相对含缓存读取总 tokens ≈0.08%）。 | 按 DSH tokenUsage 语义补 `assistant/attempt` + `llm/retry-started` 去重；compaction usage 是否计入需产品确认（DSH 自身 usage 投影同样不含，属口径选择）。 |
| P3 | usage-stats.ts:200-233, 987-989 | 单文件无超时：`finally` 只覆盖 throw。若 `fs.readFile`/解压（或旧 Node 的 `zstd -d -c` 子进程）挂死不返回，`indexing.active` 永不复位，且 single-flight 让后续 RPC 永远只 race 旧快照、不再发起新扫描。 | `decompressZstdViaCli` 无 kill 定时器；`runRefresh` 的 `finally` 只在承诺结算后执行；`refresh()` 的 `activeRefresh` 未结算前 `prepareSnapshot` 只 race 不重启（:995-1009）。 | 给单文件读/解压加超时并计入 corrupt；或给整体 refresh 加 deadline 后强制复位。 |
| P3 | usage-stats.ts:85, 453, 652, 768, 878-881 | 小项：`CachedCallRecord.contextWindow` 只写不读（增大缓存体积）；`setPricer` 无调用方；`RECENT_CORRUPT_GRACE_MS` 用 `ageMs >= 0` 判断，mtime 在未来（时钟回拨）的瞬时读失败会被永久缓存为空。 | 字段生产者 :453/:652、测试断言 test:274，但聚合/RPC 无消费者；`setPricer` 全仓仅定义处；:879 `if (ageMs >= 0 && ageMs < RECENT_CORRUPT_GRACE_MS)`。 | 删未消费字段或接上 UI；补 mtime 未来分支（按“近期”重试）。 |

## 未验证项
- 全量冷扫真实耗时/CPU 与缓存实际体积：未在真实 `~/.dsh` 上跑引擎（避免写用户数据目录），仅按 180 文件抽样估算（单线程约 36s、缓存约 18MB），置信度中。
- 「挂死 IO 导致 indexing 永不复位」为静态推演，未做故障注入（P3）。
- RPC 入参校验依赖宿主 `server.handle` 按契约把输入解析为 `ZodOutput`（@getpaseo/plugin dist/server/contracts.d.ts；仓库内其他 RPC 同模式），未起真实 daemon 实测；出参由客户端 `callPluginRpc` parse，测试已对两个 RPC 输出跑 schema。
- 时间维度：53 周窗、跨年/跨月 bins、跨午夜过滤均静态推演正确并有部分测试（test:922-1054）；DST 仅静态推演（本地日历构造可自洽，国内无实际影响）。
- 本轮未运行任何测试（任务约束；Lead 已跑 `tsc --noEmit`），引擎行为验证均为 /tmp 副本手工驱动。
