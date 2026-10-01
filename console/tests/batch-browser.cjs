const {chromium,expect}=require('@playwright/test'),assert=require('node:assert/strict'),path=require('path'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'../..'),python=process.env.M04_PYTHON||'python3';
function heartbeat(value){execFileSync(python,['-c','import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);db.execute("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",("heartbeat",sys.argv[2]));db.commit();db.close()',path.join(root,'storage/console-test/console.sqlite'),String(value)]);}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage();let ids=[];
 try {
  // This isolated test simulates online state; it never connects to the physical printer.
  await page.route('**/api/bootstrap',async route=>{const response=await route.fetch(),data=await response.json();data.device={...data.device,worker_online:true,connected:true,phase:'TEST DEVICE'};await route.fulfill({response,json:data});});
  await page.route('**/api/state',async route=>{const response=await route.fetch(),data=await response.json();data.device={...data.device,worker_online:true,connected:true,phase:'TEST DEVICE'};await route.fulfill({response,json:data});});
  await page.goto('http://127.0.0.1:8766');await page.locator('#downloadButton:not([disabled])').waitFor();
  await page.locator('#paperWidth').selectOption('53');await page.locator('#documentFile').setInputFiles(path.join(root,'artifacts/console/fixtures/示例两页.pdf'));
  await expect(page.locator('#importState')).toContainText('已导入 2 页',{timeout:30000});
  heartbeat(Date.now()/1000);const timer=setInterval(()=>heartbeat(Date.now()/1000),2000);
  try {
   page.on('response',async response=>{if(response.url().endsWith('/api/print')&&response.status()===202)ids.push((await response.json()).id);});
   await page.locator('#printAllPages').click();await expect(page.locator('#toast')).toContainText('2 页已加入队列');assert.equal(ids.length,2);
   const checks=await page.evaluate(async ids=>{const state=await api('/api/state');let result=[];for(const id of ids){const job=state.jobs.find(j=>j.id===id);result.push({title:job.title,status:job.status});await api('/api/jobs/'+id+'/cancel',{});}return result;},ids);
   assert.ok(checks[0].title.endsWith('第 1 页'));assert.ok(checks[1].title.endsWith('第 2 页'));assert.ok(checks.every(j=>j.status==='queued'));
   console.log('Two PDF pages use separate ordered real queue jobs; queued cancellation passed. No hardware involved.');
  }finally{clearInterval(timer);}
 }finally{heartbeat(0);await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
