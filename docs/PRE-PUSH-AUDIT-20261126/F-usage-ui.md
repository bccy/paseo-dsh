# F 用量 UI 审查报告

状态: completed
范围: `paseo-plugin/client/console-usage.tsx`（2455 行）、`paseo-plugin/client/console-heatmap.tsx`（843 行），对照 `paseo-plugin/shared/usage.ts`（RPC 契约）与 `paseo-plugin/server/usage-stats.ts`（返回口径）只核消费面。方法：全文只读 + `git show`；未跑构建（Lead 已跑 tsc 全绿作基线），未真机。

## 摘要

- 结论：**F 块无 P0/P1**。数据流三态、异步守卫、热力图日历边界、RPC 契约与 shared 定义一致，派生指标与 server 同源，未发现静默把失败当成功、越界渲染或契约漂移。
- 通过项：①error 有显式 UI（首载 Callout+Retry，已有数据时行内红字；daily 错误在热力图内可见文本），empty 有文案+清除筛选按钮，索引中顶部有进度 banner，60s/1.2s 自动重试；②热力图把 `"YYYY-MM-DD"` 化为 UTC 日序（`console-heatmap.tsx:124-146`），规避 daemon/客户端时区与 DST，周起始按 locale（`console-format.ts:393-395`，en 周日 / zh 周一），未来格置 null、上限 53 周、窄屏减列保 ≥12px，0 值单列色阶，quartile 边界为 `>=max→4`，无除法/NaN 风险；③双 `seq` + `mountedRef` 守卫，轮询自排队串行、卸载取消，过期响应不覆盖新状态；④KPI/图表/bins 全部复用 `shared/usage.ts:382-397` 的 `deriveUsageMetrics`，与 server sparklines/models 同函数同口径，除零以 null 表示并显示 "—"，未定价成本为 null 非 0；⑤`dsh.usage.stats`/`dsh.usage.daily` 方法名与 range/scope/provider/model/currency 参数和 strict schema 一致；模型筛选传 `provider/model` 复合 id，server `matchesModelFilter` 两种格式都接受（`usage-stats.ts:551-553`）；⑥两语文案表由 TS interface 强制完整，无硬编码 UI 句子，颜色均取 theme token，仅 `shadowColor:"#000"` 与仓库既有 `Card` 约定一致；⑦无凭据/本机路径/base URL/provider 硬编码，无 TODO/console.log/@ts-ignore。

## 问题

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | `client/console-usage.tsx:1774-1784`（对照 `client/console-screen.tsx:252-258,267-292`） | 币种切换自行发 `dsh.pricing.update` 且静默吞错，未复用 parent 已有的持久化+错误通道。失败时本地与父级都已被乐观改成新币种、服务端仍为旧值，无任何提示；下次挂载或 Settings 再改汇率时，`pricingUpdateRpc` 返回的持久值把币种弹回旧值——用户设置静默丢失。 | `void client.rpc(pricingUpdateRpc,{displayCurrency:next}).catch(()=>{/* Keep local override active gracefully */})`；parent 的 `handleUsageCurrencyChange` 只改内存不持久化，而 `handleSettingsCurrencyChange` 才有 `pricingError/seq/pricingRevision`。 | 把持久化下放给 parent（传入 async handler，失败时展示 `pricingError` 并回滚 `localCurrency`），或在 catch 里上抛可见错误。 |
| P3 | `client/console-heatmap.tsx:199-298,489-495,786-838`；`client/console-usage.tsx:1643,2265-2273` | 首帧 loading 被按“空数据”渲染：`daily===null` 时 `buildCalendar` 用 `todayNumber()` 造 365~371 个 level-0 格，摘要显示活跃天数 0、连续 0 天、峰值 "—"，组件无 loading 入参/占位，与“近一年无活动”不可区分（首次 RPC 最长等 server `rpcWaitMs=250`，`usage-stats.ts:59`；冷索引靠顶部 banner 兜底，但首帧前无任何加载提示）。 | `const calendar = useMemo(() => buildCalendar(data, weeks, locale), …)`；`heading = data ? … : copy.title`；`activeDays>0 ? tokens(average) : "—"`。 | `data===null && !error` 时渲染骨架或“正在加载用量…”，摘要不渲染 0 值。 |
| P3 | `client/console-usage.tsx:1697-1700,2311-2317`；热力图同源 `2265-2273` | 筛选切换时 RPC 失败后保留旧快照：catch 只 `setStatsError`，不清 stats/不重新 dim；旧筛选数据继续以**新**筛选语义展示（provider/model chip 已切换），仅一行 caption 级红字，易被读成当前筛选结果。 | `setStatsError(...)` 后 `stats` 原样；容器 `opacity: statsTransitioning && stats !== null ? 0.6 : 1` 在失败后回到 1。 | 失败且 stats 非空时保持 dim 或加“显示的是上次成功结果”标识；daily 同理。 |
| P3 | `client/console-usage.tsx:417-446`（对照 `server/usage-stats.ts:467-503`、`client/console-format.ts:298-316`） | 图表桶按 **daemon 本地日历**生成，但刻度/日期标签用**设备时区**格式化：远端宿主与手机时区不同（偏移非 6h 倍数）时，today/7d 的 6h 刻度可能整排消失（`shouldShowTick` 判 `getHours()===0` / `%6===0`），30d 的日桶标签可能错一天，`windowLabel` 的“今天 00:00”同理；同一 tab 内热力图用日序规避、两者口径不一致。**未验证**（需跨时区真机）。 | `if (binMs >= 6*3_600_000) return date.getHours() === 0;` / `return date.getHours() % 6 === 0;` | 桶标签按 server 时区渲染，或刻度改按索引取整（today 24 等分）。 |
| P3 | `client/console-usage.tsx:1065-1066,1534-1604`（对照 `server/usage-stats.ts:1137-1153`） | 模型筛选激活时“合计”行仍汇总**全部模型**（server 的 models 列表在 model filter 之前生成），而 KPI/图表/热力图是筛选后的 → 同屏两套总计不一致且无说明。 | `const totals = useMemo(() => sumModelTotals(stats.models), [stats.models])` | 筛选态下合计行标注“全部模型”，或按当前模型过滤重算。 |
| P3 | `client/console-usage.tsx:618,624,815-820` | `MetricChart` 的 `pointerActive` ref 只写不读（从热力图复制残留，effect 重置也无消费者），小段死代码。 | `const pointerActive = useRef(false);` 全文无读取，仅 815/819 赋值。 | 删除 ref 及三处赋值。 |
| P3 | `client/console-usage.tsx:2356-2360,2396-2399` | 无测量值时输出速度/TTFT 磁贴把单位固定拼在 “—” 后，显示 `— tok/s` / `— s`。 | `value={formatTps(totals?.tps ?? null)} unit="tok/s"`，`formatTps(null)` 返回 "—"。 | unit 仅在 value 有数值时渲染。 |

## 未验证项

1. **跨时区图表标签**（P3 第 4 条）：静态推断，置信度中。验证：daemon TZ 设 UTC+8、客户端时区设 UTC 打开 Usage，看 today/7d 轴刻度是否整排缺失、30d/tooltip 日期是否错位。
2. **DST 春季调时当天** `today` 范围小时桶 start 重复：server `new Date(..., hour)` 对不存在本地小时归一化（`usage-stats.ts:492-495`），`hour=2/3` 可得同一 start；client 以 `key={entry.start}` 渲染（`console-usage.tsx:806,857`）→ React key 冲突 + 一个空桶。需 daemon 处于有 DST 时区且当天为调时首日，静态推断未实测。
3. **触摸端交互**：热力图/图表的 pin/tooltip 依赖嵌套 Pressable 的 `stopPropagation`（RN Web 合成事件假设未真机验证）；`focusable={false}` 下 371 个无障碍按钮对屏幕阅读器的影响未评估。
4. **性能**：仅静态判断（无全量重渲染问题：`HeatmapCell` memo、labels useMemo、轮询对象等价跳过），371 格 + 表格在低端手机的帧率未实测。
