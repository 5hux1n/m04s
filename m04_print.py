"""Workspace-only entry point for the four implemented M04 family adapters."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from datetime import datetime
from pathlib import Path

from m04_family import PROFILES, M04Codec, M04FamilyPrinter, get_profile, validate_serial
from m04s_settings import DENSITIES, PrintSettings

ROOT = Path(__file__).resolve().parent


def main(argv=None):
    parser = argparse.ArgumentParser(description="M04 家族：按型号、DPI、序列号选择任务格式")
    parser.add_argument("images", nargs="*", type=Path)
    parser.add_argument("--model", type=str.upper, choices=PROFILES, default="M04S")
    parser.add_argument("--serial-number", help="机身序列号；离线可只提供批次前缀，如 Q016")
    parser.add_argument("--device-address", help="多台同型号设备时指定蓝牙地址／macOS UUID")
    parser.add_argument("--list-models", action="store_true")
    parser.add_argument("--paper-width", type=int, choices=(15, 25, 53, 80, 110), default=53)
    parser.add_argument("--width-dots", type=int, help="已准备好的点阵宽度，不再增加官方补白")
    parser.add_argument("--encoding", choices=("auto", "raw", "minilzo"), default="auto",
                        help="离线可覆盖编码；实机发送仍须符合设备型号和序列号")
    parser.add_argument("--task", type=Path, help="复放符合所选设备格式的任务；不自动转换 bin")
    parser.add_argument("--feed-mm", type=float)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--threshold", type=int, default=180)
    parser.add_argument("--density", choices=DENSITIES, default="medium")
    parser.add_argument("--density-coefficient", type=int)
    parser.add_argument("--speed", type=int, help="实验性协议值；尚未证实 M04 家族可调速")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--completion-timeout", type=float, default=120)
    parser.add_argument("--dry-run", action="store_true", help="生成 bin、预览与日志；不扫描蓝牙")
    args = parser.parse_args(argv)
    if args.list_models:
        print(json.dumps([p.describe() for p in PROFILES.values()], ensure_ascii=False, indent=2))
        return
    printing = bool(args.images or args.task or args.feed_mm is not None)
    if not printing and not args.status:
        parser.error("提供图片、--task、--feed-mm、--status 或 --list-models")
    if sum((bool(args.images), args.task is not None, args.feed_mm is not None)) > 1:
        parser.error("图片、--task、--feed-mm 只能选一种")
    if args.width_dots is not None and not args.images:
        parser.error("--width-dots 只用于图片")
    if args.repeat < 1 or not 0 <= args.threshold <= 255 or not math.isfinite(args.completion_timeout) or args.completion_timeout <= 0:
        parser.error("重复次数、阈值或完成超时无效")
    profile = get_profile(args.model)
    try:
        validate_serial(args.serial_number)
        profile.content_width(args.paper_width)
        if args.width_dots is not None and (args.width_dots % 8 or not 8 <= args.width_dots <= profile.aligned_max):
            raise ValueError(f"点阵宽度必须为 8 的倍数，且不超过 {profile.aligned_max} 点")
        for path in [*args.images, *([args.task] if args.task else [])]:
            if not path.is_file():
                raise ValueError(f"找不到输入文件：{path}")
        settings = profile.settings(PrintSettings(args.density, args.density_coefficient, args.speed, "continuous"))
        if args.dry_run and printing:
            M04Codec(profile, args.serial_number, args.encoding)
        if args.feed_mm is not None and (not math.isfinite(args.feed_mm) or args.feed_mm <= 0):
            raise ValueError("走纸长度必须为正数")
        if args.feed_mm is not None and not 1 <= round(args.feed_mm * profile.dpi / 25.4) <= 65535:
            raise ValueError("空白走纸点阵高度超出 1–65535 点")
    except ValueError as exc:
        parser.error(str(exc))

    run_id = "m04_" + datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    logs = ROOT / "logs"
    logs.mkdir(exist_ok=True)
    summary_path = logs / f"{run_id}_summary.json"
    summary = {"run_id": run_id, "status": "started", "profile": profile.describe(), "jobs": [],
               "settings": settings.describe(), "hardware_verification": "not_performed_in_this_adaptation"}
    started = time.monotonic()
    with (logs / f"{run_id}.jsonl").open("w", encoding="utf-8") as stream:
        def log(event, **values):
            record = {"seconds": round(time.monotonic() - started, 6), "event": event, **values}
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
            if event not in ("tx", "ff03", "credit_return"):
                print(f"{event}: {json.dumps(values, ensure_ascii=False)}", flush=True)

        def prepare(serial):
            if not printing:
                return []
            codec = M04Codec(profile, serial, args.encoding)
            source_tasks = ([codec.parse(args.task.resolve().read_bytes(), str(args.task.resolve()))] if args.task else
                            [codec.blank_feed(args.feed_mm, args.paper_width)] if args.feed_mm is not None else
                            [codec.image(path.resolve(), args.threshold, paper_mm=args.paper_width,
                                         width_dots=args.width_dots) for path in args.images])
            tasks = []
            for _ in range(args.repeat):
                for task in source_tasks:
                    job_id = f"{run_id}_{len(tasks) + 1:03d}"
                    directory = ROOT / "artifacts" / job_id
                    task.save(directory)
                    metadata = {"task": task.describe(), "profile": profile.describe(),
                                "settings": settings.describe(),
                                "commands": {name: data.hex(" ") for name, data in settings.commands()}}
                    (directory / "adapter.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    log("prepared", job_id=job_id, directory=str(directory), **task.describe())
                    tasks.append((job_id, task))
            summary["tasks"] = [{"job_id": job, **task.describe()} for job, task in tasks]
            return tasks

        async def run():
            async with M04FamilyPrinter(profile, log, args.completion_timeout,
                                        serial_number=args.serial_number, device_address=args.device_address) as printer:
                summary["serial_number"] = printer.serial_number
                tasks = prepare(printer.serial_number)
                if args.status:
                    summary["printer_status"] = await printer.get_status()
                for job_id, task in tasks:
                    result = await printer.print_task(task, job_id, settings=settings)
                    summary["jobs"].append(result.__dict__)
                summary["statistics"] = printer.statistics()

        try:
            if args.dry_run:
                prepare(args.serial_number)
                summary["status"] = "dry_run"
            else:
                asyncio.run(run())
                summary["status"] = "complete"
        except BaseException as exc:
            summary["status"] = "failed"
            summary["error"] = f"{type(exc).__name__}: {exc}"
            log("error", detail=summary["error"])
            raise
        finally:
            summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"记录：{summary_path}", flush=True)


if __name__ == "__main__":
    main()
