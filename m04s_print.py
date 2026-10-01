"""Workspace-only CLI for M04S image printing and verified task replay."""
from __future__ import annotations
import argparse
import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from m04s_codec import MiniLZO
from m04s_driver import M04Printer
from m04s_settings import PrintSettings, DENSITIES, PAPER_COMMANDS, auto_off_command
ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description="M04S 动态额度 + macOS 背压 + 完成通知")
    parser.add_argument("images", nargs="*", type=Path)
    parser.add_argument("--task", type=Path)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--threshold", type=int, default=180)
    parser.add_argument("--completion-timeout", type=float, default=120)
    parser.add_argument("--hold-seconds", type=float, help="仅用于对照：固定保持连接，结果标记为未确认")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--density", choices=DENSITIES, default="medium", help="淡/中/浓/专用")
    parser.add_argument("--density-coefficient", type=int, help="浓度系数协议值，100=1.0 倍")
    parser.add_argument("--speed", type=int, help="实验性速度协议值 1–255；M04S 是否支持待验证，非毫米/秒")
    parser.add_argument("--paper", choices=PAPER_COMMANDS, help="纸张传感器模式；M04S 当前只验证连续纸")
    parser.add_argument("--status", action="store_true", help="查询电量、盖子、纸张、温度状态、自动关机时间")
    parser.add_argument("--auto-off-minutes", type=int, help="设置设备自动关机时间，5 的倍数；0=关闭自动关机")
    parser.add_argument("--feed-mm", type=float, help="通过空白点阵走纸；毫米为点阵长度，另有任务末尾正常走纸")
    args = parser.parse_args()
    try:
        settings = PrintSettings(args.density, args.density_coefficient, args.speed, args.paper)
        if args.auto_off_minutes is not None:
            auto_off_command(args.auto_off_minutes)
    except ValueError as exc:
        parser.error(str(exc))
    if sum((bool(args.images), args.task is not None, args.feed_mm is not None)) > 1:
        parser.error("图片、--task、--feed-mm 只能选一种")
    if not (args.images or args.task or args.feed_mm is not None or args.status or args.auto_off_minutes is not None or args.paper):
        parser.error("指定图片、--task、--feed-mm 或控制/查询操作")
    if args.repeat < 1 or not 0 <= args.threshold <= 255 or args.completion_timeout <= 0:
        parser.error("重复次数、阈值或超时无效")
    if args.hold_seconds is not None and args.hold_seconds < 0:
        parser.error("保持时间不能小于零")
    run_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    logs = ROOT / "logs"
    logs.mkdir(exist_ok=True)
    summary_path = logs / f"{run_id}_summary.json"
    start = time.monotonic()
    summary = {"run_id": run_id, "status": "started", "jobs": [], "settings": settings.describe(),
               "auto_off_requested_minutes": args.auto_off_minutes, "feed_requested_mm": args.feed_mm}
    with (logs / f"{run_id}.jsonl").open("w", encoding="utf-8") as output:
        def log(event, **values):
            record = {"seconds": round(time.monotonic() - start, 6), "event": event, **values}
            output.write(json.dumps(record, ensure_ascii=False) + "\n")
            output.flush()
            if event not in ("tx", "ff03", "credit_return"):
                print(f"[{record['seconds']:7.3f}s] {event}: {json.dumps(values, ensure_ascii=False)}", flush=True)
        async def run(tasks):
            async with M04Printer(log, args.completion_timeout) as printer:
                if args.auto_off_minutes is not None:
                    summary["auto_off"] = await printer.set_auto_off(args.auto_off_minutes)
                if args.paper is not None:
                    summary["paper_mode"] = await printer.set_paper_mode(args.paper)
                if args.status:
                    summary["printer_status"] = await printer.get_status()
                for job_id, task in tasks:
                    result = await printer.print_task(task, job_id, args.hold_seconds, settings)
                    summary["jobs"].append(result.__dict__)
                summary["statistics"] = printer.statistics()
                log("statistics", **summary["statistics"])
        try:
            codec = MiniLZO()
            source_tasks = ([codec.parse(args.task.read_bytes(), str(args.task.resolve()))] if args.task else
                            [codec.blank_feed(args.feed_mm)] if args.feed_mm is not None else
                            [codec.image(path.resolve(), args.threshold) for path in args.images])
            tasks = []
            for _ in range(args.repeat):
                for task in source_tasks:
                    job_id = f"{run_id}_{len(tasks) + 1:03d}"
                    task.save(ROOT / "artifacts" / job_id)
                    (ROOT / "artifacts" / job_id / "settings.json").write_text(
                        json.dumps({**settings.describe(), "commands": {name: data.hex(" ") for name, data in settings.commands()}}, ensure_ascii=False, indent=2) + "\n")
                    tasks.append((job_id, task))
            log("prepared", jobs=len(tasks), artifacts=str(ROOT / "artifacts"), settings=settings.describe())
            if args.dry_run:
                summary["status"] = "dry_run"
            else:
                asyncio.run(run(tasks))
                summary["status"] = "complete" if args.hold_seconds is None else "manual_hold_unverified"
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
