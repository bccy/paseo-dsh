# I Console 屏幕 审查报告
状态: completed
范围: paseo-plugin/client/{console-screen,console-settings,console-diagnostics,dsh-plugins-page,settings-screen}.tsx（origin/main..HEAD，+6307/−757）；配合核对 index.client.tsx 注册、shared/{pricing,diagnostics,dsh-plugins-api} 契约、server/{pricing,diagnostics,dsh-plugins} 行为、@getpaseo/plugin 0.17.3 的 useRpc/Modal 契约。
方法: 严格只读（git diff / read / grep / 静态分析）；未跑构建或测试。

## 摘要
- 接线完整：index.client.tsx 注册 CONSOLE_SCREEN_ID、侧栏项、Settings 面与 Command Center 入口，3 Tab 组件都在发布图内，无"新屏未注册"类死模块；tsc 由 Lead 跑过（exit 0）。
- 破坏性插件操作用 Modal 确认（卸载/更新/批量更新；宿主 <0.16 时回退 inline 二次确认），失败有 Toast+Callout；安装有 trust 提示、检查通过后锁定输入（防 inspect A / install B）；doctor 区分"未运行/超时/失败/通过"，overview 有错误态+重试。未发现 P0/P1。
- 2 个 P2：pricing 读取失败静默回退默认币种/汇率；并行分支合并后遗留未接线槽位与死分支（约 250 行）。

## 问题
| 级别 | 位置 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| P2 | console-screen.tsx:226-240；console-settings.tsx:36-37,419-421 | pricing get 失败静默降级：Settings Tab 以默认 USD/7.2 渲染并允许编辑，与已持久化值（如 CNY/7.3）不一致且无错误提示 | catch 只 `report("pricing get", error)`，不设 pricingError；resolvedPricingSlot 用 `effectiveDisplayCurrency ?? "USD"`、`pricingState?.usdToCnyRate ?? DEFAULT_USD_TO_CNY_RATE`；console-settings 复制同一默认值字面量；pricingUpdateRpc 是部分更新（无 revision），编辑会以错误基线写盘 | 读取失败时置 pricingError 并在 slot 暴露"未知"，禁用编辑/显示错误+重试；默认值改从 shared/pricing 导入 |
| P2 | console-settings.tsx:142-394；console-screen.tsx:130-135,482-517；dsh-plugins-page.tsx:2408-2419,2444-2470 | 并行分支合并后遗留未接线槽位与死分支：结构化 `environment` 槽约 250 行（含 10+ 未用 copy key）、renderUsage/renderPlugins/UsagePlaceholder、DshPluginsPage 独立壳与 embedded=false 分支 | 全仓仅 index.client.tsx:455-478 传 renderEnvironment，从未传 environment/renderUsage/renderPlugins；console 唯一调用 DshPluginsContent 且 embedded=true；DshPluginsPage 无消费方（index 旧 plugins 屏已删），注释仍写 "The registered screen"/"once plugins-polish merges"（b9a1ad0 已合并） | 二选一：删除死路径并清过时注释，或接线并补测试；`environment` 分支与 ConsoleDiagnosticsSection 是两套同卡片实现，留着必有漂移 |
| P3 | console-screen.tsx:482-517；dsh-plugins-page.tsx:1479-1508；console-diagnostics.tsx:837-839 | Tab 切换卸载活动面板：运行中任务可经 snapshot.activeJobId 恢复，但已完成任务的详情/完成 Toast、Doctor 报告（最长 20s 才重跑）丢失 | 三 Tab 条件渲染只挂当前；job/doctorReport 是组件内 state，卸载即丢；lastToastedJobIdRef 随实例重置 | 把 job/doctorReport 提升到 DshConsoleBody 或做缓存；至少在切走时提示任务仍在后台 |
| P3 | console-diagnostics.tsx:1122-1123,1563-1591 | 客户端无 RPC 超时/取消：RPC 挂起时 overview 永久 loading 且刷新按钮被禁用，doctor 永久 running 且按钮禁用，无手动重试/取消 | `refreshDisabled=(overviewLoading&&overview===null)||refreshBusy`；doctor 仅 `disabled={doctorRunning}`，无 AbortController/计时；服务端有 20s 上限但 RPC 层无超时（未验证宿主侧超时） | 加客户端超时（略大于服务端上限）与重试/取消路径 |
| P3 | console-settings.tsx:428,653-680；console-screen.tsx:279-307 | 币种保存失败的错误落在"汇率"行，且直接展示原始 error.message（未本地化） | `rateErrorMessage = rateError ?? pricing?.error`；currency 与 exchangeRate 两类操作共用 pricingError，无币种行错误位 | 在对应控件行显示；失败文案用本地化 saveFailed |
| P3 | console-usage.tsx:1775-1783（跨块 F）；console-screen.tsx:252-257 | usage 币种切换乐观更新并静默吞掉持久化失败，父级同步改 pricingState → 两 Tab 渲染未落盘币种，重开才回退 | usage `void client.rpc(pricingUpdateRpc,…).catch(()=>{})` 后再 onCurrencyChange；父级直接 `setPricingState(prev=>({...prev, displayCurrency: next}))`，未校验写入结果 | 由 usage 回报失败并回滚/提示（F 块处理）；父级只在确认成功后改 pricingState |
| P3 | console-settings.tsx:826-831；settings-screen.tsx:729-750,779-790 | Quick Presets 一键立即持久化 7 项并静默丢弃未保存草稿，无确认（既有行为，非本次回归） | applyPreset→persistValues 直接 save，成功 `setDraft({})`；旧 TimelineSettingsScreen 同语义 | 有草稿时提示将覆盖或先确认（可并入既有 R5 结论） |

## 未验证项
- 宿主 <0.16 的 Modal/Toast 缺失回退（resolveHostModal / useSafeToast 分支）：仅静态核对，未真机；思路正确、无状态泄漏。
- 旧屏幕 id "dsh-plugins" 不再注册（index.client.tsx 只注册 dsh-console）：若宿主保留该 id 的当前屏引用，升级插件后是否自动退回未验证（真机：插件页打开时 reload 插件观察）。置信度中。
- P2-1 的实际触发需 pricing 存储读盘失败使 dsh.pricing.get reject，未构造复现；代码路径明确。
- P3"Tab 切换丢结果"按源码推断，未真机点验（插件安装中切 Tab 再切回 / Doctor 跑完切 Tab）。
- 客户端 RPC 无超时（P3）依赖宿主 RPC 无超时；若宿主已有超时则降为 info。置信度低。
