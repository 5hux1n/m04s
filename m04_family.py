"""M04 strategy adapters recovered from the user's decrypted SDK 4.46.0.

Physical verification covers the original M04S MiniLZO path only. The other
branches are implemented from static evidence and await device verification.
"""
from __future__ import annotations

import math
import re
import struct
from dataclasses import dataclass, replace
from pathlib import Path

from PIL import Image, ImageOps

from m04s_codec import MiniLZO, PrintTask
from m04s_driver import M04Printer
from m04s_settings import PrintSettings

RASTER_HEADER = bytes.fromhex("1d 76 30 00")
CONTINUOUS_TAIL = bytes.fromhex("1b 64 02 1b 64 02")
PAPER_CONTENT_MM = {15: 15, 25: 25, 53: 48, 80: 72, 110: 106}


@dataclass(frozen=True)
class DeviceProfile:
    model: str
    dpi: int
    max_content_dots: int
    serial_prefixes: tuple[str, ...]
    papers: tuple[int, ...]
    special_coefficient: int = 150

    @property
    def aligned_max(self):
        return self.max_content_dots // 8 * 8

    @property
    def wire_max(self):
        # SDK 0x100d74e90 pads Q016/Q171 to 1260 image pixels. Both the
        # header and OpenCV raster loop floor width/8, transmitting 1256 dots.
        return 1256 if self.model == "M04S" else self.aligned_max

    def encoding(self, serial_number):
        if self.model != "M04S":
            return "raw"
        if not serial_number:
            raise ValueError("M04S 自动选择格式需要序列号；离线时传 --serial-number 或明确指定 --encoding")
        return "raw" if serial_number.startswith(("Q171", "Q466")) else "minilzo"

    def content_width(self, paper_mm):
        if paper_mm not in self.papers:
            raise ValueError(f"{self.model} 不支持此纸宽，选择 {self.papers}")
        return min(self.aligned_max, max(8, round(PAPER_CONTENT_MM[paper_mm] * self.dpi / 25.4 / 8) * 8))

    def padding(self, serial_number, paper_mm, width):
        if self.model != "M04S" or not serial_number or not serial_number.startswith(("Q016", "Q171")):
            return 0, 0
        if paper_mm == 53:
            return 6, 18
        if paper_mm == 80:
            return 0, 32
        return 0, max(0, 1256 - width)

    def settings(self, settings=None):
        settings = settings or PrintSettings()
        if settings.paper not in (None, "continuous"):
            raise ValueError("新型号适配目前提供连续走纸；标签定位和黑标定位尚未移植")
        if settings.coefficient is None and settings.density == "special":
            settings = replace(settings, coefficient=self.special_coefficient)
        return FamilySettings(settings.density, settings.coefficient, settings.speed, settings.paper)

    def describe(self):
        return {"model": self.model, "strategy": "QYM04Strategy", "dpi": self.dpi,
                "sdk_max_content_dots": self.max_content_dots, "aligned_max_content_dots": self.aligned_max,
                "serial_prefixes": self.serial_prefixes, "special_coefficient": self.special_coefficient,
                "papers": {str(p): self.content_width(p) for p in self.papers},
                "verification": "original_m04s_minilzo_only" if self.model == "M04S" else "offline_only"}


PROFILES = {
    "M04S": DeviceProfile("M04S", 300, 1248, ("Q016", "Q171", "Q466"), (53, 80, 110)),
    "M04AS": DeviceProfile("M04AS", 300, 1228, ("Q089", "Q164", "Q165", "Q209", "Q230", "Q500"), (15, 25, 53, 80, 110), 100),
    "M04AH": DeviceProfile("M04AH", 203, 863, ("Q132", "Q395"), (53, 80, 110)),
    "Y04S": DeviceProfile("Y04S", 300, 1248, ("Q170", "Q188", "Q208", "Q229"), (15, 25, 53, 80, 110)),
}


def get_profile(model):
    try:
        return PROFILES[model.upper()]
    except (KeyError, AttributeError):
        raise ValueError(f"未适配的型号：{model}；当前选择 {', '.join(PROFILES)}") from None


def validate_serial(serial):
    if serial is not None and not re.fullmatch(r"[A-Z0-9]{4,15}", serial):
        raise ValueError("序列号使用 4–15 位大写字母和数字；离线可只提供 Q016 等批次前缀")
    return serial


class FamilySettings(PrintSettings):
    def commands(self):
        # QYM04Strategy handleImages 0x100d74a0c / 0x100d74a50.
        return [("initialize", bytes.fromhex("1b 40")),
                ("m04_mode", bytes.fromhex("1f 11 35 01")), *super().commands()]


@dataclass(frozen=True)
class FamilyTask(PrintTask):
    model: str = "M04S"
    serial_number: str | None = None
    encoding: str = "minilzo"
    content_width: int = 592
    paper_mm: int | None = None
    padding_left: int = 0
    padding_right: int = 0

    def describe(self):
        return {"model": self.model, "serial_number": self.serial_number, "encoding": self.encoding,
                "width_dots": self.width, "content_width_dots": self.content_width, "height_dots": self.height,
                "paper_mm": self.paper_mm, "padding_dots": [self.padding_left, self.padding_right],
                "bytes": len(self.data), "source": self.source, "verification": "offline_task_generated"}


class M04Codec:
    def __init__(self, profile, serial_number=None, encoding="auto"):
        self.profile = get_profile(profile) if isinstance(profile, str) else profile
        self.serial_number = validate_serial(serial_number)
        if encoding not in ("auto", "raw", "minilzo"):
            raise ValueError("编码选择 auto / raw / minilzo")
        self.encoding = self.profile.encoding(serial_number) if encoding == "auto" else encoding
        if self.profile.model != "M04S" and self.encoding != "raw":
            raise ValueError(f"{self.profile.model} 的官方 M04 策略使用 raw，不能选择 MiniLZO")
        self._lzo = None

    @property
    def lzo(self):
        if self._lzo is None:
            self._lzo = MiniLZO(max_width=self.profile.wire_max)
        return self._lzo

    def _dimensions(self, width, height):
        if isinstance(width, bool) or not isinstance(width, int) or width % 8 or not 8 <= width <= self.profile.wire_max:
            raise ValueError(f"{self.profile.model} 传输宽度必须是 8 的倍数且 ≤{self.profile.wire_max} 点")
        if isinstance(height, bool) or not isinstance(height, int) or not 1 <= height <= 65535:
            raise ValueError("点阵高度必须为 1–65535 点")
        if width > self.profile.aligned_max and not (self.profile.model == "M04S" and
                self.serial_number and self.serial_number.startswith(("Q016", "Q171"))):
            raise ValueError("只有 M04S Q016/Q171 的官方右侧补白可超过内容宽度上限")

    def build(self, raw, height, source="raw", width=592):
        self._dimensions(width, height)
        if len(raw) != width // 8 * height:
            raise ValueError("点阵数据长度与行宽、高度不一致")
        self._check_extended_margin(raw, width)
        if self.encoding == "minilzo":
            data = self.lzo.build(raw, height, source, width).data
        else:
            data = RASTER_HEADER + struct.pack("<HH", width // 8, height) + raw + CONTINUOUS_TAIL
        return FamilyTask(data, height, raw, source, width, self.profile.model,
                          self.serial_number, self.encoding, width)

    def _check_extended_margin(self, raw, width):
        if width > self.profile.aligned_max:
            row_bytes = width // 8
            extra_bytes = (width - self.profile.aligned_max) // 8
            if any(any(raw[pos + row_bytes - extra_bytes:pos + row_bytes])
                   for pos in range(0, len(raw), row_bytes)):
                raise ValueError("超出内容宽度的右侧必须为全白补边")

    def parse(self, data, source="task"):
        if len(data) < 14 or data[:4] != RASTER_HEADER:
            raise ValueError("不是 M04 光栅任务")
        width_bytes, height = struct.unpack_from("<HH", data, 4)
        width = width_bytes * 8
        self._dimensions(width, height)
        if self.encoding == "minilzo":
            task = self.lzo.parse(data, source)
            raw = task.raw
        else:
            if not data.endswith(CONTINUOUS_TAIL) or len(data) != 8 + width_bytes * height + len(CONTINUOUS_TAIL):
                raise ValueError("raw 点阵长度或走纸尾部错误；不能把 LZO 任务发送到 raw 分支")
            raw = data[8:-len(CONTINUOUS_TAIL)]
        self._check_extended_margin(raw, width)
        return FamilyTask(data, height, raw, source, width, self.profile.model,
                          self.serial_number, self.encoding, width)

    def image(self, path: Path, threshold=180, *, paper_mm=53, width_dots=None):
        if not isinstance(threshold, int) or not 0 <= threshold <= 255:
            raise ValueError("阈值必须为 0–255")
        # Explicit dot width represents a prepared wire raster (legacy replay),
        # so never add SDK margins twice. Paper mode uses a content-sized image.
        width = self.profile.content_width(paper_mm) if width_dots is None else width_dots
        if isinstance(width, bool) or not isinstance(width, int) or width % 8 or not 8 <= width <= self.profile.aligned_max:
            raise ValueError(f"内容宽度必须是 8 的倍数且 ≤{self.profile.aligned_max} 点")
        left, right = self.profile.padding(self.serial_number, paper_mm, width) if width_dots is None else (0, 0)
        with Image.open(path) as opened:
            rgba = ImageOps.exif_transpose(opened).convert("RGBA")
            white = Image.new("RGBA", rgba.size, "white")
            white.alpha_composite(rgba)
            height = max(1, round(rgba.height * width / rgba.width))
            self._dimensions(width + left + right, height)
            gray = white.convert("RGB").resize((width, height), Image.Resampling.LANCZOS).convert("L")
            content = gray.point(lambda p: 0 if p < threshold else 255, mode="1")
            bitmap = Image.new("1", (width + left + right, height), 1)
            bitmap.paste(content, (left, 0))
            raw = bytes(b ^ 255 for b in bitmap.tobytes())
        task = self.build(raw, height, str(path.resolve()), bitmap.width)
        return replace(task, content_width=width, paper_mm=paper_mm if width_dots is None else None,
                       padding_left=left, padding_right=right)

    def blank_feed(self, mm, paper_mm=53):
        if not math.isfinite(mm) or mm <= 0:
            raise ValueError("走纸长度必须是正数")
        width = self.profile.content_width(paper_mm)
        height = round(mm * self.profile.dpi / 25.4)
        self._dimensions(width, height)
        return self.build(bytes(width // 8 * height), height, f"blank_feed:{mm:g}mm", width)


class M04FamilyPrinter(M04Printer):
    def __init__(self, profile, log, completion_timeout=120.0, *, serial_number=None, device_address=None):
        self.profile = get_profile(profile) if isinstance(profile, str) else profile
        self.serial_number = validate_serial(serial_number)
        super().__init__(log, completion_timeout, model=self.profile.model, device_address=device_address)

    async def __aenter__(self):
        await super().__aenter__()
        try:
            identity = (await self.get_status(("serial_number",)))["serial_number"]
            reported = identity.get("serial_number")
            if reported:
                if self.serial_number and not reported.startswith(self.serial_number):
                    raise ValueError("设备序列号与指定的序列号／批次不匹配")
                self.serial_number = reported
            elif self.profile.model == "M04S" and not self.serial_number:
                raise RuntimeError("没有读到 M04S 序列号，无法自动选择协议；可核对机身标签后指定 --serial-number")
            self.log("device_identity", model=self.profile.model, serial_number=self.serial_number,
                     identity_source="device" if reported else "manual" if self.serial_number else "unavailable",
                     encoding=self.profile.encoding(self.serial_number))
            return self
        except BaseException:
            await self.close()
            raise

    async def print_task(self, task, job_id, hold_seconds=None, settings=None):
        if not isinstance(task, FamilyTask) or task.model != self.profile.model:
            raise ValueError("任务未按当前设备型号编码")
        codec = M04Codec(self.profile, self.serial_number)
        if task.encoding != codec.encoding:
            raise ValueError("任务编码与当前设备序列号对应的格式不匹配")
        codec.parse(task.data)  # Validate lengths and framing before any settings write.
        if task.serial_number and self.serial_number and task.serial_number[:4] != self.serial_number[:4]:
            raise ValueError("任务所属批次与当前设备不同，请重新生成")
        return await super().print_task(task, job_id, hold_seconds, self.profile.settings(settings))
