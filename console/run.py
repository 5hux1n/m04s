"""Start both local services from Terminal, keeping all runtime files in the workspace."""
import fcntl
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'storage/console';LOGS=ROOT/'logs/console'
DATA.mkdir(parents=True,exist_ok=True);LOGS.mkdir(parents=True,exist_ok=True)
(DATA/'tmp').mkdir(exist_ok=True)
lock=(DATA/'console.lock').open('w')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
    print('控制台已在运行：http://127.0.0.1:8765',flush=True)
    webbrowser.open('http://127.0.0.1:8765');sys.exit(0)
php=shutil.which('php') or '/opt/homebrew/bin/php'
with socket.socket() as probe:
    probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    try:probe.bind(('127.0.0.1',8765))
    except OSError:raise SystemExit('端口 8765 已被占用，请查看已有服务。')
env=os.environ.copy();env.update(TMPDIR=str(DATA/'tmp'),M04_CONSOLE_STORAGE=str(DATA),M04_PYTHON=sys.executable,PYTHONPYCACHEPREFIX=str(DATA/'tmp/pycache'))
php_log=(LOGS/'php.log').open('a');worker_log=(LOGS/'worker.log').open('a')
server=subprocess.Popen([php,'-d','upload_max_filesize=10M','-d','post_max_size=20M','-d',f'upload_tmp_dir={DATA / "tmp"}','-d',f'sys_temp_dir={DATA / "tmp"}','-S','127.0.0.1:8765','-t',str(ROOT/'console/public'),str(ROOT/'console/router.php')],cwd=ROOT,env=env,stdout=php_log,stderr=php_log)
worker=subprocess.Popen([sys.executable,'-u',str(ROOT/'console/worker.py')],cwd=ROOT,env=env,stdout=worker_log,stderr=worker_log)
(DATA/'services.json').write_text(__import__('json').dumps({'supervisor':os.getpid(),'php':server.pid,'worker':worker.pid}))
stopping=False

def stop(signum,frame):
    global stopping
    stopping=True
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
print('M04S 打印工作台：http://127.0.0.1:8765\n关闭服务请在此窗口按 Ctrl+C。日志位于工作区 logs/console。',flush=True)
time.sleep(.6)
if '--no-open' not in sys.argv:webbrowser.open('http://127.0.0.1:8765')
try:
    while not stopping:
        if server.poll() is not None or worker.poll() is not None:
            print('服务进程退出，请查看 logs/console 中的日志。',flush=True);break
        time.sleep(.5)
finally:
    # Stop accepting new jobs, allow an active print to finish before disconnecting.
    if server.poll() is None:server.terminate()
    if worker.poll() is None:worker.terminate()
    try:worker.wait(timeout=135)
    except subprocess.TimeoutExpired:worker.kill();worker.wait()
    server.wait(timeout=5)
    (DATA/'services.json').unlink(missing_ok=True)
    php_log.close();worker_log.close()
