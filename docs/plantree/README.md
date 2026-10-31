# 项目计划入口

以用户当前指令、仓库 `AGENTS.md` 和运行版本的公开协议为约束。此目录保存后续修复的范围、决策和验收证据。

## 基线
- [模块与运行链路](baseline/README.md)

## 计划
| ID | 计划 | 影响模块 | 状态 | 当前阶段 | 最近落地 | 下一目标 |
| --- | --- | --- | --- | --- | --- | --- |
| P001 | [子代理可见性与历史读取](plans/001-session-visibility/README.md) | bridge、provider、history | Done | 已部署并验收 | 2026-10-15：子列表、独立历史与移动端尺寸子视图验证通过 | 提交／PR 更新待授权 |
| P002 | [运行中发消息打断子代理](plans/002-steer-turn-identity/README.md) | provider 插件回执、bridge 工具遮蔽 | In Progress | 已部署，机器验收通过 | 2026-10-15：steer 回执修复 + 强制后台委派真机通过 | 用户 App 实测；提交／PR 待授权 |
| P003 | [能力对账与补齐计划](plans/003-capability-gap/README.md) | timeline、bridge、session | Done | 源码与验收完成 | 2026-10-31：五项补齐、29 项回归、真实模型与桌面/窄屏 UI 通过 | B 档上游问题草稿已交付；产物未发布 |

阅读顺序：基线 → 目标计划 README → roadmap → 验收证据；执行登记保留在计划的 history 中。
