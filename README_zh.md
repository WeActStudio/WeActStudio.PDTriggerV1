* [English version](./README.md)
# WeActStudio.PDTriggerV1
![display](Images/2.png)
## 文档
- [使用说明](./Doc/PD-Trigger-V1-使用说明-CN.md)
- [通讯协议](./Communication%20protocol/WeAct%20Studio%20PDTriggerV1%20Communication%20protocol_v1.0.xlsx)
## 按键
三个按键：**ON**、**K1**、**K2**。

- **短按**：按下后松开
- **长按**：按住约 1 s，屏幕按键提示区出现 `W.` 后松开
- **ON** 在所有界面均有效

| 按键 | 主界面 | 档位选择页 | 调压页 | 设置菜单 |
|---|---|---|---|---|
| **ON** | 短按：开 / 关输出（OUT.ON / OUT.OFF） | 同左 | 同左 | 同左 |
| **K1** | 短按：进入档位选择（输入为 PD 或 QC 时）<br>长按：进入设置菜单 | 短按：上一档<br>长按：取消并返回 | 短按：减小电压（或电流）<br>长按：确认并返回 | 短按：下一项<br>长按：保存并退出 |
| **K2** | 短按：切换显示页（基础 → 详细 1 → 详细 2）<br>长按：清零最大值（Vm / Im / Pm） | 短按：下一档<br>长按：确认并应用该档位 | 短按：增大电压（或电流）<br>长按约 1 s（出现 `W.`）后松开：切换步进<br>出现 `W.` 后继续按住：切换调节对象（电压 ↔ 电流） | 短按：修改当前项的值 |

- 主界面显示页：基础（电压 / 电流大字 + 条形图）→ 详细 1（Vol、Cur、mAh、mWh、UpT）→ 详细 2（Vm、Im、Pm）
- 调压页步进：电压 20 mV / 100 mV / 500 mV / 1 V；电流 50 / 100 / 500 / 1000 mA
- 档位选择页无操作 10 秒自动返回主界面；设置菜单无操作 10 秒自动保存退出

## 设置项
**K1 长按**进入。**K1** 短按下一项，**K2** 短按修改当前项的值，**K1** 长按保存并退出。

| 设置项 | 说明 | 取值 |
|---|---|---|
| Brightness | 屏幕亮度 | 0–10 |
| Screen Idle Off | 无操作 10 秒自动息屏 | OFF(0) / ON(1) |
| Screen Reverse | 屏幕旋转 180° | OFF(0) / ON(1) |
| Output Record | 记录输出档位，下次上电恢复 | OFF(0) / ON(1) |
| Power Up OUT.ON | 上电自动打开输出 | OFF(0) / ON(1) |
| VSHCT | 分流电压转换时间 | 140 µs – 8.244 ms |
| VBUSCT | 总线电压转换时间 | 140 µs – 8.244 ms |
| AVG | 平均次数 | 1 / 4 / 16 / 64 / 128 / 256 / 512 / 1024 |
| Cur. LSB | 电流分辨率 | 0.1 – 1.0 mA |
| Cur. Offset | 电流零点校准 | ±1.5 mA |
| Power Offset | 功率零点校准 | ±15 mW |
| Factory Reset | 恢复出厂设置 | OFF(0) / ON(1)（退出时执行） |
| MFR | 厂商 | WeAct Studio（只读） |
| MOD | 型号 | PD Trigger V1（只读） |
| S/N | 序列号 | 12 位十六进制（只读） |
| （末项） | 固件版本 | 只读 |

## 网页工具
- [监控控制台](https://tools.weactstudio.com/PDTriggerMonitor/)：实时电压 / 电流 / 功率、PDO 切换、INA226 趋势
- [固件升级](https://tools.weactstudio.com/FirmwareUpdater/)：USB 刷写 .fpk

两个工具的**离线副本**在 `./Tools`，双击对应的 `index.html` 即可打开（无需安装、无需联网）：

- `Tools/PDTriggerMonitor/` —— 监控控制台
- `Tools/FirmwareUpdater/` —— 固件升级

另含本地升级工具：

- `Tools/WeActStudio_Upgrade_Tool.7z` —— Windows 图形界面（`64bit/WeActStudio_Upgrade_Tool.exe`）
- `Tools/WeActStudio_Upgrade_Tool_Python.7z` —— 命令行
## 在线仿真
<https://pd-trigger-v1-emu.app.workbuddy.host/>

把**真实固件**编译成 WebAssembly 在浏览器里运行：屏幕（ST7735S）、INA226、三个按键都有器件模型，
虚拟电源可在 PD / QC / DC 之间切换并配置 PDO 档位，另带电子负载 —— 不接硬件就能操作界面、
跑通 PD / QC 流程。只用于验证逻辑与界面，不含真实电气时序。

```
/*---------------------------------------
- WeAct Studio Official Link
- taobao: WeActStudio.taobao.com
- aliexpress 1: WeActStudio.aliexpress.com
- aliexpress 2: WeActStudioOne.aliexpress.com
- github: github.com/WeActStudio
- gitee: gitee.com/WeAct-TC
- blog: www.weact-tc.cn
---------------------------------------*/
```