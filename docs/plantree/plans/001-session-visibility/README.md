# P001：子代理可见性与历史读取

状态：Done。子会话映射已部署并完成协议与移动端尺寸 Web 验收；历史性能按对照结果收尾，本轮不做性能代码改动。

## 用户目标
1. DSH 创建的原生子代理在 Paseo 中可见，可查看独立状态、消息和工具过程。
2. 对照 DSH 与其他 Provider 的历史翻页等待；用户最新要求速度相当时无需修改。
3. 主会话负责编排、指导和验收；执行者承担代码实现。

## 范围与原则
- 子代理实现基于 DSH 的真实身份／父子关系及 Paseo `session.opened`、`parentSessionId` 等现有契约。
- 子消息、状态、用量按各自会话归属，避免覆盖父会话；恢复时重建关系且不重复显示。
- 历史问题先对比客户端触发、RPC、provider 恢复、反序列化与渲染，不凭感觉调超时。
- 若修复需改变 Paseo 核心／已发布 iOS 客户端，先记录证据和可部署范围，再确定实施路径。
- 不修改模型凭据、CPA 路由或 Agents Anywhere 配置；本次不自动合并或扩大 PR #1。

## 验收
- 真实 DSH 子代理调用对应独立 Paseo 子会话；父子状态和时间线归属正确。
- 覆盖前台／后台、fork、恢复、失败或取消中实际支持的生命周期，未知能力明确拒绝。
- 历史等待有可重复的对照指标；需要优化时保证分页顺序、完整性、去重与滚动锚点不回归。
- 类型检查、桥资源一致性、相关协议回归及实际 Paseo 验证通过。

## 文件
- [路线图](roadmap.md)
- [本轮执行记录](history/implementation-status-20261015.md)
- [验收方案](verification.md)
- [子会话映射设计](subagent-design.md)
- [历史翻页定位](history-findings.md)
- [历史对照证据](history-evidence.md)
- [子会话映射审查](review.md)
- [子会话验收证据](subagent-evidence.md)
- [模块基线](../../baseline/README.md)
