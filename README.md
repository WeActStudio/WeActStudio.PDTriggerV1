* [中文版本](./README_zh.md)
# WeActStudio.PDTriggerV1
![display](Images/1.png)
## Documents
- [User Manual](./Doc/PD-Trigger-V1-User-Manual-EN.md)
- [Communication protocol](./Communication%20protocol/WeAct%20Studio%20PDTriggerV1%20Communication%20protocol_v1.0.xlsx)
## Buttons
Three buttons: **ON**, **K1**, **K2**.

- **Short press**: press and release
- **Long press**: hold for about 1 s until the key indicator area shows `W.`, then release
- **ON** works on all screens

| Button | Main | Profile selection | Voltage adjustment | Setup menu |
|---|---|---|---|---|
| **ON** | Short press: toggle output (OUT.ON / OUT.OFF) | Same | Same | Same |
| **K1** | Short press: enter profile selection (when input is PD or QC)<br>Long press: enter setup menu | Short press: previous profile<br>Long press: cancel and return | Short press: decrease voltage (or current)<br>Long press: confirm and return | Short press: next item<br>Long press: save and exit |
| **K2** | Short press: switch display page (Base → Detail 1 → Detail 2)<br>Long press: clear max values (Vm / Im / Pm) and mAh / mWh | Short press: next profile<br>Long press: confirm and apply this profile | Short press: increase voltage (or current)<br>Hold ~1 s until `W.` appears, then release: switch step size<br>Keep holding after `W.` appears: switch adjust target (voltage ↔ current) | Short press: change the value of the current item |

- Main screen pages: Base (large voltage / current + bar graphs) → Detail 1 (Vol, Cur, mAh, mWh, UpT) → Detail 2 (Vm, Im, Pm)
- Adjustment steps: voltage 20 mV / 100 mV / 500 mV / 1 V; current 50 / 100 / 500 / 1000 mA
- Profile selection returns to the main screen after 10 s idle; setup menu saves and exits after 10 s idle

## Setup Items
Entered by **K1 long press**. **K1** short press = next item, **K2** short press = change value, **K1** long press = save and exit.

| Item | Description | Value |
|---|---|---|
| Brightness | Screen brightness | 0–10 |
| Screen Idle Off | Auto screen off after 10 s idle | OFF(0) / ON(1) |
| Screen Reverse | Rotate screen 180° | OFF(0) / ON(1) |
| Output Record | Remember the output profile, restore on next power-up | OFF(0) / ON(1) |
| Power Up OUT.ON | Turn output on automatically at power-up | OFF(0) / ON(1) |
| VSHCT | Shunt voltage conversion time | 140 µs – 8.244 ms |
| VBUSCT | Bus voltage conversion time | 140 µs – 8.244 ms |
| AVG | Averaging count | 1 / 4 / 16 / 64 / 128 / 256 / 512 / 1024 |
| Cur. LSB | Current resolution | 0.1 – 1.0 mA |
| Cur. Offset | Current zero calibration | ±1.5 mA |
| Power Offset | Power zero calibration | ±15 mW |
| Factory Reset | Restore factory settings | OFF(0) / ON(1) (applied on exit) |
| MFR | Manufacturer | WeAct Studio (read-only) |
| MOD | Model | PD Trigger V1 (read-only) |
| S/N | Serial number | 12 hex digits (read-only) |
| (last item) | Firmware version | read-only |

## Web Tools
- [PDTriggerMonitor](https://tools.weactstudio.com/PDTriggerMonitor/) - live V / I / P, PDO switching, INA226 trend
- [FirmwareUpdater](https://tools.weactstudio.com/FirmwareUpdater/) - flash .fpk over USB

**Offline copies** of both tools are in `./Tools` - just double-click the matching `index.html`
(no install, no network needed):

- `Tools/PDTriggerMonitor/` - monitor console
- `Tools/FirmwareUpdater/` - firmware upgrade

Local upgrade tools are also included:

- `Tools/WeActStudio_Upgrade_Tool.7z` - Windows GUI (`64bit/WeActStudio_Upgrade_Tool.exe`)
- `Tools/WeActStudio_Upgrade_Tool_Python.7z` - command line
## Online Emulator
<https://pd-trigger-v1-emu.app.workbuddy.host/>

The **real firmware** compiled to WebAssembly, running in the browser. The ST7735S screen,
the INA226 gauge and the three keys are modelled as devices, and the virtual source can be
switched between PD / QC / DC with a configurable PDO list, plus an electronic load.
So the UI and the PD / QC flow can be operated and verified without any hardware.
Logic and UI only - there is no real electrical timing.

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
