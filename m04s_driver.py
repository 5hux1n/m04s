"""M04S credit flow control and completion driven print jobs."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner

from m04s_codec import PrintTask
from m04s_corebluetooth import attach
from m04s_settings import PrintSettings, auto_off_command, PAPER_COMMANDS
from m04s_status import QUERIES, IDENTITY_QUERIES, StatusReplies

FF01 = "0000ff01-0000-1000-8000-00805f9b34fb"
FF02 = "0000ff02-0000-1000-8000-00805f9b34fb"
FF03 = "0000ff03-0000-1000-8000-00805f9b34fb"
MAX_PACKET = 182
FINISHED = bytes.fromhex("1a 0f 0c")


class CreditWindow:
    def __init__(self, log, timeout=20.0):
        self.log = log
        self.timeout = timeout
        self.capacity = 0
        self.available = 0
        self.packet_size = MAX_PACKET
        self.peer_size = None
        self.changed = asyncio.Event()
        self.configured = asyncio.Event()
        self.fault = None
        self.writes = 0
        self.returned = 0
        self.overflow = 0
        self.peak_outstanding = 0

    def notify(self, data: bytes):
        if len(data) == 2 and data[0] == 1 and data[1] > 0:
            count = data[1]
            if not self.capacity:
                self.capacity = count
                self.available = count
                self.log("credit_initial", capacity=count)
            else:
                before = self.available
                self.returned += count
                self.overflow += max(0, before + count - self.capacity)
                self.available = min(self.capacity, before + count)
                self.log("credit_return", count=count, before=before, after=self.available)
            self.changed.set()
        elif len(data) in (2, 3) and data[0] == 2 and data[1] > 0:
            # QBLEManager uses the second byte, capped at 182 (SDK 4.46.0).
            self.peer_size = data[1]
            self.packet_size = min(MAX_PACKET, self.peer_size)
            self.log("peer_packet_size", offered=self.peer_size, selected=self.packet_size)
        else:
            self.log("ff03_unclassified", data=data.hex(" "))
        if self.capacity and self.peer_size is not None:
            self.configured.set()

    def fail(self, reason):
        self.fault = reason
        self.changed.set()
        self.configured.set()

    def check(self):
        if self.fault:
            raise ConnectionError(self.fault)

    async def initialize(self):
        await asyncio.wait_for(self.configured.wait(), self.timeout)
        self.check()

    async def wait_until(self, predicate):
        deadline = asyncio.get_running_loop().time() + self.timeout
        while True:
            self.check()
            if predicate():
                return
            self.changed.clear()
            # Both the predicate and callbacks execute on the asyncio loop.
            if predicate():
                continue
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("等待打印机 FF03 额度超时")
            try:
                await asyncio.wait_for(self.changed.wait(), remaining)
            except asyncio.TimeoutError as exc:
                raise TimeoutError("等待打印机 FF03 额度超时") from exc

    def reserve(self):
        self.check()
        if self.available <= 0:
            raise RuntimeError("没有可用发送额度")
        self.available -= 1
        self.peak_outstanding = max(self.peak_outstanding, self.capacity - self.available)


class Completion:
    def __init__(self, log):
        self.log = log
        self.event = asyncio.Event()
        self.active = False
        self.buffer = bytearray()
        self.expected_bytes = 0
        self.sent_bytes = 0
        self.failure = None
        self.received_at = None

    def arm(self, task_bytes):
        self.buffer.clear()
        self.event.clear()
        self.active = True
        self.expected_bytes = task_bytes
        self.sent_bytes = 0
        self.failure = None
        self.received_at = None

    def notify(self, data):
        # Only the SDK-confirmed 1A 0F three-byte active status is classified.
        self.buffer.extend(data)
        while self.buffer:
            position = self.buffer.find(b"\x1a\x0f")
            if position < 0:
                self.buffer[:] = b"\x1a" if self.buffer[-1:] == b"\x1a" else b""
                return
            del self.buffer[:position]
            if len(self.buffer) < 3:
                return
            frame = bytes(self.buffer[:3])
            del self.buffer[:3]
            if frame != FINISHED or not self.active:
                self.log("status_unclassified_or_idle", data=frame.hex(" "))
                continue
            if self.sent_bytes < self.expected_bytes:
                self.failure = "图片数据尚未发完就收到完成通知；任务可能被截断"
                self.log("premature_finish", sent=self.sent_bytes, expected=self.expected_bytes)
            else:
                self.received_at = time.monotonic()
                self.log("print_finished", data=frame.hex(" "), sent=self.sent_bytes)
            self.event.set()

    def fail(self, reason):
        self.failure = reason
        self.event.set()

    async def wait(self, timeout):
        try:
            await asyncio.wait_for(self.event.wait(), timeout)
        except asyncio.TimeoutError as exc:
            raise TimeoutError("未收到打印完成通知；不能确认完整打印") from exc
        if self.failure:
            raise ConnectionError(self.failure)
        if self.received_at is None:
            raise RuntimeError("缺少有效打印完成通知")


@dataclass
class JobResult:
    job_id: str
    height: int
    bytes: int
    packets: int
    transmit_seconds: float
    finish_wait_seconds: float
    total_seconds: float
    completion: str
    settings: dict


class M04Printer:
    def __init__(self, log, completion_timeout=120.0, *, model="M04S", device_names=None, device_address=None):
        self.log = log
        self.model = model
        self.device_names = tuple(device_names or (model,))
        self.device_address = device_address
        self.completion_timeout = completion_timeout
        self.client = None
        self.gate = None
        self._detach = None
        self._closing = False
        self.credit = CreditWindow(log)
        self.completion = Completion(log)
        self.status = StatusReplies(log)
        self.write_lock = asyncio.Lock()
        self.job_lock = asyncio.Lock()

    async def __aenter__(self):
        try:
            for attempt in range(1, 4):
                self.log("scan", attempt=attempt, model=self.model)
                found = await BleakScanner.discover(timeout=5, return_adv=True)
                candidates = [(device, adv.local_name or device.name or "") for device, adv in found.values()]
                matches = [d for d, n in candidates if self.matches_device(d.address, n)]
                if len(matches) > 1:
                    raise RuntimeError(f"发现多台 {self.model}，请指定 --device-address")
                device = matches[0] if matches else None
                if device:
                    break
            else:
                raise RuntimeError(f"没有找到 {self.model}，请确认打印机已开机且手机已断开")
            self.client = BleakClient(device, disconnected_callback=self._disconnected)
            await self.client.connect()
            self.gate, self._detach = attach(self.client, self.log)
            characteristic = self.client.services.get_characteristic(FF02)
            if characteristic is None or "write-without-response" not in characteristic.properties:
                raise RuntimeError("FF02 不支持 Write Without Response")
            local_size = characteristic.max_write_without_response_size
            await self.client.start_notify(FF01, self._ff01)
            await self.client.start_notify(FF03, self._ff03)
            await self.credit.initialize()
            self.credit.packet_size = min(self.credit.packet_size, local_size)
            self.log("connected", device=device.address, model=self.model, credit=self.credit.capacity,
                     packet_size=self.credit.packet_size, local_size=local_size)
            return self
        except BaseException:
            await self.close()
            raise

    async def __aexit__(self, exc_type, exc, traceback):
        await self.close()

    def matches_device(self, address, name):
        # All four M04 SDK profiles use exact Bluetooth names.
        return (name.strip().casefold() in {n.casefold() for n in self.device_names}
                and (self.device_address is None or address.casefold() == self.device_address.casefold()))

    def _disconnected(self, client):
        if not self._closing:
            self.log("unexpected_disconnect")
            self.credit.fail("打印机意外断开")
            self.completion.fail("打印机意外断开")
            self.status.fail("打印机意外断开")
            if self.gate:
                self.gate.event.set()

    def _ff03(self, characteristic, data):
        self.log("ff03", data=bytes(data).hex(" "))
        self.credit.notify(bytes(data))

    def _ff01(self, characteristic, data):
        self.log("ff01", data=bytes(data).hex(" "))
        self.completion.notify(bytes(data))
        self.status.notify(bytes(data))

    async def get_status(self, names=None, timeout=3.0):
        names = tuple(QUERIES if names is None else names)
        queries = QUERIES | IDENTITY_QUERIES
        if any(name not in queries for name in names):
            raise ValueError("未知状态查询")
        # Queries cannot split the raster stream or race with another job.
        async with self.job_lock:
            result = {}
            for name in names:
                request, response = queries[name]
                future = self.status.begin(response)
                try:
                    await self.write(bytes((0x1f, 0x11, request)), "QUERY_" + name.upper(), 1, 1)
                    result[name] = await asyncio.wait_for(future, timeout)
                except asyncio.TimeoutError:
                    result[name] = {"available": False, "reason": "response_timeout"}
                finally:
                    self.status.pending.pop(response, None)
                    if not future.done():
                        future.cancel()
                    elif not future.cancelled():
                        future.exception()  # Retrieve a disconnect exception even if the write failed.
            await self.credit.wait_until(lambda: self.credit.available == self.credit.capacity)
            self.log("status_snapshot", values=result)
            return result

    async def set_auto_off(self, minutes):
        command = auto_off_command(minutes)
        async with self.job_lock:
            await self.write(command, "SETTING_AUTO_OFF", 1, 1)
            await self.credit.wait_until(lambda: self.credit.available == self.credit.capacity)
        result = (await self.get_status(("auto_off",)))["auto_off"]
        if result.get("minutes") != minutes:
            raise RuntimeError(f"自动关机设置回读不一致：{result}")
        self.log("auto_off_verified", minutes=minutes)
        return result

    async def set_paper_mode(self, mode):
        if mode not in PAPER_COMMANDS:
            raise ValueError("未知纸张模式")
        async with self.job_lock:
            await self.write(PAPER_COMMANDS[mode], "SETTING_PAPER", 1, 1)
            await self.credit.wait_until(lambda: self.credit.available == self.credit.capacity)
        result = (await self.get_status(("paper_mode",)))["paper_mode"]
        if result.get("mode") != mode:
            raise RuntimeError(f"纸张模式回读不一致：{result}")
        self.log("paper_mode_verified", mode=mode)
        return result

    async def close(self):
        self._closing = True
        if self.client and self.client.is_connected:
            for uuid in (FF03, FF01):
                try:
                    await asyncio.wait_for(self.client.stop_notify(uuid), 3)
                except Exception:
                    pass
        if self._detach:
            self._detach()
            self._detach = None
        if self.client and self.client.is_connected:
            await self.client.disconnect()
        self.log("disconnected")

    async def write(self, packet, label, index, total):
        async with self.write_lock:
            await self.credit.wait_until(lambda: self.credit.available > 0)
            await self.gate.wait()
            self.credit.check()
            if self.completion.failure:
                raise ConnectionError(self.completion.failure)
            before = self.credit.available
            self.credit.reserve()
            try:
                await self.client.write_gatt_char(FF02, packet, response=False)
            except BaseException:
                self.credit.available = min(self.credit.capacity, self.credit.available + 1)
                self.credit.changed.set()
                raise
            self.credit.writes += 1
            if label == "PRINT":
                self.completion.sent_bytes += len(packet)
            self.log("tx", label=label, index=index, total=total, bytes=len(packet),
                     before=before, after=self.credit.available)

    async def print_task(self, task: PrintTask, job_id: str, hold_seconds=None, settings=None):
        async with self.job_lock:
            settings = settings or PrintSettings()
            started = time.monotonic()
            returns_before = self.credit.returned
            self.log("job_start", job_id=job_id, source=task.source, height=task.height, bytes=len(task.data))
            commands = settings.commands()
            self.log("print_settings", **settings.describe(),
                     commands={name: data.hex(" ") for name, data in commands})
            # Each command uses the same credits and host gate as raster packets.
            for index, (name, command) in enumerate(commands, 1):
                await self.write(command, "SETTING_" + name.upper(), index, len(commands))
            # Retain the observed control-to-raster boundary, not packet pacing.
            await asyncio.sleep(0.015)
            self.completion.arm(len(task.data))
            chunks = [task.data[p:p + self.credit.packet_size] for p in range(0, len(task.data), self.credit.packet_size)]
            sending = time.monotonic()
            for index, packet in enumerate(chunks, 1):
                await self.write(packet, "PRINT", index, len(chunks))
            submitted = time.monotonic()
            await self.credit.wait_until(lambda: self.credit.available == self.credit.capacity)
            self.log("transport_drained", job_id=job_id, returned=self.credit.returned - returns_before)
            if hold_seconds is None:
                self.log("waiting_print_finished", timeout=self.completion_timeout)
                await self.completion.wait(self.completion_timeout)
                finish_wait = self.completion.received_at - submitted
                # QYPrinter schedules printSuccess one second after this trigger.
                await asyncio.sleep(1.0)
                self.credit.check()
                completion = "ff01_1a0f0c"
            else:
                self.log("manual_connection_hold", seconds=hold_seconds)
                await asyncio.sleep(hold_seconds)
                self.credit.check()
                finish_wait = time.monotonic() - submitted
                completion = "manual_hold_unverified"
            self.completion.active = False
            result = JobResult(job_id, task.height, len(task.data), len(chunks), submitted - sending,
                               max(0, finish_wait), time.monotonic() - started, completion, settings.describe())
            self.log("job_complete", **result.__dict__)
            return result

    def statistics(self):
        return {"writes": self.credit.writes, "credit_returned": self.credit.returned,
                "credit_capacity": self.credit.capacity, "credit_overflow": self.credit.overflow,
                "peak_outstanding": self.credit.peak_outstanding,
                "host_checks": self.gate.checks if self.gate else 0,
                "host_waits": self.gate.waits if self.gate else 0,
                "host_ready_callbacks": self.gate.callbacks if self.gate else 0}
