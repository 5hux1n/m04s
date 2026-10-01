# 贡献与真机测试

欢迎提交成功或失败的测试记录、协议补充及代码改进。
测试前先核对 [README 的支持范围](README.md#设备支持范围)。

## 已有适配型号

1. 记录精确型号、SN 前 4 位、固件、macOS／Python 版本。
2. 记录项目版本：`git rev-parse --short HEAD`。
3. 开机，断开手机 App，确认实际纸宽。
4. 先运行 `--dry-run`，检查 `artifacts/<编号>/preview.png`。
5. 同一命令去掉 `--dry-run`，检查两枚数字是否完整、边缘和走纸是否正常。
6. 单张成功后再测试 `--repeat 3`，之后测试长图与浓度。

```sh
python m04_print.py samples/66.png --model M04AS --paper-width 53 --dry-run
python m04_print.py samples/66.png --model M04AS --paper-width 53
python m04_print.py samples/66.png --model M04AS --paper-width 53 --repeat 3
```

长图为 `samples/long_12_bands.png`，检查 `01/12` 到 `END 12/12`。
不要改蓝牙名称向未适配的 M02/M03/A4 家族发送 M04 任务。

## 报告内容

- 精确型号、SN 前缀、固件；未知固件版本写“未知”。
- 命令、纸宽、纸型、浓度等参数和纸面照片。
- 相应 `logs/*_summary.json`、`logs/*.jsonl`，以及 `adapter.json`／`settings.json`。
- 是否收到完成通知；失败时具体停在哪里。
- 能使用官方 App 打印同图时，附对照照片。

日志可能含完整 SN、蓝牙地址和本机路径，上传前请打码。
发送完成或额度回满不能判断纸面完成。缺少完成通知时不要自动重发，
因为设备可能已经输出了部分或全部内容。

## 未适配型号与代码贡献

请先提交型号、批次、固件、纸型和官方输出信息，可附公开说明书或打码后的
协议记录。静态策略映射仅为开发线索。不要提交解密 IPA、第三方程序、
访问令牌或私密打印文档。

代码贡献请 Fork、建立分支并提交 Pull Request。执行 README 的软件测试，
分别说明协议假设、证据、离线结果和实机结果。
新适配需独立描述 DPI、宽度、SN／固件、编码、控制、流控和完成状态，
不能因为共享策略就把整个家族标为实机通过。
