import serial
import time
import threading
from queue import Queue, Empty, Full
from enum import IntEnum
import traceback
import struct


class Command(IntEnum):
    """
    通讯命令字定义 (协议 v1.0)
    Communication command code definitions (protocol v1.0)
    """
    CMD_WHO_AM_I = 0x01
    CMD_OUTPUT_DATA = 0x02
    CMD_OUTPUT_DATA_MAX = 0x03
    CMD_MAH_MWH = 0X04
    CMD_UPTIME = 0x05
    CMD_OUTPUT_DATA_MAX_RESET = 0x06
    CMD_INPUT_TYPE = 0x07
    CMD_PD_PDO_FIX = 0x08
    CMD_PD_PDO_PPS = 0x09
    CMD_PD_PDO = 0x0A
    CMD_PD_PDO_AVS = 0x0B
    CMD_PD_PDO_NUM= 0x0C
    CMD_PD_PDO2 = 0x0D
    CMD_OUTPUT_ENABLE = 0x0E
    CMD_SYSTEM_RESET = 0x40
    CMD_SYSTEM_VERSION = 0x42
    CMD_SYSTEM_SERIAL_NUM = 0x43
    CMD_SYSTEM_FACTORY_RESET = 0x45
    CMD_SYSTEM_LCD_PANEL_TYPE = 0x46
    CMD_SYSTEM_CURRENT_RSHUNT = 0x47
    CMD_SYSTEM_CURRENT_OFFSET = 0x48
    CMD_SYSTEM_INA226_CONFIG = 0x49
    CMD_END = 0x0A
    CMD_READ = 0x80

    @property
    def READ_LENGTH(self):
        """
        命令对应定长响应帧的总字节数 (含命令字节与帧尾)
        Total byte count of the fixed-length response frame (including command byte and frame tail)
        """
        return {
            Command.CMD_WHO_AM_I: 0,
            Command.CMD_OUTPUT_DATA: 14,
            Command.CMD_OUTPUT_DATA_MAX: 14,
            Command.CMD_MAH_MWH: 10,
            Command.CMD_UPTIME: 6,
            Command.CMD_INPUT_TYPE: 3,
            Command.CMD_PD_PDO_FIX: 0,
            Command.CMD_PD_PDO_PPS: 0,
            Command.CMD_PD_PDO: 5,
            Command.CMD_PD_PDO_AVS: 0,
            Command.CMD_PD_PDO_NUM: 5,
            Command.CMD_PD_PDO2: 7,
            Command.CMD_OUTPUT_ENABLE: 3,
            Command.CMD_SYSTEM_LCD_PANEL_TYPE: 3,
            Command.CMD_SYSTEM_CURRENT_RSHUNT: 3,
            Command.CMD_SYSTEM_VERSION: 0,
            Command.CMD_SYSTEM_SERIAL_NUM: 0,
            Command.CMD_SYSTEM_CURRENT_OFFSET: 22,
            Command.CMD_SYSTEM_INA226_CONFIG: 5,
        }.get(self, 0)


# 使用变长帧响应的命令集合
# Commands whose responses use the variable-length frame format
# 帧格式: [cmd|0x80, len, payload(len), CMD_END], 总长 len+3 字节
# Frame format: [cmd|0x80, len, payload(len), CMD_END], total length len+3 bytes
_VARIABLE_LENGTH_COMMANDS = frozenset([
    Command.CMD_WHO_AM_I,
    Command.CMD_SYSTEM_VERSION,
    Command.CMD_SYSTEM_SERIAL_NUM,
    Command.CMD_PD_PDO_FIX,
    Command.CMD_PD_PDO_PPS,
    Command.CMD_PD_PDO_AVS,
])

# 变长帧固定开销: 命令字节 + 长度字节 + 帧尾字节
# Variable-length frame overhead: command byte + length byte + frame tail byte
_VAR_FRAME_OVERHEAD = 3

LCD_PANEL_TYPE = {
    1: "BOE",
    0: "HAN",
}

INPUT_TYPE = {
    0: "Initialization",
    1: "PD",
    2: "QC",
    3: "DC",
    4: "Initialization",
}


class Com_PDTriggerV1:
    """
    WeAct Studio PD Trigger V1 通讯类
    WeAct Studio PD Trigger V1 communication class

    注意: 设备为 USB CDC 虚拟串口, 波特率仅为形式参数, 不影响实际吞吐
    Note: the device is a USB CDC virtual COM port, the baudrate is a
    formal parameter only and does not limit the actual throughput
    """

    # 请求-响应默认超时 (秒) / Default request-response timeout (seconds)
    RESPONSE_TIMEOUT = 1.0

    def __init__(self, port, baudrate=115200, timeout=1, queue_maxsize=100):
        """
        打开串口并启动读写线程
        Open the serial port and start the reader/sender threads
        """
        self.ser = serial.Serial(port, baudrate, timeout=timeout)
        if not self.ser.is_open:
            raise Exception(f"无法打开串口 Unable to open serial port {port}")
        time.sleep(0.1)
        self._stop_event = threading.Event()
        self._read_ok_event = threading.Event()
        self._write_ok_event = threading.Event()
        self._read_result = None
        # 串行化所有请求-响应事务, 避免多线程调用时响应错位
        # Serialize all request-response transactions to prevent response mismatch on concurrent calls
        self._io_lock = threading.RLock()
        self._send_queue = Queue(maxsize=queue_maxsize)
        self._read_thread = threading.Thread(target=self._read_serial, daemon=True)
        self._read_thread.start()
        self._send_thread = threading.Thread(target=self._send_commands, daemon=True)
        self._send_thread.start()

    # ------------------------------------------------------------------ #
    # 后台线程 / Background threads
    # ------------------------------------------------------------------ #

    def _read_serial(self):
        """
        线程函数，持续读取串口数据并解析协议帧
        Thread function, continuously read serial data and parse protocol frames
        """
        buffer = bytearray()
        time_last = time.time()
        while not self._stop_event.is_set():
            try:
                # 阻塞式读取: 有数据读满缓冲, 无数据最多等待串口 timeout
                # Blocking read: drain available data, otherwise wait up to the serial timeout
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    buffer += data
                    time_last = time.time()
                elif time.time() - time_last > 0.05:
                    # 长时间无数据, 丢弃残留的不完整帧
                    # No data for a while, discard the leftover incomplete frame
                    buffer.clear()
                    time_last = time.time()

                if buffer:
                    consumed = self._parse_buffer(buffer)
                    if consumed < 0:
                        buffer.clear()
                    elif consumed > 0:
                        del buffer[:consumed]

            except serial.SerialException as e:
                print(f"串口断开连接 Serial port disconnected: {e}")
                traceback.print_exc()
                self.ser.close()
                return
            except Exception as e:
                print(f"读取串口数据时出错 Error reading serial port data: {e}")
                traceback.print_exc()
                buffer.clear()

    def _parse_buffer(self, buffer):
        """
        解析缓冲区中的协议帧
        Parse protocol frames inside the buffer

        Returns:
            >=0: 从缓冲区头部消耗的字节数 (返回 0 表示仍在等待后续数据)
                 Number of bytes consumed from the head of the buffer (0 means waiting for more data)
            -1 : 帧错误或未知命令, 需要丢弃整个缓冲区
                 Frame error or unknown command, the whole buffer must be dropped
        """
        pos = 0
        while pos < len(buffer):
            cmd = buffer[pos] & 0x7F
            if cmd in _VARIABLE_LENGTH_COMMANDS:
                # 变长帧: [cmd, len, payload(len), CMD_END] / variable-length frame
                if len(buffer) - pos < 2:
                    break
                total = buffer[pos + 1] + _VAR_FRAME_OVERHEAD
                if len(buffer) - pos < total:
                    break
                self._dispatch_response(bytes(buffer[pos:pos + total]), payload_start=2)
                pos += total
            else:
                try:
                    read_length = Command(cmd).READ_LENGTH
                except ValueError:
                    return -1
                if read_length == 0:
                    return -1
                if len(buffer) - pos < read_length:
                    break
                # 定长帧: [cmd, payload(read_length-2), CMD_END] / fixed-length frame
                self._dispatch_response(bytes(buffer[pos:pos + read_length]), payload_start=1)
                pos += read_length
        return pos

    def _dispatch_response(self, frame, payload_start):
        """
        保存响应载荷并通知等待中的请求
        Store the response payload and notify the pending request
        """
        # 去掉命令字节(与长度字节)和帧尾字节
        # Strip the command byte (and length byte) plus the frame tail byte
        self._read_result = frame[payload_start:-1]
        self._read_ok_event.set()

    def _send_commands(self):
        """
        线程函数，处理队列中的指令发送
        Thread function, handle command sending from the queue
        """
        while not self._stop_event.is_set():
            try:
                w_data = self._send_queue.get(timeout=0.1)
                self.ser.write(w_data)
                self._write_ok_event.set()
            except Empty:
                pass
            except serial.SerialException as e:
                print(f"串口断开连接 Serial port disconnected: {e}")
                traceback.print_exc()
                self.ser.close()
                return
            except Exception as e:
                print(f"发送指令时出错 Error sending command: {e}")

    # ------------------------------------------------------------------ #
    # 底层收发 / Low level transmit and receive
    # ------------------------------------------------------------------ #

    def send_command(self, cmd, wait=False):
        """
        将指令帧放入发送队列
        Put a command frame into the send queue

        cmd:  待发送的字节数据 / bytes to send
        wait: True 时等待数据真正写出完成 / True to wait until the data is actually written
        """
        self._write_ok_event.clear()
        try:
            self._send_queue.put(cmd, timeout=0.5)
        except Full:
            print("发送指令队列已满，指令丢弃 Command queue is full, command discarded")
            raise ValueError("Command queue is full, command discarded")
        if wait and not self._write_ok_event.wait(timeout=self.RESPONSE_TIMEOUT):
            print("等待响应超时 Timeout waiting for send command")
            raise ValueError("Timeout waiting for send command")

    def _build_frame(self, payload):
        """
        构造协议帧: payload + CMD_END 帧尾
        Build a protocol frame: payload + CMD_END tail
        """
        s = bytearray(payload)
        s.append(Command.CMD_END)
        return bytes(s)

    def _request(self, payload, timeout=None):
        """
        发送读取请求并等待响应 (线程安全, 同一时刻只处理一个事务)
        Send a read request and wait for the response (thread-safe, one transaction at a time)

        Returns:
            响应数据 (bytes), 超时返回 None
            Response payload (bytes), None on timeout
        """
        if timeout is None:
            timeout = self.RESPONSE_TIMEOUT
        with self._io_lock:
            self._read_ok_event.clear()
            self.send_command(self._build_frame(payload))
            if not self._read_ok_event.wait(timeout=timeout):
                print("等待响应超时 Timeout waiting for response")
                return None
            return self._read_result

    def _write(self, payload):
        """
        发送写入命令并等待写出完成
        Send a write command and wait for the write to complete
        """
        self.send_command(self._build_frame(payload), True)

    # ------------------------------------------------------------------ #
    # 基础信息 / Basic information
    # ------------------------------------------------------------------ #

    def who_am_i(self):
        """
        获取设备标识字符串
        Get the device identification string
        """
        r = self._request(bytes([Command.CMD_WHO_AM_I | Command.CMD_READ]))
        return r.decode('utf-8') if r is not None else None

    def system_version(self):
        """
        获取固件版本号
        Get the firmware version string
        """
        r = self._request(bytes([Command.CMD_SYSTEM_VERSION | Command.CMD_READ]))
        return r.decode('utf-8') if r is not None else None

    def system_serial_num(self):
        """
        获取设备序列号
        Get the device serial number
        """
        r = self._request(bytes([Command.CMD_SYSTEM_SERIAL_NUM | Command.CMD_READ]))
        return r.decode('utf-8') if r is not None else None

    def factory_reset(self):
        """
        恢复出厂校准参数
        Restore the factory calibration data
        """
        self._write(bytes([Command.CMD_SYSTEM_FACTORY_RESET]))

    # ------------------------------------------------------------------ #
    # 校准参数 / Calibration parameters
    # ------------------------------------------------------------------ #

    def current_rshunt_get(self):
        """
        获取电流采样电阻值
        Get the current sampling resistor value
        """
        r = self._request(bytes([Command.CMD_SYSTEM_CURRENT_RSHUNT | Command.CMD_READ]))
        return int(r[0]) if r is not None else None

    def current_rshunt_set(self, value):
        """
        设置电流采样电阻值
        Set the current sampling resistor value
        value: 0-255
        """
        if value < 0 or value > 255:
            raise ValueError("Current RSHUNT value must be between 0 and 255")
        self._write(bytes([Command.CMD_SYSTEM_CURRENT_RSHUNT, value]))

    def current_offset_get(self):
        """
        获取电流偏移校准值
        Get the current offset calibration values

        offset0: {"display": int, "actual": int}
        offset1: {"display": int, "actual": int}
        zero_offset: int
        unit: 0.1mA
        """
        r = self._request(bytes([Command.CMD_SYSTEM_CURRENT_OFFSET | Command.CMD_READ]))
        if r is None:
            return None

        value = struct.unpack("<iiiii", r)
        offset0 = {"display": value[0], "actual": value[1]}
        offset1 = {"display": value[2], "actual": value[3]}
        zero_offset = int(value[4])
        return offset0, offset1, zero_offset

    def current_offset_set(self, offset0_display, offset0_actual, offset1_display, offset1_actual, zero_offset):
        """
        设置电流偏移校准值，offset1必须大于offset0，且同为正数或同为负数
        Set the current offset calibration values,
        offset1 must be greater than offset0 and share the same sign

        offset0_display: ±1000000, unit: 0.1mA
        offset0_actual: ±1000000, unit: 0.1mA
        offset1_display: ±1000000, unit: 0.1mA
        offset1_actual: ±1000000, unit: 0.1mA
        zero_offset: ±15, unit: 0.1mA
        """
        if offset0_display < -1000000 or offset0_display > 1000000:
            raise ValueError("offset0_display must be between -1000000 and 1000000")
        if offset0_actual < -1000000 or offset0_actual > 1000000:
            raise ValueError("offset0_actual must be between -1000000 and 1000000")
        if offset1_display < -1000000 or offset1_display > 1000000:
            raise ValueError("offset1_display must be between -1000000 and 1000000")
        if offset1_actual < -1000000 or offset1_actual > 1000000:
            raise ValueError("offset1_actual must be between -1000000 and 1000000")
        if zero_offset < -15 or zero_offset > 15:
            raise ValueError("zero_offset must be between -15 and 15")

        data = struct.pack("<iiiii", offset0_display, offset0_actual, offset1_display, offset1_actual, zero_offset)
        self._write(bytes([Command.CMD_SYSTEM_CURRENT_OFFSET]) + data)

    def ina226_config_get(self):
        """
        获取INA226采样配置
        Get the INA226 sampling configuration
        "currentLSB": unit: 0.1mA
        """
        r = self._request(bytes([Command.CMD_SYSTEM_INA226_CONFIG | Command.CMD_READ]))
        if r is None:
            return None

        currentLSB, config_reg = struct.unpack("<BH", r)

        vshct   = (config_reg >> 3)  & 0x07   # bit3-5 分流电压转换时间 shunt voltage conversion time
        vbusct  = (config_reg >> 6)  & 0x07   # bit6-8 总线电压转换时间 bus voltage conversion time
        avg     = (config_reg >> 9)  & 0x07   # bit9-11 平均次数 averaging mode

        return {
            "currentLSB": currentLSB,
            "reg_value": config_reg,
            "reg":{
                "vshct": vshct,
                "vbusct": vbusct,
                "avg": avg,
            }
        }

    def ina226_config_set(self,currentLSB=3,vshct=3,vbusct=3,avg=5):
        """
        设置INA226采样配置
        Set the INA226 sampling configuration
        currentLSB: 1-10, unit: 0.1mA
        vshct: 0-7
        vbusct: 0-7
        avg: 0-7
        """
        if currentLSB < 1 or currentLSB > 10:
            raise ValueError("currentLSB must be between 1 and 10")
        if vshct < 0 or vshct > 7:
            raise ValueError("vshct must be between 0 and 7")
        if vbusct < 0 or vbusct > 7:
            raise ValueError("vbusct must be between 0 and 7")
        if avg < 0 or avg > 7:
            raise ValueError("avg must be between 0 and 7")

        data = struct.pack("<BH", currentLSB, (0 << 0) | (vshct << 3) | (vbusct << 6) | (avg << 9) | (4 << 12) | 0)
        self._write(bytes([Command.CMD_SYSTEM_INA226_CONFIG]) + data)

    # INA226 转换时间索引与人眼可读字符串的映射表
    # INA226 conversion time index -> human readable string
    ina226_vbusct_vshct_str = [
        "140uS",
        "204uS",
        "332uS",
        "588uS",
        "1.1ms",
        "2.116ms",
        "4.156ms",
        "8.244ms",
    ]

    # INA226 平均次数索引与采样数的映射表
    # INA226 averaging index -> sample count
    ina226_avg_value = [
        1, 4, 16, 64, 128, 256, 512, 1024
    ]

    def ina226_vbusct_vshct_str_get(self,value):
        """
        转换时间索引转字符串
        Convert a conversion time index to string
        """
        return self.ina226_vbusct_vshct_str[value]

    def ina226_vbusct_vshct_value_get(self,vbusct_str):
        """
        字符串转转换时间索引
        Convert a string to a conversion time index
        """
        return self.ina226_vbusct_vshct_str.index(vbusct_str)

    def ina226_avg_get(self,avg):
        """
        平均次数索引转采样数
        Convert an averaging index to the sample count
        """
        return self.ina226_avg_value[avg]

    def ina226_avg_value_get(self,avg_str):
        """
        采样数转平均次数索引
        Convert a sample count to an averaging index
        """
        return self.ina226_avg_value.index(avg_str)

    def ina226_currentLSB_str_get(self,value):
        """
        电流LSB数值转字符串
        Convert the current LSB value to string
        """
        return f"{value*0.1:.1f}mA"

    def ina226_currentLSB_value_get(self, currentLSB_str):
        """
        字符串转电流LSB数值
        Convert a string to the current LSB value
        """
        num_str = currentLSB_str.replace("mA", "")
        value = float(num_str)
        return int(value / 0.1)

    def lcd_panel_get(self):
        """
        获取LCD屏幕厂家类型
        Get the LCD panel type
        """
        r = self._request(bytes([Command.CMD_SYSTEM_LCD_PANEL_TYPE | Command.CMD_READ]))
        return int(r[0]) if r is not None else None

    # ------------------------------------------------------------------ #
    # 输出数据 / Output data
    # ------------------------------------------------------------------ #

    def output_data(self):
        """
        获取当前输出数据: 电压/电流/功率
        Get the current output data: voltage / current / power
        unit: mV, 0.1mA, mW
        """
        r = self._request(bytes([Command.CMD_OUTPUT_DATA | Command.CMD_READ]))
        if r is None:
            raise ValueError("output_data: None")
        voltage,current,power = struct.unpack("<IiI", r)
        return voltage,current,power

    def output_data_max(self):
        """
        获取最大输出数据记录: 电压/电流/功率
        Get the maximum output data record: voltage / current / power
        unit: mV, 0.1mA, mW
        """
        r = self._request(bytes([Command.CMD_OUTPUT_DATA_MAX | Command.CMD_READ]))
        if r is None:
            return None
        voltage,current,power = struct.unpack("<IiI", r)
        return voltage,current,power

    def maH_mwH(self):
        """
        获取累计容量与累计能量
        Get the accumulated capacity and energy
        unit: mAh, mWh
        """
        r = self._request(bytes([Command.CMD_MAH_MWH | Command.CMD_READ]))
        if r is None:
            return None
        maH,mwH = struct.unpack("<II", r)
        return maH,mwH

    def uptime(self):
        """
        获取运行时间
        Get the uptime
        unit: seconds
        """
        r = self._request(bytes([Command.CMD_UPTIME | Command.CMD_READ]))
        if r is None:
            return None
        return struct.unpack("<I", r)[0]

    def output_data_max_reset(self):
        """
        清除最大输出数据记录
        Clear the maximum output data record
        """
        self._write(bytes([Command.CMD_OUTPUT_DATA_MAX_RESET]))

    def input_type_get(self):
        """
        获取输入类型 (PD/QC/DC)
        Get the input type (PD/QC/DC)
        """
        r = self._request(bytes([Command.CMD_INPUT_TYPE | Command.CMD_READ]))
        return int(r[0]) if r is not None else None

    # ------------------------------------------------------------------ #
    # PD PDO
    # ------------------------------------------------------------------ #

    def _pdo_list_get(self, cmd, element_size, fields):
        """
        PDO 列表读取通用方法
        Generic PDO list getter
        每个元素占用 element_size 字节的小端 uint16 字段, 字段名由 fields 指定
        Each element consists of little-endian uint16 fields occupying element_size bytes, named by fields
        """
        r = self._request(bytes([cmd | Command.CMD_READ]))
        if r is None:
            return None

        # 确保数据长度足够 / make sure there is enough data
        if len(r) < 1:
            print("PDO数据格式错误: 数据长度不足 PDO data format error: insufficient data length")
            return None

        count = len(r) // element_size
        byte_count = count * element_size
        values = struct.unpack(f"<{count * len(fields)}H", r[:byte_count])
        data = [
            dict(zip(fields, values[i * len(fields):(i + 1) * len(fields)]))
            for i in range(count)
        ]
        return {"count": count, "data": data}

    def pd_pdo_fix_get(self):
        """
        获取PDO固定数据
        Get PDO fixed data

        Returns:
            dict: 包含count和fixeddata列表的数据结构
                  A dict containing count and the fixeddata list
            Example:
            {
                "count": 2,
                "fixeddata": [
                    {"voltage": 5000, "current": 3000},
                    {"voltage": 9000, "current": 2000}
                ]
            }
        unit: mV, mA
        """
        result = self._pdo_list_get(Command.CMD_PD_PDO_FIX, 4, ("voltage", "current"))
        if result is not None:
            result["fixeddata"] = result.pop("data")
        return result

    def pd_pdo_pps_get(self):
        """
        获取PDO PPS数据
        Get PDO PPS data

        Returns:
            dict: 包含count和ppsdata列表的数据结构
                  A dict containing count and the ppsdata list
            Example:
            {
                "count": 2,
                "ppsdata": [
                    {"minvoltage": 5000, "maxvoltage": 9000, "maxcurrent": 3000},
                    {"minvoltage": 9000, "maxvoltage": 15000, "maxcurrent": 2000}
                ]
            }
        unit: mV, mA
        """
        result = self._pdo_list_get(Command.CMD_PD_PDO_PPS, 6, ("minvoltage", "maxvoltage", "maxcurrent"))
        if result is not None:
            result["ppsdata"] = result.pop("data")
        return result

    def pd_pdo_avs_get(self):
        """
        获取PDO AVS数据
        Get PDO AVS data

        Returns:
            dict: 包含count和avsdata列表的数据结构
                  A dict containing count and the avsdata list
            Example:
            {
                "count": 2,
                "avsdata": [
                    {"minvoltage": 15000, "maxvoltage": 28000, "maxpower": 240},
                    {"minvoltage": 15000, "maxvoltage": 36000, "maxpower": 240}
                ]
            }
        unit: mV, W
        """
        result = self._pdo_list_get(Command.CMD_PD_PDO_AVS, 6, ("minvoltage", "maxvoltage", "maxpower"))
        if result is not None:
            result["avsdata"] = result.pop("data")
        return result

    def pd_pdo_num(self):
        """
        获取PDO数量 (固定/PPS/AVS)
        Get the PDO numbers (fixed / PPS / AVS)
        """
        r = self._request(bytes([Command.CMD_PD_PDO_NUM | Command.CMD_READ]))
        if r is None:
            return None

        # 确保数据长度足够 / make sure there is enough data
        if len(r) != 3:
            print("PDO数据格式错误: 数据长度不足 PDO data format error: insufficient data length")
            return None

        return int(r[0]), int(r[1]), int(r[2])

    def pd_pdo_now(self):
        """
        获取当前PDO数据 (不含电流)
        Get the current PDO data (without current)
        id: 1-11
        voltage unit: mV
        """
        r = self._request(bytes([Command.CMD_PD_PDO | Command.CMD_READ]))
        if r is None:
            return None

        # 确保数据长度足够 / make sure there is enough data
        if len(r) != 3:
            print("PDO数据格式错误: 数据长度不足 PDO data format error: insufficient data length")
            return None

        id = int(r[0])
        voltage = struct.unpack("<H", r[1:3])[0]
        return id, voltage

    def pd_pdo_now2(self):
        """
        获取当前PDO数据 (含电流)
        Get the current PDO data (including current)
        id: 1-11
        voltage unit: mV
        current unit: mA
        """
        r = self._request(bytes([Command.CMD_PD_PDO2 | Command.CMD_READ]))
        if r is None:
            return None

        # 确保数据长度足够 / make sure there is enough data
        if len(r) != 5:
            print("PDO数据格式错误: 数据长度不足 PDO data format error: insufficient data length")
            return None

        id = int(r[0])
        voltage, current = struct.unpack("<HH", r[1:5])
        return id, voltage, current

    def pd_pdo_set(self, id, voltage):
        """
        请求指定PDO电压
        Request a PDO voltage
        id: 1-11
        voltage unit: mV
        """
        if id < 0 or id > 255:
            raise ValueError("PDO id must be between 0 and 255")
        if voltage < 0 or voltage > 65535:
            raise ValueError("PDO voltage must be between 0 and 65535 mV")
        self._write(struct.pack("<BBH", Command.CMD_PD_PDO, id, voltage))

    def pd_pdo_set2(self, id, voltage, current):
        """
        请求指定PDO电压与电流上限
        Request a PDO voltage with a current limit
        id: 1-11
        voltage unit: mV
        current unit: mA
        """
        if id < 0 or id > 255:
            raise ValueError("PDO id must be between 0 and 255")
        if voltage < 0 or voltage > 65535:
            raise ValueError("PDO voltage must be between 0 and 65535 mV")
        if current < 0 or current > 65535:
            raise ValueError("PDO current must be between 0 and 65535 mA")
        self._write(struct.pack("<BBHH", Command.CMD_PD_PDO2, id, voltage, current))

    def output_enable(self, enable):
        """
        设置输出使能
        Set the output enable
        enable: 0-1
        """
        self._write(bytes([Command.CMD_OUTPUT_ENABLE, 1 if enable else 0]))

    # ------------------------------------------------------------------ #
    # 连接管理 / Connection management
    # ------------------------------------------------------------------ #

    def close(self):
        """
        关闭串口连接并停止读取线程和发送线程
        Close the serial port connection and stop the reader and sender threads
        """
        self._stop_event.set()
        if self._read_thread.is_alive():
            self._read_thread.join()
        if self._send_thread.is_alive():
            self._send_thread.join()
        if self.ser.is_open:
            self.ser.close()

    def is_open(self):
        """
        返回串口是否处于打开状态
        Return whether the serial port is open
        """
        return self.ser.is_open


def parse_version(ver_str: str):
    """
    解析版本号字符串为整数列表, 解析失败返回 None
    Parse a version string into a list of integers, None if parsing fails
    """
    # 1. 去除v前缀 / strip the leading 'v'
    s = ver_str.lstrip("vV")
    # 2. 切掉下划线后缀 / cut the underscore suffix
    s = s.split("_")[0]
    # 3. 按点分割，转整数列表 / split by dot and convert to integers
    parts = []
    for p in s.split("."):
        if p.isdigit():
            parts.append(int(p))
        else:
            return None
    return parts


def ver_gt(ver_a: str, ver_b: str) -> bool:
    """
    判断版本号 ver_a 是否大于 ver_b
    Compare whether ver_a is greater than ver_b
    """
    a = parse_version(ver_a)
    b = parse_version(ver_b)
    if a is None or b is None:
        raise ValueError("版本号格式错误 Version number format error: invalid version number")
    # 补齐长度，短版本后面补0 / pad the shorter version with zeros
    max_len = max(len(a), len(b))
    a += [0] * (max_len - len(a))
    b += [0] * (max_len - len(b))
    return a > b


if __name__ == "__main__":
    import sys

    print("WeAct PD Trigger V1 Example")
    if len(sys.argv) > 1:
        port = sys.argv[1]
        if len(sys.argv) > 2:
            print("error: extra arguments")
            exit(1)
    else:
        print("请输入串口端口号 Please enter the serial port number")
        print("示例: python com_PDTriggerV1.py COM19")
        exit(1)

    c = Com_PDTriggerV1(port, baudrate=9600)

    print("who_am_i:",c.who_am_i())
    version = c.system_version()
    print("system_version:",version)
    print("system_serial_num:",c.system_serial_num())
    print("Current_rshunt:",c.current_rshunt_get(), "ohm")
    print("LCD_panel:",LCD_PANEL_TYPE.get(c.lcd_panel_get(), "Unknown"))

    voltage,current,power = c.output_data()
    print("Voltage:",voltage/1000,"V")
    print("Current:",current/10000,"A")
    print("Power:",power/1000,"W")

    voltage,current,power = c.output_data_max()
    print("Voltage_max:",voltage/1000,"V")
    print("Current_max:",current/10000,"A")
    print("Power_max:",power/1000,"W")

    maH,mwH = c.maH_mwH()
    print("maH:",maH,"mAh")
    print("mwH:",mwH,"mWh")
    print("uptime:",c.uptime(),"s")

    input_type = c.input_type_get()
    print("Input_type:",INPUT_TYPE.get(input_type, "Unknown"))

    if INPUT_TYPE.get(input_type) == "PD":
        fixed_num, pps_num, avs_num = c.pd_pdo_num()
        print("fixed_num:",fixed_num,"pps_num:",pps_num,"avs_num:",avs_num)

        if fixed_num:
            pd_pdo_fix = c.pd_pdo_fix_get()
            print("pd_pdo_fix:",pd_pdo_fix)

        if pps_num:
            pd_pdo_pps = c.pd_pdo_pps_get()
            print("pd_pdo_pps:",pd_pdo_pps)

        if avs_num:
            pd_pdo_avs = c.pd_pdo_avs_get()
            print("pd_pdo_avs:",pd_pdo_avs)


        if ver_gt(version, "v1.0.0.3"):
            print("pd_pdo_set2")
            pdo_id,pdo_voltage,current = c.pd_pdo_now2()
            print("pdo now2: id:",pdo_id,"voltage:",pdo_voltage/1000,"V","current:",current/1000,"A")
            c.pd_pdo_set2(2, pd_pdo_fix['fixeddata'][1]['voltage'],pd_pdo_fix['fixeddata'][1]['current'])
        else:
            pdo_id,pdo_voltage = c.pd_pdo_now()
            print("pdo now: id:",pdo_id,"voltage:",pdo_voltage/1000,"V")
            c.pd_pdo_set(2, pd_pdo_fix['fixeddata'][1]['voltage'])

        print("pd_pdo_set: id:",2,"voltage:",pd_pdo_fix['fixeddata'][1]['voltage']/1000,"V")

        time.sleep(0.1)

        pdo_id,pdo_voltage = c.pd_pdo_now()
        print("pdo now: id:",pdo_id,"voltage:",pdo_voltage/1000,"V")

    current_offset0,current_offset1,current_zero = c.current_offset_get()
    print("offset0 display:",current_offset0["display"]/10000,"A","actual:",current_offset0["actual"]/10000,"A")
    print("offset1 display:",current_offset1["display"]/10000,"A","actual:",current_offset1["actual"]/10000,"A")
    print("zero :",current_zero/10000,"A")

    # c.current_offset_set(5110,5073,10155,10080,0)

    ina226_config = c.ina226_config_get()
    print("ina226_config:",ina226_config)
    print("ina226_currentLSB_str:",c.ina226_currentLSB_str_get(ina226_config["currentLSB"]))
    print("ina226_reg_vshct:",c.ina226_vbusct_vshct_str_get(ina226_config["reg"]["vshct"]))
    print("ina226_reg_vbusct:",c.ina226_vbusct_vshct_str_get(ina226_config["reg"]["vbusct"]))
    print("ina226_reg_avg:",c.ina226_avg_get(ina226_config["reg"]["avg"]))

    # c.ina226_config_set(currentLSB=2,vbusct=2,avg=4,vshct=4)

    # c.output_data_max_reset()

    # c.current_rshunt_set(5)
    # time.sleep(0.5)
    # print("Current_rshunt:",c.current_rshunt_get(), "ohm")

    # c.factory_reset()

    time.sleep(1)
    c.close()
    time.sleep(1)
