"""Control bytes recovered from QYESCInstruction in the supplied SDK 4.46.0."""
from dataclasses import dataclass

DENSITIES = {"light": (1, 100), "medium": (2, 100), "dark": (4, 100), "special": (4, 150)}
PAPER_COMMANDS = {"continuous": bytes.fromhex("1f 11 0b"),
                  "black-mark": bytes.fromhex("1f 11 26"),
                  "gap": bytes.fromhex("1f 11 0a")}


def byte_value(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 255:
        raise ValueError(f"{name} 必须为 1–255 的整数协议值")
    return value


@dataclass(frozen=True)
class PrintSettings:
    density: str = "medium"
    coefficient: int | None = None
    speed: int | None = None
    paper: str | None = None

    def __post_init__(self):
        if self.density not in DENSITIES:
            raise ValueError("浓度选择 light / medium / dark / special")
        if self.coefficient is not None:
            byte_value(self.coefficient, "浓度系数")
        if self.speed is not None:
            byte_value(self.speed, "速度")
        if self.paper is not None and self.paper not in PAPER_COMMANDS:
            raise ValueError("不支持的纸张模式")

    @property
    def effective_coefficient(self):
        return self.coefficient if self.coefficient is not None else DENSITIES[self.density][1]

    def commands(self):
        commands = [("density", bytes((0x1f, 0x11, 0x02, DENSITIES[self.density][0])))]
        if self.paper is not None:
            commands.append(("paper", PAPER_COMMANDS[self.paper]))
        commands.append(("coefficient", bytes((0x1f, 0x11, 0x37, self.effective_coefficient))))
        if self.speed is not None:
            # Generic SDK command; M04S support and physical units are unconfirmed.
            commands.append(("speed", bytes((0x1f, 0x11, 0x23, self.speed))))
        return commands

    def describe(self):
        return {"density": self.density, "density_code": DENSITIES[self.density][0],
                "coefficient": self.effective_coefficient, "speed_code": self.speed,
                "speed_support": "unverified" if self.speed is not None else "not_requested",
                "paper": self.paper}


def auto_off_command(minutes):
    if isinstance(minutes, bool) or not isinstance(minutes, int) or not 0 <= minutes <= 1275 or minutes % 5:
        raise ValueError("M04S 自动关机时间必须为 0–1275 分钟，且为 5 的倍数；0 表示不自动关机")
    return bytes((0x1b, 0x4e, 0x07, minutes // 5))
