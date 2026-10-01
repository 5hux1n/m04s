"""Add CoreBluetooth write readiness to the installed Bleak backend.

The adapter is per connection; it does not modify installed Bleak files.
"""
from __future__ import annotations

import asyncio
import weakref


class HostGate:
    def __init__(self, can_send, is_connected, log, timeout: float = 20.0):
        self.can_send = can_send
        self.is_connected = is_connected
        self.log = log
        self.timeout = timeout
        self.event = asyncio.Event()
        self.checks = 0
        self.waits = 0
        self.callbacks = 0
        self.closed = False

    def ready(self):
        if not self.closed:
            self.callbacks += 1
            self.event.set()

    async def wait(self):
        deadline = asyncio.get_running_loop().time() + self.timeout
        while True:
            if not self.is_connected():
                raise ConnectionError("蓝牙连接已断开")
            self.checks += 1
            if self.can_send():
                return
            self.event.clear()
            # A READY callback can race with the previous property check.
            self.checks += 1
            if self.can_send():
                continue
            self.waits += 1
            self.log("host_wait", waits=self.waits)
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("等待 macOS 发送缓存恢复超时")
            try:
                await asyncio.wait_for(self.event.wait(), remaining)
            except asyncio.TimeoutError as exc:
                raise TimeoutError("等待 macOS 发送缓存恢复超时") from exc


def attach(client, log):
    from bleak.backends._utils import external_thread_callback
    from bleak.backends.corebluetooth.PeripheralDelegate import ObjcPeripheralDelegate

    # Defining once avoids registering the same Objective-C class twice.
    global M04ObjcPeripheralDelegate
    if "M04ObjcPeripheralDelegate" not in globals():
        class M04ObjcPeripheralDelegate(ObjcPeripheralDelegate):
            @external_thread_callback
            def peripheralIsReadyToSendWriteWithoutResponse_(self, peripheral):
                delegate = self.py_delegate()
                if delegate is None:
                    return
                gate = getattr(delegate, "_m04_host_gate", None)
                if gate is not None and not delegate.event_loop.is_closed():
                    delegate.event_loop.call_soon_threadsafe(gate.ready)

    backend = client._backend
    delegate = getattr(backend, "_delegate", None)
    peripheral = getattr(backend, "_peripheral", None)
    if delegate is None or peripheral is None or not hasattr(delegate, "objc_delegate"):
        raise RuntimeError("当前 Bleak 后端不兼容 macOS 发送背压适配器")
    gate = HostGate(peripheral.canSendWriteWithoutResponse, lambda: client.is_connected, log)
    original = delegate.objc_delegate
    bridge = M04ObjcPeripheralDelegate.alloc().initWithPyDelegate_(weakref.ref(delegate))
    if bridge is None:
        raise RuntimeError("无法建立 macOS READY 回调")
    delegate._m04_host_gate = gate
    delegate.objc_delegate = bridge
    peripheral.setDelegate_(bridge)
    log("host_gate_attached")

    def detach():
        gate.closed = True
        gate.event.set()
        peripheral.setDelegate_(original)
        delegate.objc_delegate = original
        if getattr(delegate, "_m04_host_gate", None) is gate:
            del delegate._m04_host_gate

    return gate, detach
