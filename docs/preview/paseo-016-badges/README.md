# 工作区徽标组件预览

本轮使用官方 `WorkspaceRowBadge` 和插件真实状态聚合/组件生成桌面、手机宽度及英文浅色截图。
绘制环境是 React Native Web、主题与图标适配；侧栏容器为离线预览，不是已安装插件、原生手机或 Show 菜单验收。

重新生成：

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=<可用的 Chromium> node harness/workspace-badges-preview.cjs <Paseo checkout> <输出目录>
```

- `desktop.png`：桌面深色。
- `mobile.png`：390px 手机宽度。
- `desktop-light-en.png`：桌面英文浅色。
