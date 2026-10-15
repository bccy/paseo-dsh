# 模块与运行基线

## 已确认链路
- `dsh-bridge/`：DSH 侧 stdio JSON-RPC 桥，读取原生会话、工具与状态。
- `paseo-plugin/server/`：Paseo provider，负责会话生命周期、时间线和用量映射。
- `paseo-plugin/server/bridge-assets.ts`：生成的桥副本；桥修改后须再生。
- `harness/`：协议和边界回归。
- `history`：插件历史恢复与 Paseo 的分页请求／前端滚动链路；具体性能瓶颈尚待定位。

## 运行版本与落地
- 当前修复基线 `1a41aba`，DSH `0.2.0-rc.2`，Paseo `0.11.2`。
- 已完成上下文用量上报，显示名为 `DeepSeek Harness`，Provider ID 保留 `deepseek-harness-native`。
- 本次继续在 Fork 修复；已有 PR #1 仅包含先前已提交的上下文改动。

## 验证与部署约束
- 修改前后保留用户已有改动。
- 正式环境由主会话统一部署；执行者的验证使用隔离 profile／临时工作区。
- 修改桥后再生内嵌副本；类型检查和相关 harness 必须通过。
- 插件源码变更使用插件重载；避免重启整个 daemon。
- 新增修改的提交、推送和 PR 更新须有相应授权。
