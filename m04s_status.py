"""Three-byte status frames confirmed in the SDK parser and on this M04S."""
import asyncio

# Request opcode and corresponding FF01 response opcode are different.
QUERIES = {"battery": (0x08, 0x04), "cover": (0x12, 0x05),
           "paper": (0x11, 0x06), "temperature": (0x13, 0x03),
           "auto_off": (0x0e, 0x09), "paper_mode": (0x19, 0x0c)}
# Separate to retain the existing default query sequence.
IDENTITY_QUERIES = {"serial_number": (0x09, 0x08)}


def decode(frame):
    if frame[1] == 0x08:
        # QYESCParser 0x100d6a3a0 reads 15 UTF-8 bytes after 1a 08.
        serial = frame[2:17].decode("ascii").rstrip("\x00 ")
        if not serial or not serial.isalnum():
            raise ValueError("序列号回应无效")
        return {"raw": frame.hex(" "), "serial_number": serial}
    code, value = frame[1:]
    result = {"raw": frame.hex(" ")}
    if code == 0x04:
        result["percent"] = value if value <= 100 else None
    elif code == 0x05:
        result["open"] = {0x98: False, 0x99: True}.get(value)
    elif code == 0x06:
        result["present"] = {0x88: False, 0x89: True}.get(value)
    elif code == 0x03:
        result["state"] = {0xa8: "normal", 0xa9: "overheated"}.get(value, "unknown")
    elif code == 0x09:
        # M04S offTimeType=1: SDK offTimeWithValue multiplies by five.
        result["minutes"] = value * 5
    elif code == 0x0c:
        result["mode"] = {0x0b: "continuous", 0x26: "black-mark", 0x0a: "gap"}.get(value, "unknown")
    return result


class StatusReplies:
    def __init__(self, log):
        self.log = log
        self.buffer = bytearray()
        self.pending = {}
        self.latest = {}
        self.names = {response: name for name, (_, response) in (QUERIES | IDENTITY_QUERIES).items()}

    def begin(self, response_code):
        if response_code in self.pending:
            raise RuntimeError("同类状态查询已在进行")
        future = asyncio.get_running_loop().create_future()
        self.pending[response_code] = future
        return future

    def notify(self, data):
        self.buffer.extend(data)
        while self.buffer:
            position = self.buffer.find(b"\x1a")
            if position < 0:
                self.buffer.clear()
                return
            del self.buffer[:position]
            if len(self.buffer) < 2:
                return
            code = self.buffer[1]
            if code not in self.names and code != 0x0f:
                del self.buffer[0]
                continue
            size = 17 if code == 0x08 else 3
            if len(self.buffer) < size:
                return
            frame = bytes(self.buffer[:size])
            del self.buffer[:size]
            if code == 0x0f:
                continue
            try:
                value = decode(frame)
            except ValueError as exc:
                self.log("status_reply_invalid", name=self.names[code], raw=frame.hex(" "))
                future = self.pending.get(code)
                if future is not None and not future.done():
                    future.set_exception(ValueError(str(exc)))
                continue
            self.latest[self.names[code]] = value
            self.log("status_reply", name=self.names[code], **value)
            future = self.pending.get(code)
            if future is not None and not future.done():
                future.set_result(value)

    def fail(self, reason):
        for future in self.pending.values():
            if not future.done():
                future.set_exception(ConnectionError(reason))
