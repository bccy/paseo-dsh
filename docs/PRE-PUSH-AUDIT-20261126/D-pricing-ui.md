# D 定价 UI 审查报告

状态: completed
范围: `paseo-plugin/client/console-pricing.tsx`（新增 3143 行，全量通读）；仅用 `shared/pricing.ts:169-250,982-2160` 与 `server/pricing.ts:780-841` 核对调用面，不深审 server/shared。只读静态审查，未运行构建/测试。

## 摘要
- 无 P0/P1：未发现用本地默认值覆盖**已持久化**价格的路径；RPC 调用名/输入/输出与契约一致（`dsh.pricing.get/update/sync` 分别对应 `pricingGetRpc/pricingUpdateRpc/pricingSyncRpc`，update 为部分更新，client 只发 `displayCurrency/usdToCnyRate/autoSync/key+rates/resetOverrides`，输出按 `pricingStateSchema` 消费）。
- 异步守卫整体到位：load 有 requestId 守卫；后台同步轮询有 cancelled+mountedRef+单飞守卫；mutation 有 single-flight 与 mountedRef；关闭弹窗会作废在飞 load 且轮询 cleanup 取消。
- 发现 2 个 P2（未保存草稿被静默覆盖；长上下文阶梯自动填入揣测值可被直接持久化）与 7 个 P3。
- 输入校验（空值/NaN/负数/>上限/字符串）与服务端 schema 一致，货币符号与提交值一致；仅展示层 4 位小数舍入存在理论失真。

## 问题

| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | `paseo-plugin/client/console-pricing.tsx:1956-1959`、`:1251-1254` | 未保存草稿被无关的成功更新静默覆盖：① 用户键入汇率未保存时，保存任意模型单价/切换显示币种/开关自动同步/添加模型都会把汇率输入框悄悄改回已存值；② 切换显示币种会触发每个展开行 `draft` 重置，丢弃行内未保存单价 | `setState(next); setRateInput(String(next.usdToCnyRate)); setRateError("");`（applyUpdate，所有 mutation 共用）；`useEffect(() => { setDraft(draftFromRates(row.effective, displayCurrency)); setError(""); }, [effectiveFingerprint, displayCurrency, row.key])` | `applyUpdate`/行内 effect 仅在草稿未 dirty 时回写，或明确提示「未保存修改已丢弃」 |
| P2 | `paseo-plugin/client/console-pricing.tsx:919-933` | 开启「长上下文阶梯」时按基础价 ×2/×1.5 本地揣测阶梯单价并填入，无「估算」标注；用户不改直接保存即把猜测值写入自定义价并参与成本统计 | `longInput: fmtCompactNumber(baseInput * 2), longCached: fmtCompactNumber(baseCached * 2), ... longOutput: fmtCompactNumber(baseOutput * 1.5)` | 默认留空并提示手填，或标注「估算值」并对保存二次确认 |
| P3 | `paseo-plugin/client/console-pricing.tsx:1867-1884`、`:1954`/`:1919`/`:2146`、`:2600-2601` | 手动 Refresh 进行中被任一 mutation/同步/轮询顶替时 `loading` 永不复位：Refresh 按钮永久转圈且 disabled，直到关闭重开弹窗；同类顶替还会让发起方结果被丢弃 | `finally { if (loadRequestIdRef.current === requestId) setLoading(false); }`，而 `applyUpdate` 先做 `loadRequestIdRef.current += 1;`；按钮 `loading={loading && state !== null} disabled={loading || mutating}` | loading 复位与 requestId 校验解耦（finally 无条件复位），请求序号只用于丢弃结果 |
| P3 | `paseo-plugin/client/console-pricing.tsx:2027-2029`、`:2565-2567` | 汇率输入不合法（`0`、`abc`、`-1`、超界）时预览静默沿用已保存汇率，编辑期无错误提示，只有点保存才报错 | `const previewRate = parsedDraftRate ?? currentRate;` → `1 USD ≈ money(previewRate…)/¥10 ≈ …` | 非法草稿时显示错误态/占位，不要用旧值伪装预览 |
| P3 | `paseo-plugin/client/console-pricing.tsx:963-971`、`:658-664` | 行内「单价币种」切换不换算已有数值，只改币种标签；USD→CNY 后未改数字直接保存会把已存价格按 7.2× 重解释（折算预览能间接暴露，但无提示/确认） | `onChange={(currency) => { if (!disabled) onChange({ ...draft, currency }); }}`；校验仅原样打包 `currency: draft.currency, input, cached, output` | 切换时按当前汇率换算数值，或二次确认「保留数字仅改币种」 |
| P3 | `paseo-plugin/client/console-pricing.tsx:1547`/`:1656`/`:1668`、`:3084` | i18n/主题小缺口：缓存写入摘要中英混排硬编码 `CW `；无 HostModal 时的兜底弹窗遮罩硬编码 `rgba(0,0,0,0.48)`，未走主题 token | `\` · CW ${currencySymbol(candidate.rates.currency)}…\``；`backgroundColor: "rgba(0, 0, 0, 0.48)"` | 文案进 CopyTable；遮罩改用 `tint(colors.background/foreground, …)` 类 token |
| P3 | `paseo-plugin/client/console-pricing.tsx:499-531` | `useSafeToast` 在条件里调用宿主 hook（`if (typeof hostUseToast === "function") raw = hostUseToast()`），若 toast provider 迟到或偶发抛错会改变 hook 调用顺序（Rules of Hooks），可致整弹窗渲染崩溃；当前宿主为常量分支故静态风险低（未验证） | `if (typeof hostUseToast === "function") { try { raw = hostUseToast(); } catch { raw = undefined; } }` | 用独立子组件/ErrorBoundary 隔离宿主 hook，主组件内不条件调用 hook |
| P3 | `paseo-plugin/client/console-pricing.tsx:2705-2721`、`:2756-2760`、`:2722-2755` | 已有 state 时刷新失败，若当前筛选/搜索无行（空列表分支）则不渲染 `loadError`，退回「没有匹配条目」文案，刷新失败被静默吞掉 | `loadError` 仅在 `loadError && !state`（2705）与非空行分支（2758）渲染；空列表分支直接显示 `emptyMatches/emptyConnectedHint` | 空列表分支同样渲染 loadError 与重试 |
| P3 | `paseo-plugin/client/console-pricing.tsx:552-567` | 行摘要固定 4 位小数四舍五入，合法但 <0.00005/1M 的正价显示为 `$0 / $0 / $0`（存储/提交值正确，仅展示失真） | `const rounded = Number(value.toFixed(4)); return String(rounded);` 后拼 `formatRatesSummary` | 小值改用 `money()` 的自适应精度（`<$0.0001`） |

## 未验证项
- 宿主真机（Paseo ≥0.16）图标名是否存在：`Sparkles/CheckSquare/Coins/CircleAlert/TriangleAlert/RefreshCw` 等；`SafeIcon` 对未知图标名不校验，可能静默渲染为空。验证：真机截图逐项核对。
- 两种弹窗路径的键盘/滚动差异：兜底 `RNModal` 路径有 `keyboardShouldPersistTaps="handled"` 且可内部滚动，`HostModal` 路径把内容交给宿主，软键盘弹出时输入框可能被遮挡。验证：真机 iOS/Android 打开弹窗编辑汇率与行单价。
- `useSafeToast`/`HAS_HOST_MODAL` 在缺少 `@getpaseo/plugin/client/ui` 导出或 toast provider 未挂载的宿主上的实际表现（导入期缺失命名导出是否会让整个 client 加载失败）。验证：旧版宿主加载本插件。
- 大模型列表性能：每次按键（搜索/单价输入）都会重渲染全部已渲染行（`PricingModelRowCard` 无 memo，默认截断 50 行）。验证：真机 100+ 行列表连续输入帧率。
- `loadState` 无 mountedRef 守卫，卸载后仍写 state：React 18 下为 no-op，未发现可见症状，未真机复现。
- 慢网络下自动同步超过 `MAX_BACKGROUND_SYNC_POLLS`（20×1.5s=30s）而服务端超时上限 10s，正常不触发；轮询耗尽后停在「同步中」的场景未真机验证。

status: completed
