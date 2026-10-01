"""Persistent BLE bridge for the local PHP console. Run through Terminal on macOS."""
from __future__ import annotations
import argparse
import asyncio
import fcntl
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from m04s_codec import MiniLZO
from m04s_driver import M04Printer
from m04s_settings import PrintSettings


class Worker:
    def __init__(self, database):
        self.database=database
        self.db=sqlite3.connect(database,timeout=5)
        self.db.row_factory=sqlite3.Row
        self.db.executescript((ROOT/'console/schema.sql').read_text())
        self.db.execute('PRAGMA busy_timeout=5000')
        self.printer=None
        self.job_id=None
        self.copy_index=0
        self.copies=1
        self.last_status=0
        self.stopping=False
        self.state={'connected':False,'phase':'尚未连接','values':{},'updated_at':None,'error':None}
        self.logfile=(ROOT/'logs/console'/f'worker_{time.strftime("%Y%m%d_%H%M%S")}.jsonl').open('a',encoding='utf-8')
        self.db.execute("UPDATE jobs SET status='failed',phase='服务重启，任务中止',error='上次任务未确认完成，请检查纸面后手动重试',finished_at=? WHERE status='running'",(time.time(),))
        self.db.commit()
        self.publish()

    def kv(self,key,value):
        self.db.execute('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,json.dumps(value,ensure_ascii=False)))

    def publish(self):
        self.kv('device',self.state)
        self.kv('heartbeat',time.time())
        self.db.commit()

    def log(self,event,**values):
        now=time.time()
        record={'time':now,'job_id':self.job_id,'event':event,**values}
        self.logfile.write(json.dumps(record,ensure_ascii=False)+'\n');self.logfile.flush()
        self.db.execute('INSERT INTO events(job_id,event,data,created_at) VALUES(?,?,?,?)',(self.job_id,event,json.dumps(values,ensure_ascii=False),now))
        phase=None;progress=None
        if event=='scan': self.state['phase']='正在寻找 M04S'
        elif event=='connected': self.state.update(connected=True,phase='已连接',error=None)
        elif event in ('disconnected','unexpected_disconnect'): self.state.update(connected=False,phase='已断开')
        elif event=='status_snapshot': self.state.update(values=values['values'],updated_at=now)
        elif event=='tx' and values.get('label')=='PRINT':
            phase=f'正在传输 · 第 {self.copy_index}/{self.copies} 份'
            progress=((self.copy_index-1)+.65*values['index']/values['total'])/self.copies
        elif event=='waiting_print_finished':
            phase=f'正在打印 · 第 {self.copy_index}/{self.copies} 份'
            progress=((self.copy_index-1)+.75)/self.copies
        elif event=='print_finished':
            phase='打印机已确认完成，正在收尾'
            progress=((self.copy_index-1)+.95)/self.copies
        if phase and self.job_id:
            self.db.execute('UPDATE jobs SET phase=?,progress=? WHERE id=?',(phase,progress,self.job_id))
        self.publish()

    def claim(self):
        self.db.execute('BEGIN IMMEDIATE')
        row=self.db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone()
        if row:
            self.db.execute("UPDATE jobs SET status='running',phase='正在处理',started_at=? WHERE id=? AND status='queued'",(time.time(),row['id']))
        self.db.commit()
        return row

    async def connect(self):
        if self.printer and self.printer.client.is_connected:
            return
        await self.disconnect()
        self.state.update(phase='正在连接',error=None);self.publish()
        printer=M04Printer(self.log)
        await printer.__aenter__()
        self.printer=printer
        await self.refresh()

    async def refresh(self):
        self.require_connected()
        await self.printer.get_status()
        self.last_status=time.monotonic()
        self.state['phase']='已连接';self.publish()

    def require_connected(self):
        if not self.printer or not self.printer.client.is_connected:
            raise ConnectionError('请先连接打印机')

    async def disconnect(self):
        printer,self.printer=self.printer,None
        if printer:
            await printer.close()
        self.state.update(connected=False,phase='尚未连接',values={},updated_at=None)
        self.publish()

    def settings(self,payload):
        s=payload.get('settings',{})
        return PrintSettings(s.get('density','medium'),s.get('coefficient'),s.get('speed'),s.get('paper'))

    async def execute(self,job):
        payload=json.loads(job['payload']);kind=job['kind']
        if kind=='connect': await self.connect();return {'connected':True}
        if kind=='disconnect': await self.disconnect();return {'connected':False}
        self.require_connected()
        if kind=='refresh': await self.refresh();return self.state['values']
        if kind=='settings':
            settings=self.settings(payload)
            async with self.printer.job_lock:
                commands=settings.commands()
                for i,(name,data) in enumerate(commands,1):
                    await self.printer.write(data,'SETTING_'+name.upper(),i,len(commands))
                await self.printer.credit.wait_until(lambda:self.printer.credit.available==self.printer.credit.capacity)
            if 'autoOff' in payload: await self.printer.set_auto_off(payload['autoOff'])
            if settings.paper: await self.printer.set_paper_mode(settings.paper)
            await self.refresh()
            return {'settings':settings.describe(),'device':self.state['values']}
        codec=MiniLZO()
        if kind=='feed':
            task=codec.blank_feed(float(payload['millimeters']));settings=PrintSettings();self.copies=1
        elif kind=='print':
            path=(ROOT/payload['image']).resolve()
            if not path.is_relative_to((self.database.parent/'renders').resolve()) or not path.is_file():
                raise ValueError('打印图像不存在或位置不合法')
            task=codec.image(path,width=int(payload.get('widthDots',592)))
            if task.height>12000:raise ValueError('内容过长')
            settings=self.settings(payload);self.copies=int(payload['settings'].get('copies',1))
            if not 1<=self.copies<=20:raise ValueError('份数超出范围')
        else:raise ValueError('未知任务')
        output=ROOT/'artifacts/console'/job['id']
        task.save(output)
        (output/'settings.json').write_text(json.dumps(settings.describe(),ensure_ascii=False,indent=2)+'\n')
        results=[]
        for copy in range(1,self.copies+1):
            self.copy_index=copy
            results.append((await self.printer.print_task(task,f"{job['id']}_{copy:03d}",settings=settings)).__dict__)
        # Once every copy has a device completion notification, a subsequent status
        # query failure must not invite accidental reprinting of completed paper.
        warning=None
        try: await self.refresh()
        except Exception as exc:
            warning=str(exc);self.state['error']=warning
            self.log('post_print_status_unavailable',error=warning)
            await self.disconnect()
        return {'jobs':results,'widthDots':task.width,'statusWarning':warning}

    async def heartbeat(self):
        while not self.stopping:
            self.publish()
            await asyncio.sleep(1)

    async def run(self):
        heartbeat=asyncio.create_task(self.heartbeat())
        try:
            while not self.stopping:
                job=self.claim()
                if not job:
                    if self.printer and self.printer.client.is_connected and time.monotonic()-self.last_status>30:
                        try: await self.refresh()
                        except Exception as exc:
                            self.state['error']=str(exc);await self.disconnect()
                    await asyncio.sleep(.2);continue
                self.job_id=job['id'];self.copy_index=1;self.copies=1
                self.log('console_job_start',kind=job['kind'])
                try:
                    result=await self.execute(job)
                    phase='打印机确认完成' if job['kind'] in ('print','feed') else '操作完成'
                    self.db.execute("UPDATE jobs SET status='completed',phase=?,progress=1,result=?,finished_at=? WHERE id=?",(phase,json.dumps(result,ensure_ascii=False),time.time(),self.job_id))
                    self.log('console_job_complete',kind=job['kind'])
                except Exception as exc:
                    message=f'{type(exc).__name__}: {exc}'
                    self.db.execute("UPDATE jobs SET status='failed',phase='操作失败',error=?,finished_at=? WHERE id=?",(message,time.time(),self.job_id))
                    self.state['error']=str(exc)
                    self.log('console_job_failed',error=message)
                    await self.disconnect()
                finally:
                    self.db.commit();self.job_id=None;self.publish()
        finally:
            self.stopping=True;heartbeat.cancel()
            await asyncio.gather(heartbeat,return_exceptions=True)
            await self.disconnect();self.kv('heartbeat',0);self.db.commit();self.logfile.close();self.db.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--database',type=Path,default=ROOT/'storage/console/console.sqlite');args=parser.parse_args()
    database=args.database.resolve()
    if not database.is_relative_to(ROOT):raise ValueError('服务数据必须保存在工作区')
    database.parent.mkdir(parents=True,exist_ok=True)
    lock=(database.parent/'worker.lock').open('w')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('打印服务已经在运行')
    (ROOT/'logs/console').mkdir(parents=True,exist_ok=True)
    worker=Worker(database)
    async def start():
        loop=asyncio.get_running_loop()
        for signum in (signal.SIGTERM,signal.SIGINT):
            loop.add_signal_handler(signum,lambda:setattr(worker,'stopping',True))
        await worker.run()
    asyncio.run(start())

if __name__=='__main__':main()
