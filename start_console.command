#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [ -n "${M04_PYTHON:-}" ]; then
    project_python="$M04_PYTHON"
elif [ -x .venv/bin/python3 ]; then
    project_python="$PWD/.venv/bin/python3"
else
    project_python="$(command -v python3)"
fi
exec "$project_python" -u console/run.py "$@"
