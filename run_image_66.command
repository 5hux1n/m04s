#!/bin/bash
set -o pipefail
cd "$(dirname "$0")" || exit 1
mkdir -p logs
if [ -n "${M04_PYTHON:-}" ]; then
    project_python="$M04_PYTHON"
elif [ -x .venv/bin/python3 ]; then
    project_python="$PWD/.venv/bin/python3"
else
    project_python="$(command -v python3)"
fi
"$project_python" -u m04s_print.py samples/66.png 2>&1 | /usr/bin/tee logs/image_66.log
replay_status=${PIPESTATUS[0]}
printf '%s\n' "$replay_status" > logs/image_66.exit
exit "$replay_status"
