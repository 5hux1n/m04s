"""Run console tests with isolated PHP/storage; never starts the BLE worker."""
from pathlib import Path
import os
import shutil
import socket
import subprocess
import sys
import time

from make_fixtures import make_fixtures

ROOT = Path(__file__).resolve().parents[2]


def main():
    import requests
    make_fixtures()
    php = shutil.which('php')
    if not php:
        raise SystemExit('需要 PHP，请先安装并加入 PATH')
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', 8766))
        except OSError:
            raise SystemExit('测试端口 8766 已占用，请停止该端口服务后重试')
    data = ROOT / 'storage/console-test'
    tmp = data / 'tmp'
    logs = ROOT / 'logs/console'
    tmp.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(M04_CONSOLE_STORAGE=str(data), M04_PYTHON=sys.executable,
               TMPDIR=str(tmp), PYTHONPYCACHEPREFIX=str(tmp / 'pycache'))
    with (logs / 'software-test-php.log').open('w') as php_log:
        server = subprocess.Popen([php, '-d', f'upload_tmp_dir={tmp}', '-d', f'sys_temp_dir={tmp}',
                                   '-S', '127.0.0.1:8766', '-t', str(ROOT / 'console/public'),
                                   str(ROOT / 'console/router.php')], cwd=ROOT, env=env,
                                  stdout=php_log, stderr=php_log)
        try:
            for _ in range(50):
                try:
                    requests.get('http://127.0.0.1:8766', timeout=1).raise_for_status()
                    break
                except requests.RequestException:
                    if server.poll() is not None:
                        raise RuntimeError('测试服务退出，请查看 logs/console/software-test-php.log')
                    time.sleep(.1)
            else:
                raise RuntimeError('测试服务启动超时')
            return subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s',
                                   'console/tests', '-p', 'test_*.py', '-v'],
                                  cwd=ROOT, env=env).returncode
        finally:
            server.terminate()
            server.wait(timeout=5)


if __name__ == '__main__':
    sys.exit(main())
