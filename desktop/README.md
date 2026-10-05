# M04S Studio 桌面 App

桌面版打包 Chromium 与网页编辑器，通过 Electron Web Bluetooth 使用本机蓝牙。
打开 App 后无需 Python、PHP、Homebrew 或本地 HTTP 服务安装。
Python 自部署版本仍保留在 `console/`，两者可以分别使用。

## 当前构建

`artifacts/desktop/mac-arm64/M04S Studio.app`：Apple Silicon Mac 便携版。
App 启动后可编辑/导出；点击连接时才出现 M04S 设备选择，不会自动扫描或打印。
浏览器版驱动仅完成软件验证，打印仍需真机验收。Intel Mac、Windows、Linux 包未在本轮构建或验证。

便携 App 请放在可写入的文件夹中。数据默认存入 App 所在目录的 `M04S-workspace/`：
`browser/` 保存草稿、图片和记录；`logs/` 保存 App 日志；导出对话框默认指向 `exports/`。
不会迁移或删除旧 Python 工作台的数据。开发模式默认保存到项目 `storage/desktop/`。
如需指定目录，可启动前设置 `M04_WORKSPACE`；移动工作区时一并保留数据目录。
使用固定本机端口 18765 保持存储来源一致，不对局域网开放。

这是未签名、未公证的构建，macOS 可能需要在 Finder 中右键“打开”。
面向大范围下载分发之前，还需要 Apple Developer 签名与公证。

## 开发与重新打包

```sh
npm ci
npm run setup:desktop
npm run desktop
npm run build:desktop
```

构建脚本把缓存和输出保存在项目 `logs/`、`artifacts/` 内。
App 已使用 contextIsolation、sandbox，并关闭 Node renderer；仅信任自己的本机页面。
PDF/DOCX 与打印协议在本机处理，App 不依赖 Cloudflare 在线站点，因此离线可编辑和打印。
外部网页正文导入仍需要网络，并受来源网站跨域限制。
