# 浏览器版 / Cloudflare 公开版

公开入口：https://bleprint.goforit.si

本版本直接用访客本机的浏览器蓝牙连接 M04S，不调用网站部署者的电脑。
草稿、图片、偏好和打印记录保存在该浏览器的 IndexedDB；没有服务端打印队列或自动文件上传。
关闭页面会断开打印机，未确认完成的任务不会在刷新后自动重发。
更换域名、浏览器或清除网站数据不会保留原有草稿，可导出 PNG 保存作品。

## 使用

1. Mac、Windows 或 Android 使用支持 Web Bluetooth 的 Chrome；网址必须是 HTTPS（本机 localhost 开发例外）。
2. 打开 M04S，并断开官方 App 或其他打印程序。
3. 点击“连接打印机”，在浏览器设备选择框中选择自己的 M04S。
4. 编辑或导入文件，核对点阵预览后打印，并保持页面打开直到收到完成通知。

iPhone Safari 和不支持 Web Bluetooth 的浏览器仍可编辑、导入和导出 PNG，连接/打印按钮显示不可用。
本版本提供 M04S 发送端，不是拼多多商家版蓝牙协议插件。

## 功能与限制

复用本地工作台的图文编辑、图片效果、文字方向、浮动预览、纸宽和面单预设。
PDF 在浏览器本机渲染，每次最多 20 页；DOCX 导入正文与嵌入图片；TXT 导入文字。
旧版 DOC 请先另存为 PDF/DOCX。网页导入只读取允许跨域访问的正文；跨站图片需单独上传。
这与 Python 自部署版的服务端网页读取能力不同，公开版不开放任意网址代理。

连接时读取设备序列号：Q171/Q466 使用 raw，其余有效序列号按分析到的 M04S SDK 分支使用 LZO。
Q016/Q171 对新纸宽补 SDK 留白；592 点保留原有完整点阵路径。
无法读取序列号、无法初始化 FF03 信用或收到提前完成通知时停止打印，不猜测发送方式。
目前浏览器写包保守选用 20 字节（并遵守设备提供的上限），同时等待设备信用和 Web Bluetooth 写入 Promise。
没有固定的逐包 sleep；保留 15 ms 控制/图像边界和完成后的 1 秒收尾。
浏览器没有暴露原生 CoreBluetooth 的 canSend 回调，平台背压由写入 Promise 处理。

Python 原有 M04S 驱动已实测；本次新增浏览器/桌面发送端仅完成软件验证，仍需真机验证
连接、持续传输、不同纸卷、实际尺寸和条码扫描。不能把浏览器支持平台列表当作所有平台的真机通过结果。

## 自部署静态版

在项目根目录使用 Node.js 24 或更新版本：

```sh
npm ci
npm run build:web
```

把 `web/dist/` 完整复制到任何 HTTPS 静态站点，保持 `/assets/`、`/vendor/` 路径。
静态文件不包含 IPA、工作区日志、用户图片或 Cloudflare 密钥。
`_headers` 为 Cloudflare 设置 Web Bluetooth 权限和响应头；其他静态服务器可配置相同头部。

## Cloudflare Workers 部署

```sh
npm ci
npx wrangler login
npm run deploy
```

`wrangler.jsonc` 使用 Workers Static Assets，站点名 `m04s-studio`。
自行部署时请将 `routes` 中的 `bleprint.goforit.si` 改为自己的域名；只使用 workers.dev 地址时删除 `routes`。
账号凭据通过 Wrangler 登录或部署环境的 `CLOUDFLARE_API_TOKEN` 提供，绝不写入仓库或前端。
可在 Cloudflare 为此 Worker 添加自己注册的自定义域名；当前正式入口为 `bleprint.goforit.si`，保留默认 workers.dev 地址作为备用。

## 离线验证

```sh
python3 -m pip install -r requirements-dev.txt
python3 console/tests/make_fixtures.py
npm run test:web
npm run build:web
npm run test:browser
```

协议测试使用本机 liblzo2 解压浏览器编码，并校验官方样本、长点阵、序列号分支和留白。
传输测试覆盖额度耗尽、完成通知、提前完成、断连和操作互斥。
浏览器集成测试将蓝牙替换为模拟设备，不扫描/连接真实硬件；需要本机 Chrome，
以及 `console/tests/make_fixtures.py` 生成的示例 PDF/DOCX。
日志、截图和运行数据保存在项目 `logs/`、`artifacts/`、`storage/` 内。
