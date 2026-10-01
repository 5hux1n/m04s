import asyncio
import base64
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import uuid

import requests
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'console'));sys.path.insert(0,str(ROOT))
from worker import Worker
from import_content import Importer
from m04s_codec import MiniLZO


class ApiTests(unittest.TestCase):
    base='http://127.0.0.1:8766'
    storage=ROOT/'storage/console-test'

    @classmethod
    def setUpClass(cls):
        requests.get(cls.base,timeout=5).raise_for_status()
        cls.headers={'X-Console-Token':(cls.storage/'csrf.token').read_text()}

    def post(self,path,data=None,headers=None,**kwargs):
        if 'files' in kwargs:kwargs['data']=data;data=None
        return requests.post(self.base+path,json=data,headers=self.headers if headers is None else headers,timeout=60,**kwargs)

    def heartbeat(self,value):
        db=sqlite3.connect(self.storage/'console.sqlite')
        try:
            db.execute("INSERT INTO kv VALUES('heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(value),))
            db.commit()
        finally:db.close()

    def test_csrf_and_origin(self):
        self.assertEqual(self.post('/api/settings',{},headers={}).status_code,403)
        self.assertEqual(self.post('/api/settings',{},headers={**self.headers,'Origin':'https://example.com'}).status_code,403)
        response=requests.get(self.base+'/api/bootstrap',headers={'Host':'example.com:8766'},timeout=5)
        self.assertEqual(response.status_code,403)

    def test_invalid_settings_and_widths(self):
        for data in ({'copies':0},{'copies':2.5},{'speed':256},{'density':'unknown'},{'paper':'unknown'}):
            self.assertEqual(self.post('/api/settings',data).status_code,400)
        self.assertEqual(self.post('/api/device',{'action':'feed','millimeters':0}).status_code,400)
        self.assertEqual(self.post('/api/device',{'action':'settings','autoOff':7}).status_code,400)

    def test_offline_does_not_create_print_file(self):
        self.heartbeat(0);before=set((self.storage/'renders').glob('*.png'))
        stream=io.BytesIO();Image.new('RGB',(592,50),'white').save(stream,format='PNG')
        response=self.post('/api/print',{'png':'data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()})
        self.assertEqual(response.status_code,503);self.assertEqual(before,set((self.storage/'renders').glob('*.png')))

    def test_widths_queue_preview_and_cancel(self):
        try:
            for width in (568,848,1248,592):
                self.heartbeat(time.time());stream=io.BytesIO();Image.new('RGB',(width,40),'white').save(stream,format='PNG')
                png='data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()
                self.assertEqual(self.post('/api/print',{'png':png,'widthDots':width+8}).status_code,400)
                response=self.post('/api/print',{'title':'API TEST','png':png,'widthDots':width});self.assertEqual(response.status_code,202,response.text)
                identifier=response.json()['id'];preview=requests.get(self.base+'/job-preview/'+identifier,timeout=5)
                self.assertEqual(Image.open(io.BytesIO(preview.content)).size,(width,40))
                self.assertEqual(self.post('/api/jobs/'+identifier+'/cancel',{}).status_code,200)
                self.assertEqual(self.post('/api/jobs/'+identifier+'/cancel',{}).status_code,409)
        finally:self.heartbeat(0)

    def test_imports_and_private_web_address(self):
        self.assertEqual(self.post('/api/import/web',{'url':'http://127.0.0.1/'}).status_code,400)
        self.assertEqual(self.post('/api/import/web',{'url':'file:///etc/passwd'}).status_code,400)
        fixtures=ROOT/'artifacts/console/fixtures'
        with (fixtures/'示例两页.pdf').open('rb') as file:
            response=self.post('/api/import/document',files={'document':('test.pdf',file,'application/pdf')},data={'pages':'2'})
        self.assertEqual(response.status_code,201,response.text);self.assertEqual(response.json()['pages'][0]['number'],2)
        with (fixtures/'示例两页.pdf').open('rb') as file:
            response=self.post('/api/import/document',files={'document':('test.pdf',file,'application/pdf')},data={'pages':'3'})
        self.assertEqual(response.status_code,400)


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        folder=ROOT/'storage/console-test/worker-tests';folder.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=folder);self.path=Path(self.temp.name)
        (self.path/'renders').mkdir();self.worker=Worker(self.path/'console.sqlite')
        self.calls=[];self.finished=asyncio.Event();self.finished.set();self.refresh_failure=False
        self.printer=SimpleNamespace(client=SimpleNamespace(is_connected=True),print_task=self.print_task,get_status=self.status,close=self.close)
        self.worker.printer=self.printer

    async def asyncTearDown(self):
        self.worker.logfile.close();self.worker.db.close();self.temp.cleanup()

    async def print_task(self,task,job_id,settings):
        self.calls.append((task,job_id));await self.finished.wait()
        return SimpleNamespace(completion='ff01_1a0f0c',height=task.height)

    async def status(self):
        if self.refresh_failure:raise ConnectionError('Disconnected after confirmed print')
        self.worker.log('status_snapshot',values={'battery':{'percent':50}})

    async def close(self):self.printer.client.is_connected=False

    def job(self,width=568,copies=2):
        file=self.path/'renders'/'test.png';Image.new('RGB',(width,90),'white').save(file)
        return {'id':uuid.uuid4().hex,'kind':'print','payload':json.dumps({'image':str(file.relative_to(ROOT)),'widthDots':width,'settings':{'copies':copies}})}

    async def test_confirmed_copies_preserve_preview_width(self):
        job=self.job(1248);self.worker.copies=2
        result=await self.worker.execute(job)
        self.assertEqual(len(result['jobs']),2);self.assertEqual([task.width for task,_ in self.calls],[1248,1248])
        artifact=ROOT/'artifacts/console'/job['id']
        with Image.open(artifact/'preview.png') as image:self.assertEqual(image.size,(1248,90))
        self.assertEqual(MiniLZO().parse((artifact/'printtask.bin').read_bytes()).width,1248)

    async def test_completion_wait_and_status_failure_does_not_fail_completed_paper(self):
        self.finished.clear();self.refresh_failure=True
        pending=asyncio.create_task(self.worker.execute(self.job(copies=1)));await asyncio.sleep(.01)
        self.assertFalse(pending.done());self.finished.set();result=await pending
        self.assertEqual(result['jobs'][0]['completion'],'ff01_1a0f0c');self.assertIsNotNone(result['statusWarning'])

    async def test_claim_order_and_running_recovery(self):
        db=self.worker.db
        for identifier,created in [('a'*32,1),('b'*32,2)]:db.execute('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)',(identifier,'refresh','{}',created))
        db.commit();self.assertEqual(self.worker.claim()['id'],'a'*32);self.assertEqual(self.worker.claim()['id'],'b'*32);self.assertIsNone(self.worker.claim())
        recovered=Worker(self.path/'console.sqlite')
        self.assertEqual(recovered.db.execute("SELECT count(*) FROM jobs WHERE status='failed'").fetchone()[0],2)
        recovered.logfile.close();recovered.db.close()


class ImportTests(unittest.TestCase):
    def test_page_ranges(self):
        self.assertEqual(Importer.page_numbers('1-3,2,5',5),[1,2,3,5])
        for value,count in [('0',2),('3',2),('2-1',2),('x',2),('',21),('1-21',30)]:
            with self.assertRaises(ValueError):Importer.page_numbers(value,count)

if __name__=='__main__':unittest.main()
