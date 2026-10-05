import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync,existsSync,statSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..'),out=path.join(root,'web/dist'),artifacts=path.join(root,'artifacts/web-tests');mkdirSync(artifacts,{recursive:true});mkdirSync(path.join(root,'storage/web-test-tmp'),{recursive:true});process.env.TMPDIR=path.join(root,'storage/web-test-tmp');
const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(out,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(out+'/')||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404).end();return;}res.setHeader('Content-Type',{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[path.extname(file)]||'application/octet-stream');res.end(readFileSync(file));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=process.env.M04_WEB_TEST_URL||`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],writes=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',m=>{if(m.type()==='error')console.error('browser console:',m.text());});
  page.on('request',request=>{if(request.method()!=='GET')writes.push(request.url());});
  await page.addInitScript(()=>{
    const code={8:4,18:5,17:6,19:3,14:9,25:12,9:8};
    window.mockPackets=[];window.mockPrints=0;
    let autoOff=2,paperMode=11;
    class Characteristic extends EventTarget {
      constructor(uuid){super();this.uuid=uuid;this.properties={writeWithoutResponse:true};}
      notify(data){this.value=new DataView(Uint8Array.from(data).buffer);this.dispatchEvent(new Event('characteristicvaluechanged'));}
      async startNotifications(){if(this===credit)queueMicrotask(()=>{this.notify([1,7]);this.notify([2,244,0]);});return this;}
      async writeValueWithoutResponse(value){
        const data=Array.from(value);window.mockPackets.push(data);queueMicrotask(()=>credit.notify([1,1]));
        if(data[0]===31&&data[1]===17&&data.length===3){
          const request=data[2];if(code[request])queueMicrotask(()=>status.notify(request===9?[26,8,...new TextEncoder().encode('Q01612345678901')]:[26,code[request],{8:75,18:152,17:137,19:168,14:autoOff,25:paperMode}[request]]));
        }
        if(data[0]===27&&data[1]===78)autoOff=data[3];
        if(data[0]===31&&data[1]===17&&[10,11,38].includes(data[2]))paperMode=data[2];
        if(data.slice(0,4).join(',')==='29,118,48,0')window.mockRaster=[];
        if(window.mockRaster){window.mockRaster.push(...data);if(window.mockRaster.slice(-9).join(',')==='0,0,0,27,100,2,27,100,2'){window.lastRaster=window.mockRaster;window.mockRaster=null;window.mockPrints++;queueMicrotask(()=>status.notify([26,15,12]));}}
      }
    }
    const status=new Characteristic('ff01'),credit=new Characteristic('ff03'),write=new Characteristic('ff02');
    const device=new EventTarget();device.name='M04S';device.id='mock-device';device.gatt={connected:false,connect:async()=>{device.gatt.connected=true;return {getPrimaryService:async()=>({getCharacteristic:async uuid=>uuid.includes('ff01')?status:uuid.includes('ff03')?credit:write})};},disconnect:()=>{device.gatt.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));}};
    Object.defineProperty(navigator,'bluetooth',{value:{requestDevice:async()=>device},configurable:true});
  });
  await page.goto(base);await page.locator('#downloadButton:not([disabled])').waitFor();
  await page.locator('#connectionButton').click();await page.locator('#printButton:not([disabled])').waitFor();
  assert.equal(await page.locator('#batteryValue').innerText(),'75%');
  await page.locator('#labelPreset').selectOption('76x130');
  await page.locator('#labelFile').setInputFiles(path.join(root,'samples/66.png'));
  await page.waitForFunction(()=>document.getElementById('previewCanvas').height===1535&&document.getElementById('downloadButton').disabled===false);
  assert.equal(await page.locator('#paperWidth').inputValue(),'110');
  await page.locator('#labelPreset').selectOption('100x180');await page.waitForFunction(()=>document.getElementById('previewCanvas').height===2126);
  await page.locator('#printButton').click();await page.waitForFunction(()=>window.mockPrints===1);await page.waitForFunction(()=>jobs.some(j=>j.kind==='print'&&j.status==='completed'));
  const task=await page.evaluate(()=>window.lastRaster);writeFileSync(path.join(artifacts,'browser-task.bin'),Uint8Array.from(task));
  const savedTitle=await page.locator('#documentTitle').inputValue();await page.reload();await page.locator('#downloadButton:not([disabled])').waitFor();assert.equal(await page.locator('#documentTitle').inputValue(),savedTitle);assert.equal(await page.locator('#labelPreset').inputValue(),'100x180');assert.equal(await page.evaluate(()=>window.mockPrints),0);
  const pdf=path.join(root,'artifacts/console/fixtures/示例两页.pdf');
  await page.locator('#labelFile').setInputFiles(pdf);await page.waitForFunction(()=>doc.pages?.length===2).catch(async error=>{console.error('Import error:',await page.locator('#toast').textContent());throw error;});await page.locator('#downloadButton:not([disabled])').waitFor();
  await page.locator('#importPageSelect').selectOption('1');await page.waitForTimeout(200);assert.equal(await page.locator('#previewCanvas').evaluate(c=>c.height),2126);
  // DOCX uses the general importer, not the dedicated label upload.
  await page.locator('#labelPreset').selectOption('none');await page.locator('#documentFile').setInputFiles(path.join(root,'artifacts/console/fixtures/示例文档.docx'));await page.waitForFunction(()=>doc.blocks.some(b=>b.type==='text')&&doc.blocks.some(b=>b.type==='image'));await page.locator('#downloadButton:not([disabled])').waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:false});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:false});
  const unsupported=await browser.newPage();await unsupported.addInitScript(()=>Object.defineProperty(navigator,'bluetooth',{value:undefined,configurable:true}));await unsupported.goto(base);await unsupported.locator('#downloadButton:not([disabled])').waitFor();assert.equal(await unsupported.locator('#connectionButton').isDisabled(),true);assert.match(await unsupported.locator('.notice').first().innerText(),/iPhone/);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log('Browser passed: local drafts/assets, mock BLE credit/completion print, presets, reload without replay, PDF pages, DOCX images, responsive layout, unsupported-browser export, no cloud writes.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
