# m04s · 印先森 Mac 打印驱动与本地工作台

在 Mac 上将 PNG／JPG 转成热敏点阵，经 BLE 发送到印先森 M04S，并等待设备打印完成通知。附带本地网页工作台，支持文字排版、图片处理、网页和文档导入，无需通过手机 App 发起打印。

**欢迎拥有其他设备型号的朋友进行真机测试，通过 Issues 提交成功或失败的测试结果。** 请先核对下面的支持范围。

## 设备支持范围

### 已实机验证

现有 **M04S 的黑白 MiniLZO 路径**：单张“66”、592×2400 长图、同连接连续三张、浓度对照、状态查询、自动关机设置回读及空白走纸。用户确认两个“6”完整，长图从 `01/12` 完整到 `END 12/12`，连续任务均完整。

这不代表所有 M04S 批次、纸宽、标签定位或固件都已实测。

### 理论支持：代码已实现，新增分支待实机确认

| 型号／批次 | DPI | 编码 | 当前状态 |
| --- | ---: | --- | --- |
| M04S / Q016 前缀 | 300 | MiniLZO | 编码路径已有实测基线；新增 SN 选择与补白入口需复验 |
| M04S / Q171、Q466 前缀 | 300 | 未压缩 raw 点阵 | 已实现，离线验证通过，待真机测试 |
| M04S / 其他非空 SN | 300 | 官方静态分支选择 MiniLZO | 固件和新批次待确认 |
| M04AS | 300 | 未压缩 raw 点阵 | 已实现，离线验证通过，待真机测试 |
| M04AH | 203 | 未压缩 raw 点阵 | 已实现，离线验证通过，待真机测试 |
| Y04S | 300 | 未压缩 raw 点阵 | 已实现，离线验证通过，待真机测试 |

依据是用户提供的官方 App 4.46.0 的 `QYM04Strategy`、型号配置和 SN 分支。DPI、最大内容宽度、浓度系数及补白分别处理。新入口读取 SN，读取失败且未手动提供时不猜测 M04S 编码。

**网页工作台仍使用原有 M04S 驱动；新增型号通过 `m04_print.py` 测试。** M04ASH 暂未纳入，不能仅凭名称相似选择 M04AS 适配。

### 其他型号：欢迎提供设备信息，尚不能直接使用本项目打印

| 策略家族 | 官方静态映射中的型号举例 | 待移植内容 |
| --- | --- | --- |
| 基础口袋打印机 | M02、M02S、M02 Pro、T02、M02X／L 等 | 组图、不同 DPI 和批次分支 |
| 灰阶家族 | M02H、M02SH、M03AH | 独立的 16 级灰度路径 |
| M03 家族 | M03、M03A、M03S、M03AS 等 | 纸型、尺寸与组图 |
| M08 / M08F 家族 | M08、M08F、T08FS 等 | 两套不同策略与走纸流程 |
| 大幅面家族 | M831／M832／M836、P831／P832／P833、Q300／Q301／Q302、S821／S822／S823 等 | 多纸型、分段、色带与状态 |
| 特殊用途家族 | TP81、TP82、SP20 等 | 专用图像头与控制 |

共享策略只是后续适配线索，**不等于这些型号已经兼容**。不能仅改蓝牙名称就把 M04S 数据发给其他家族。M03AH 与 M03AS、M08 与 M08F 分别属于不同策略。SDK 还包含其他 App 的标签产品线，完整名称表不是本项目的支持清单。

详见 [协议说明](docs/PROTOCOL.md)、[静态型号映射](docs/model-strategies.json) 和 [M04 家族适配说明](M04_FAMILY.md)。

## 功能与限制

- 独立图像打印：Pillow、黑白点阵、MiniLZO／raw、任务校验、预览与 bin 导出。
- 动态流控：FF03 额度＋macOS 发送背压；逐包发送没有固定延时。
- 完成检测：FF01 `1a 0f 0c` 才认定设备完成；额度回满不等于打印结束。
- 参数与状态：浓度、浓度系数、纸张传感器模式、电量、上盖、纸张、温度状态、自动关机与空白走纸。
- 网页工作台：黑白界面、草稿、文字和图片组合、横排／竖排／旋转／镜像、53／80／110 mm 纸宽。
- 图片处理：线稿、素描、文字增强、黑白照片、明暗、对比度、裁剪、旋转和反色。
- 导入：公开网页、PDF、DOCX、DOC、TXT；PDF 多页预览与逐页打印队列。
- 跟随窗口的侧栏预览及可拖动、缩放的浮窗。

实际 BLE 发送目前仅实现 **macOS CoreBluetooth**，使用 Bleak 内部委托接口，升级依赖后需复验。未提供 Windows／Linux 实机驱动。速度指令为实验协议值，M04S 对照未见明显调速效果。标签／黑标自动定位、16 级灰度、新批次和更多纸宽仍需分别验证。

## 安装

已验证 Python 3.13、Bleak 3.0.2、Pillow 11.3.0、PyObjC 12.2.2。网页另需 PHP 8.1+ 的 SQLite、DOM、mbstring 扩展。

```sh
git clone https://github.com/5hux1n/m04s.git
cd m04s
brew install python@3.13 lzo php
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt

# 网页／PDF／Word 导入依赖
python -m pip install -r console/requirements.txt
```

请在 Terminal 中运行并允许它使用蓝牙。打印前开启设备、断开手机官方 App。仓库不包含解密 IPA、官方程序、会话抓取或个人运行数据。

## 原有 M04S 基线入口

先离线生成预览，确认图像后再打印：

```sh
python m04s_print.py samples/66.png --dry-run
python m04s_print.py samples/66.png
python m04s_print.py samples/66.png --repeat 3 --density dark
python m04s_print.py --status
python m04s_print.py --feed-mm 10
```

默认保持原有 **592 点**基线。`--completion-timeout` 设置完成通知等待上限。`--hold-seconds` 仅用于人工对照，结果标记为未确认，默认不用。

## 理论适配型号测试入口

```sh
python m04_print.py --list-models
python m04_print.py samples/66.png --model M04AS --paper-width 53 --dry-run
python m04_print.py samples/66.png --model M04AH --paper-width 53 --dry-run
python m04_print.py samples/66.png --model M04S --serial-number Q171 --dry-run
```

核对型号与预览后去掉 `--dry-run` 才会连接并打印：

```sh
python m04_print.py samples/66.png --model M04AS --paper-width 53
python m04_print.py samples/66.png --model M04S --paper-width 53
```

新入口会读取完整 SN，手动提供的 SN／前缀会与设备回应核对。多台同型号设备可用 `--device-address`。不要把尚未适配型号伪装成 M04S。补白、内容宽度与编码细节见 [M04 家族说明](M04_FAMILY.md)。

## 本地网页工作台

```sh
python console/run.py
```

也可双击 `start_console.command`。打开 **http://127.0.0.1:8765**，在网页中连接 M04S、编辑并打印。启动服务本身不会自动连接设备。详见 [工作台说明](console/README.md)。

## 欢迎提交真机测试结果

到 [Issues](https://github.com/5hux1n/m04s/issues/new/choose) 选择 **真机测试结果**，提供：

1. 精确型号、SN 前 4 位、固件版本、macOS／Python 版本及项目提交版本。
2. 纸宽／纸型、实际命令和参数。
3. 纸面照片：是否完整，有无截断、空白、错位或额外走纸。
4. 日志与 summary：是否收到 FF03 额度和 FF01 完成通知。
5. 成功／部分成功／失败，必要时与官方 App 的同图输出对照。

完整 SN、蓝牙地址、本机用户名／路径请打码，不上传私密打印内容。尚未适配型号也欢迎先提交设备和官方输出信息。具体流程见 [贡献指南](CONTRIBUTING.md)。

## 软件验证

```sh
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python console/tests/run_tests.py
```

目前为 **37 项驱动离线测试＋9 项控制台测试**：任务逐字节回归、SN 分支、格式校验、流控、背压、断线、完成通知和模拟队列。软件测试不连接打印机，不替代真机验收。CI 运行驱动离线测试。

## 文件与运行数据

```text
m04s_print.py          原有 M04S 实测入口
m04_print.py           M04 家族适配入口
m04_family.py          型号、SN、DPI、raw／MiniLZO、补白
m04s_codec.py          MiniLZO 编解码
m04s_driver.py         BLE 额度、状态与完成检测
m04s_corebluetooth.py  macOS 发送背压
console/              本地网页工作台
samples/              测试图和小型协议回归样本
tests/                离线测试与型号参数夹具
```

所有预览、bin、日志、草稿、上传和数据库都以项目目录为根，保存在 `artifacts/`、`logs/`、`storage/`，不写入用户根目录。这些运行目录不提交到 Git。
