# Paseo 0.16.0 本地适配交付（2026-11-16）

实现分支：`codex/paseo-016-adaptation`；原始基线：`5e2de2d`。独立复核的功能代码版本为
`c568921`，其后只有安装说明与截图文档更新。主 checkout 和正在运行的 daemon 未切换。

## 已落地

- 三个 Paseo SDK 精确升级到 `0.16.0`，宿主最低版本提高到 `>=0.16.0`；正式 `addHook` 注册替换旧别名。
- 原生工作区徽标：目标、团队、后台各一类，复用现有订阅；计数进入无障碍描述，后台标签保持固定。
- Review All 输入通过正式 schema，原生 composer 控件、附件、权限、usage、子代理通道继续沿用官方契约。
- 订阅关闭与工作区迁移释放、旧分页不覆盖 live 更新、断线徽标清理与同值恢复。
- goal/team 当前完成键匹配本地或服务端已读事实；补齐丢失自身 echo 后的跨窗口同步。
- 发布成功后才提交去重缓存；子代理瞬时读取失败不进入成功缓存。
- 恢复失效测试夹具；新增 push/PR 离线 CI，与 upstream sync 共用检查入口。
- 更新中英文说明、doctor 的真实副作用及稳定版门槛、宿主未修复的历史 turnId 缺口。

完整逐项映射与未开放接口见 [适配矩阵](PASEO-016-ADAPTATION.md)。DSH 后台任务仍走 jobs
订阅/RPC：Paseo 0.16.0 的 direct-provider 协议没有原生后台任务上报/停止入口，不能冒报支持。

## 验证结果

| 检查 | 结果与边界 |
|---|---|
| 最终代码统一离线门 | `node harness/offline-checks.cjs --keep-going`，60/60，exit 0；本机 Node 24 |
| TypeScript / 正式宿主构建 | `tsc --noEmit` exit 0；0.16.0 官方 compiler worker 成功构建 client/server bundle |
| 客户端真实贡献函数 | 117 项，含跨窗口已读、丢 echo、关闭确认、发布异常恢复、observer 生命周期 |
| 徽标 / 目录订阅 | 66/66、228/228；目标 313/313、团队 224/224、本地化 803/803 |
| 桥与资产 | bridge-server 145/145；22 个内嵌桥文件一致；DSH 0.2.2-rc.3 契约 21/21 |
| 正式宿主子代理终态 | canceled/failed/completed 后 close 三项保持终态；同一检查在 beta.2 按预期失败 |
| 正式宿主撤回报告 | 43/43，含降级 4/4、迟到重建 8/8；宿主类 + 假桥，没有 daemon |
| 真实 plugin-check | 40/40；一次性克隆 DSH_HOME，凭据仅用于请求；未写 live profile |
| 真实撤回 / 父子文件归并 | 14/14、13/13；一次性 home，先 provision 当前内嵌桥；模型和文件操作均在隔离会话/目录 |
| 真实日志重放保真 | 4/4，只读历史日志 |
| 独立复核 | 单独 Git clone + 独立依赖副本，C1–C7 关键检查通过；11 处变异每处至少一条检查变红 |

独立变异覆盖缓存、closed、分页、发布顺序、observer 清理、seen 双候选/变化通知、正式 hook、
kind 格式与 armed 目标回合间状态。三处次要检查没有覆盖对应变异，但均被另一条行为检查抓到；
不把每条脚本都说成覆盖全部链路。

真实模型检查运行在最后两处客户端边界修复之前；修后重跑了完整离线门、相关客户端行为和正式
宿主编译，没有重复耗 token 的模型检查。最后修复未改变桥、provider 或模型请求路径。

## 截图与真实环境边界

[桌面](preview/paseo-016-badges/desktop.png)、[手机宽度](preview/paseo-016-badges/mobile.png)、
[英文浅色](preview/paseo-016-badges/desktop-light-en.png) 使用官方徽标组件与真实插件聚合逻辑，
是离线组件预览。不是已安装插件侧栏、手机实拍或 Show 菜单验收。

仍需验证：GitHub 的 Node 22 runner；正式 0.16.0 daemon/App 上的徽标及 Show 菜单；
原生手机；运行中 Stop/replace、goal 自主回合完成通知和 idle sweep 的真实交互。

## 部署与回退

本地源代码和依赖位于独立 worktree，当前加载中的主 checkout 保持 `5e2de2d`；本轮未升级或
重启 daemon、未 reload 插件、未 push/tag/publish/提交插件目录收录。

用户确认可接受中断后，先记录当前 daemon/CLI/App 版本与插件源，再切换经验证的源码、安装对应
依赖并升级 CLI 至 0.16.0，最后通过 daemon 自身重启命令生效。核对实际进程版本及当前地址，
然后按矩阵验收。失败时恢复原源码/依赖及此前 CLI 版本，再重启；不改已安装宿主 dist。

正式发布仍遵守 AGENTS.md：用户真实环境测试通过并明确确认后才推送产物。
