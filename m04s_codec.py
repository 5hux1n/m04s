"""The verified M04S bitmap and MiniLZO wire format."""
from __future__ import annotations

import ctypes
import ctypes.util
import math
import struct
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

WIDTH_DOTS = 592
WIDTH_BYTES = WIDTH_DOTS // 8
MAX_WIDTH_DOTS = 1248  # M04S maxPrintWidthInDot in the supplied official SDK configuration.
BLOCK_BYTES = 4096
PRE_PRINT = bytes.fromhex("1f 11 37 64")
TASK_TAIL = bytes.fromhex("00 00 00 1b 64 02 1b 64 02")


@dataclass(frozen=True)
class PrintTask:
    data: bytes
    height: int
    raw: bytes
    source: str
    width: int = WIDTH_DOTS

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "printtask.bin").write_bytes(self.data)
        preview = Image.frombytes("1", (self.width, self.height), bytes(b ^ 255 for b in self.raw))
        preview.save(directory / "preview.png")


class MiniLZO:
    def __init__(self, *, max_width=MAX_WIDTH_DOTS):
        self.max_width = max_width
        paths = [ctypes.util.find_library("lzo2"), "/opt/homebrew/lib/liblzo2.dylib", "/usr/local/lib/liblzo2.dylib"]
        for path in filter(None, paths):
            try:
                self.lib = ctypes.CDLL(path)
                break
            except OSError:
                continue
        else:
            raise RuntimeError("找不到 liblzo2，请安装 lzo")
        signature = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p]
        self.lib.lzo1x_1_compress.argtypes = signature
        self.lib.lzo1x_1_compress.restype = ctypes.c_int
        self.lib.lzo1x_decompress_safe.argtypes = signature
        self.lib.lzo1x_decompress_safe.restype = ctypes.c_int

    def compress(self, data: bytes) -> bytes:
        capacity = len(data) + len(data) // 16 + 67
        output = ctypes.create_string_buffer(capacity)
        length = ctypes.c_size_t(capacity)
        workspace = ctypes.create_string_buffer(256 * 1024)
        result = self.lib.lzo1x_1_compress(data, len(data), output, ctypes.byref(length), workspace)
        if result:
            raise ValueError(f"LZO 压缩失败: {result}")
        return output.raw[:length.value]

    def decompress(self, data: bytes) -> bytes:
        output = ctypes.create_string_buffer(BLOCK_BYTES)
        length = ctypes.c_size_t(BLOCK_BYTES)
        result = self.lib.lzo1x_decompress_safe(data, len(data), output, ctypes.byref(length), None)
        if result:
            raise ValueError(f"LZO 块无效: {result}")
        return output.raw[:length.value]

    def build(self, raw: bytes, height: int, source: str = "raw", width: int = WIDTH_DOTS) -> PrintTask:
        if not isinstance(width, int) or not 8 <= width <= self.max_width or width % 8:
            raise ValueError(f"点阵宽度必须为 8 的倍数，且不超过 {self.max_width} 点")
        width_bytes = width // 8
        if not 1 <= height <= 65535 or len(raw) != width_bytes * height:
            raise ValueError("点阵尺寸不合法")
        encoded = bytearray()
        for position in range(0, len(raw), BLOCK_BYTES):
            block = self.compress(raw[position:position + BLOCK_BYTES])
            encoded.extend(struct.pack("<H", len(block)) + b"\0" + block)
        data = b"\x1d\x76\x30\x00" + struct.pack("<HH", width_bytes, height) + encoded + TASK_TAIL
        task = self.parse(data, source)
        if task.raw != raw:
            raise ValueError("点阵压缩回读不一致")
        return task

    def parse(self, data: bytes, source: str = "task") -> PrintTask:
        if len(data) < 17 or data[:4] != b"\x1d\x76\x30\x00" or data[-9:] != TASK_TAIL:
            raise ValueError("不是已验证的 M04S 打印任务格式")
        width, height = struct.unpack_from("<HH", data, 4)
        if not 1 <= width <= self.max_width // 8 or not height:
            raise ValueError("任务尺寸不合法")
        end = len(data) - len(TASK_TAIL)
        offset = 8
        raw = bytearray()
        while offset < end:
            if offset + 3 > end:
                raise ValueError("LZO 块头截断")
            length = struct.unpack_from("<H", data, offset)[0]
            if not length or data[offset + 2] != 0 or offset + 3 + length > end:
                raise ValueError("LZO 块长度或标记无效")
            block = self.decompress(data[offset + 3:offset + 3 + length])
            expected = min(BLOCK_BYTES, width * height - len(raw))
            if len(block) != expected or expected <= 0:
                raise ValueError("LZO 块解压长度与点阵不符")
            raw.extend(block)
            offset += 3 + length
        if len(raw) != width * height:
            raise ValueError("任务点阵不完整")
        return PrintTask(data, height, bytes(raw), source, width * 8)

    def image(self, path: Path, threshold: int = 180, width: int = WIDTH_DOTS) -> PrintTask:
        if not isinstance(width, int) or not 8 <= width <= self.max_width or width % 8:
            raise ValueError("不支持的打印宽度")
        with Image.open(path) as opened:
            rgba = ImageOps.exif_transpose(opened).convert("RGBA")
            white = Image.new("RGBA", rgba.size, "white")
            white.alpha_composite(rgba)
            height = max(1, round(rgba.height * width / rgba.width))
            if height > 65535:
                raise ValueError("图片缩放后的高度超过 65535 点")
            gray = white.convert("RGB").resize((width, height), Image.Resampling.LANCZOS).convert("L")
            bitmap = gray.point(lambda p: 0 if p < threshold else 255, mode="1")
            raw = bytes(b ^ 255 for b in bitmap.tobytes())
        return self.build(raw, height, str(path), width)

    def blank_feed(self, millimeters: float) -> PrintTask:
        if not math.isfinite(millimeters) or millimeters <= 0:
            raise ValueError("走纸长度必须为正数")
        height = round(millimeters * 300 / 25.4)
        if not 1 <= height <= 65535:
            raise ValueError("走纸长度超出点阵范围")
        # Uses the verified raster completion path; task tail adds its normal feed.
        return self.build(bytes(WIDTH_BYTES * height), height, f"blank_feed:{millimeters:g}mm_raster")
