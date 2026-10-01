# M04 家族驱动适配

入口：`m04_print.py`。适配依据是工作区内解密后的官方 App 4.46.0，以及
[协议说明](docs/PROTOCOL.md) 中的静态分析结论。代码已实现、离线验证通过；新增型号和
M04S raw 分支还没有对应设备的纸面验证。

## 实现范围

| 型号／批次 | DPI | 图像编码 | 官方内容宽度上限 | 按整字节使用的上限 |
| --- | ---: | --- | ---: | ---: |
| M04S / Q016，及非 Q171、Q466 的非空 SN | 300 | MiniLZO | 1248 点 | 1248 点 |
| M04S / Q171、Q466 | 300 | raw 未压缩点阵 | 1248 点 | 1248 点 |
| M04AS | 300 | raw 未压缩点阵 | 1228 点 | 1224 点 |
| M04AH | 203 | raw 未压缩点阵 | 863 点 | 856 点 |
| Y04S | 300 | raw 未压缩点阵 | 1248 点 | 1248 点 |

四款都使用官方 `QYM04Strategy`。没有把 M04ASH 等名字相近但策略映射
尚未确认的型号加入支持列表。

新增功能：

- 根据型号选择 DPI、可打印宽度、纸宽选项和浓度系数。
- 按官方蓝牙名称精确匹配设备，避免把 M04AS、M04AH、M04S 混为一款。
- 连接后读取序列号，根据 M04S 的批次选择 raw／MiniLZO。
- raw 任务不加载 LZO 动态库，也不附加压缩分支专有的 3 个零字节。
- 同用 FF03 额度、macOS 发送背压和 FF01 完成通知，连续任务逐张等待完成。
- 发送前验证任务型号、批次、编码、尺寸、点阵长度、任务尾部。
- 日志、预览、任务 bin、型号参数和实际指令全部保存在工作区。

## 使用

从工作区运行：

```sh
cd m04s
python3 m04_print.py --list-models
```

只生成预览与任务，不使用蓝牙：

```sh
python3 m04_print.py samples/66.png --model M04AS --paper-width 53 --dry-run
python3 m04_print.py samples/66.png --model M04AH --paper-width 53 --dry-run
python3 m04_print.py samples/66.png --model Y04S --paper-width 53 --dry-run
python3 m04_print.py samples/66.png --model M04S --serial-number Q171 --paper-width 53 --dry-run
python3 m04_print.py samples/66.png --model M04S --serial-number Q016 --paper-width 53 --dry-run
```

实机运行同样的命令，去掉 `--dry-run`。M04S 默认读取设备完整序列号，因此
可以省略 `--serial-number`。如果查询超时，可核对机身标签后手动提供序列号。
读到的序列号与手动提供的序列号／批次不匹配时停止发送。

```sh
python3 m04_print.py samples/66.png --model M04AS --paper-width 53 --density special
python3 m04_print.py samples/66.png --model M04S --paper-width 53 --repeat 3
python3 m04_print.py --model M04AH --status
python3 m04_print.py --model M04AH --feed-mm 10
```

有多台同型号设备时使用 `--device-address` 指定地址（macOS 上通常为 UUID）。
地址仍须符合所选型号的蓝牙名称。

### 纸宽、点阵宽度与补白

`--paper-width` 是纸卷宽度；53／80／110 mm 对应官方内容宽度
48／72／106 mm。内容宽度按型号 DPI 换算到最接近的 8 点倍数，并限制在
设备内容宽度上限以内。

| 型号 | 53 mm 内容宽度 | 80 mm 内容宽度 | 110 mm 内容宽度 |
| --- | ---: | ---: | ---: |
| M04S | 568 点 | 848 点 | 1248 点 |
| M04AS | 568 点 | 848 点 | 1224 点 |
| M04AH | 384 点 | 576 点 | 848 点 |
| Y04S | 568 点 | 848 点 | 1248 点 |

M04S / Q016、Q171 按官方分支补白：53 mm 左 6／右 18 点，80 mm 右 32 点。
其他纸宽的官方图像补白目标为 1260 像素，头部和点阵循环均向下取整
`width / 8`，因此传输宽度为 1256 点。本实现用 1256 点画布，最后超过
1248 点内容上限的区域必须全白。这是传输补边，不是新增可打印内容宽度。
这些补白路径的实际纸面位置仍待验证。

`--width-dots` 用于明确指定已经准备好的整幅点阵宽度；此时不再补白。
例如原有 592 点基线可以这样生成：

```sh
python3 m04_print.py samples/66.png --model M04S --serial-number Q016 --width-dots 592 --dry-run
```

默认的 53 mm 模式是先缩放到 568 点内容，再加 24 点空白；高度随内容宽度
缩放，因此与原来直接缩放到 592 点的图片高度不同。只有上述显式 592 点
方式要求与原有 `66` 样本逐字节一致。

M04AS／Y04S 提供配置中出现的 15／25 mm 窄纸选项。当前是连续走纸点阵，
不包含间隙标签或黑标纸的自动定位适配。换纸仍需安装对应的实物纸卷。

### 浓度与其他控制项

M04AS 的专用档系数是 100；其他三款为 150。淡／中／浓分别使用
设备值 1／2／4 和系数 100。`--density-coefficient` 可以显式覆盖系数。

`--speed` 仍是未经确认效果的原始协议值，没有映射为快／中／慢。
`--feed-mm` 按各型号 DPI 生成白色点阵，任务尾部另有常规走纸；总纸张位移
尚未校准。电量、盖子、纸张、温度和关机时间的查询复用 ESC 解析器，
超时保留为不可用，不报告为正常。

新入口在每张任务前加上官方策略中的 `1b 40`、`1f 11 35 01`，随后发送
浓度、纸张模式和系数。逐包发送没有固定延时，控制命令与点阵间仍保留
15 ms 边界。现有 M04S 入口的控制顺序保持原样。

### 任务复放

```sh
python3 m04_print.py --model M04S --serial-number Q016 --task samples/m04_printtask_1.bin --dry-run
```

`--task` 校验任务是否符合目标设备编码，不把旧的 LZO bin 自动当作 raw
发送，也不自动转换。换型号时应从原图片重新生成。
`--encoding raw|minilzo` 可用于离线对照；在线发送仍必须符合实际型号和 SN。

## 验证与限制

运行：`python3 -m unittest discover -s tests -v`。

37 项驱动测试通过，涵盖原有驱动以及新增的配置一致性、SN 分支、分片 SN 回应、
raw 格式、所有已列纸宽、补白、203 DPI 走纸、无效编码和发前拒绝错误任务。
原有官方任务和 `66` 基线仍逐字节一致。另有 9 项控制台回归测试通过，
使用独立测试服务和模拟打印机，未接入实物设备。

- 本轮只做离线验证，没有扫描、连接或打印。
- 新型号还需实机确认 FF03 初始化、控制命令效果、完成状态与实际输出。
  不返回预期额度或完成通知的设备会报错，不会自动退回固定延时或报告成功。
- 16 级灰度打印尚未移植；M04AS 当前使用黑白模式。
- 网页控制台仍使用原有 M04S 驱动。新增型号当前通过 `m04_print.py`
  和 `m04_family.py` 使用，网页还没有型号选择器。

文件：`m04_family.py`（型号策略、编码、设备适配）、`m04_print.py`（新入口）、
`tests/test_m04_family.py`（适配验证）、`logs/m04_family_tests.log`（测试记录）、
`artifacts/m04_family_profiles.json`（参数表）。
六种型号／批次的离线样本位于 `artifacts/m04_family/`；综合验证结果位于
`logs/m04_family_verification.json`，控制台回归记录位于
`logs/console/m04_family_regression.log`。

协议依据见 [协议说明](docs/PROTOCOL.md)；最小型号参数在
`tests/fixtures/m04_profiles.json`。SN 查询为 `1f 11 09`，回应是 `1a 08`
加 15 字节 SN，解析分支为 `0x100d6a3a0`。仓库不分发第三方 App 程序。
