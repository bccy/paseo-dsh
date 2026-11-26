# A 契约与接线 审查报告
状态: completed
范围: origin/main..HEAD 中 paseo-plugin/index.server.ts、index.client.tsx、server/provider.ts、shared/{diagnostics,usage,pricing,subagent-live}.ts 的导出面与接线；usage/pricing 只核签名与返回形状（内部逻辑归 E/B 块）。方法：git diff + 全文阅读 + node 静态契约对账；未起宿主、未跑构建（只读约束）。

## 摘要
- RPC 契约已闭环：shared 下 19 个 defineRpc/defineSubscription 全部有 server.handle 注册（含本次新增 pricing×3 / usage×2 / diagnostics×2 / subagent.live×1），client 侧 14 个 rpc/subscribe 消费点全部有对应注册；上一批"usage/diagnostics 客户端可见性死代码"已消除（index.client.tsx:30-38、450-522 已接线 console-screen 与 ConsoleDiagnosticsSection）。
- index.server.ts 对 pricing/usage/diagnostics 的接线与模块真实导出签名/返回类型一致：`new DiagnosticsService()`、`registerDiagnosticsRpc(server,svc,{onCall})`、`new PricingStore()`、`new UsageStatsEngine({pricer:pricingStore})`、`registerPricingRpc(...,{getSeenModels,getConfiguredModels,startAutoSync,autoSyncDelayMs,onContext})`、`registerUsageStatsRpc(...,{startPrewarm,prewarmDelayMs,onContext})` 均与 server/*.ts 声明匹配；返回形状即各自 shared schema 推断类型（tsc 已绿由 Lead 跑过）。
- 新增 RPC handler 不吞未知输入、不把失败伪装成 completed：入参由 defineRpc 契约交给宿主校验（@getpaseo/plugin dist/server/contracts.d.ts:43-44，handler 参数为 ZodOutput<InputSchema>），handler 抛错交由宿主 request.failed；未发现 catch 后返回成功的路径（唯一静默点在 P2 行）。
- provider.ts 本批 +88 行全部是 subagent 活订阅与 session 建连挂钩，capability/catalog 无变更：不新增协议能力位，未发现漏声明（功能静默消失）或过度声明（用户选了被丢弃）。
- shared/diagnostics.ts 为单一来源：client（console-diagnostics.tsx）与 server（diagnostics.ts）均 import 同一套 zod/类型；未发现重复定义，且 schema 无凭据明文/原始 baseURL 字段（baseUrlHost、apiKeyEnv 为脱敏名）。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | paseo-plugin/index.server.ts:130-158 | `getConfiguredModels` 全包 catch 返回空 Map，把诊断失败变成"成功且没有配置模型"：pricing.get/update/sync 都会静默丢掉 profile 中已配置、但本地未用过且无参考定价的模型，定价表里无法再为其设价，且无日志/错误态 | `} catch { return new Map<string, string>(); }`（155-157）；registerPricingRpc 内层同样静默（server/pricing.ts:802-808）；客户端以 `row.configured`/`row.seenLocally`/`row.custom` 三者任一决定是否展示（client/console-pricing.tsx:94-96） | catch 至少写一次 stderr；把"配置模型不可用"作为显式字段返回或回退到上次成功清单，不要当空集 |
| P3 | paseo-plugin/index.server.ts:130-135 | 每个定价 RPC 都 await 一次完整 `diagnostics.overview()`：扫描 profile/bridge/凭据，版本缓存 miss 时还兜底 `dsh --version`（有界 3s）；Tab1 首帧与每次改币种/汇率都被诊断 I/O 阻塞（幅度未实测） | `await Promise.all([diagnostics.overview(), pricingStore.resolver()])`；overview 实现 diagnostics.ts:834-859；版本探测兜底 diagnostics.ts:778-800（VERSION_PROBE_TIMEOUT_MS=3_000，:45） | 抽出轻量"profile 模型清单"读取或按 profile mtime 缓存，定价 UI 不应等一次诊断扫描 |
| P3 | paseo-plugin/server/provider.ts:3414-3425 | `safePushSubagentEvent` 的同步 try/catch 接不住 `context.push()` 的 Promise 拒绝：push 在 SDK 中是 `Promise<void>`，投递失败会变成插件进程的未处理拒绝（而非被吞掉） | `try { subscriber.push(event); } catch { /* ignore closed subscription stream */ }`（3420-3424）；SubagentSubscriber.push 类型被写成 `(event) => void`（3409）；实际实参 `(event) => context.push(event)`（index.server.ts:227）；SDK 声明 dist/server/contracts.d.ts:19 | 改为 `void subscriber.push(event)?.catch(...)` 或捕获后记日志，避免 unhandledRejection |
| P3 | paseo-plugin/shared/usage.ts:17-23,33-35 | 单一来源缺失：汇率默认值与币种枚举在 shared/usage.ts 与 shared/pricing.ts:21,34 各存一份，client console-settings.tsx:37 还有第三份 7.2；`USAGE_MAX_TPS=3000` 注释称与 server/session.ts 一致，但后者硬编码 3000（session.ts:3874）未互链。另有 `UsagePricer/UsagePriceResult/UsageTokenInput` 在 usage.ts:247-303 再定义一套（镜像 PricingResolver） | 见左；usage.ts:249-303 注释自称"结构等价、有意复制"；pricing.ts 同样零 Node 依赖，client console-usage.tsx:22 已同时引入 shared/pricing → "保持 usage 无依赖"不构成理由 | 让 usage.ts 复用 pricing.ts 的常量/枚举（或由 pricing 导出 wire 子集），TPS 阈值提为共享常量或加测试锁定两处相等 |
| P3 | paseo-plugin/index.client.tsx:136 | 宿主 locale 只在启动采样一次（`adoptHostLocale(client.i18n?.locale)`），未订阅 SDK 提供的 `client.i18n.subscribe`；运行时在 Paseo 里切语言后 console 文案/注册标题要等重载或 tool-call relay 才跟变（未验证 relay 是否足够及时） | index.client.tsx:136；locale.ts:2546-2551；@getpaseo/plugin dist/client/translations.d.ts（PluginLocaleSource.subscribe） | 订阅 client.i18n 变更并驱动 adoptHostLocale（或接入 SDK 的 PluginText/i18n.t） |

## 未验证项
1. 高：registerWithLiveTitle 对"已打开 screen"执行 remove+re-add 的真实宿主行为（是否卸载界面、丢当前 Tab/未保存输入）。harness/timeline-kind-check.cjs:66 把 registerWithLiveTitle stub 成直接注册，该路径零覆盖；验证：真机在 Console 打开时改语言，观察界面是否被重置——若会卸载则升 P2。（index.client.tsx:497-518，settings-screen.tsx:1147-1172）
2. 中：宿主的 `context.push` 是否真的会 reject（决定 P3-provider 行是否升 P1：插件进程 unhandledRejection 可导致所有 DSH 会话进程退出）。验证：真机 kill 订阅后观察插件 stderr/进程存活。
3. 中：pricing RPC 因 await overview 的实际延迟未实测（首帧/每次保存）。验证：真机 DevTools 计时或临时在 handler 记时。
4. 低：`usageEngine.seenPricingModels({waitMs:0})` 在索引未完成时返回部分清单，PricingDialog 仅在打开时拉一次，可能出现"已连接"过滤器暂时缺行；需要真机在 daemon 刚启动时打开定价弹窗确认是否可见/是否自愈。

status: completed
