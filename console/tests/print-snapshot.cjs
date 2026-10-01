const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage();
 let savingStarted,printReceived;
 const saving=new Promise(resolve=>savingStarted=resolve);
 const submitted=new Promise(resolve=>printReceived=resolve);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Read the running console, but intercept every write. This check neither edits
 // the user's stored draft nor sends a job to the physical printer.
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(request.method()==='GET'){
   const response=await route.fetch();const data=await response.json();
   if(data.device)data.device={...data.device,connected:true,worker_online:true};
   await route.fulfill({response,json:data});return;
  }
  if(url.pathname.startsWith('/api/documents')){
   savingStarted();await new Promise(resolve=>setTimeout(resolve,350));
   await route.fulfill({status:200,json:{id:url.pathname.split('/').pop(),title:request.postDataJSON().title}});return;
  }
  if(url.pathname==='/api/print'){
   printReceived(request.postDataJSON());
   await route.fulfill({status:202,json:{id:'f'.repeat(32)}});return;
  }
  throw new Error('Unexpected write attempted: '+url.pathname);
 });
 try {
  await page.goto('http://127.0.0.1:8765/');await page.locator('#printButton:not([disabled])').waitFor();
  await page.locator('#paperWidth').selectOption('53');await page.locator('#printButton:not([disabled])').waitFor();
  await page.locator('#documentTitle').fill('点击时的标题');
  await page.locator('#printButton').click();await saving;
  await page.locator('#paperWidth').selectOption('110');
  await page.locator('#documentTitle').fill('随后编辑的新标题');
  await expect.poll(()=>page.locator('#previewCanvas').evaluate(canvas=>canvas.width)).toBe(1248);
  const payload=await submitted;
  const bytes=Buffer.from(payload.png.split(',')[1],'base64');
  assert.equal(bytes.readUInt32BE(16),568);
  assert.equal(payload.widthDots,568);
  assert.equal(payload.title,'点击时的标题');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.resolve('../logs/console/print-snapshot.json'),JSON.stringify({clickedWidth:568,laterEditorWidth:1248,queuedPngWidth:bytes.readUInt32BE(16),queuedWidth:payload.widthDots,titlePreserved:true,errors,physicalPrintSubmitted:false,draftWritesIntercepted:true},null,2));
  console.log('Print snapshot keeps original PNG, paper width, and title during later edits. No hardware or saved draft changed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
