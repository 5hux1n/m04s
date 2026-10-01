const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),path=require('path'),fs=require('fs');

(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Layout-only check. Intercept writes so neither a stored draft nor hardware is changed.
 await page.route('**/api/**',async route=>{
  if(route.request().method()!=='GET'){
   if(!route.request().url().includes('/api/documents'))throw new Error('Unexpected non-draft write');
   const payload=route.request().postDataJSON();await route.fulfill({status:200,json:{id:'a'.repeat(32),title:payload.title}});return;
  }
  await route.continue();
 });
 const checks=[];
 try {
  await page.goto('http://127.0.0.1:8765');await page.locator('#downloadButton:not([disabled])').waitFor();
  await page.evaluate(async()=>{
   doc.blocks=Array.from({length:28},(_,i)=>textBlock('长内容排版 '+(i+1)+'\n实时预览保持可见',10,'left'));
   renderBlocks();await renderPreview();
  });
  for(const viewport of [{width:1440,height:1000},{width:1100,height:700},{width:1440,height:500}]){
   await page.setViewportSize(viewport);await page.evaluate(()=>scrollTo(0,1800));await page.waitForTimeout(100);
   const bounds=await page.evaluate(()=>{
    const column=document.querySelector('.preview-column').getBoundingClientRect(),card=document.querySelector('.preview-card').getBoundingClientRect(),paper=document.querySelector('.paper-viewport').getBoundingClientRect();
    return {scrollY,columnTop:column.top,columnBottom:column.bottom,cardTop:card.top,cardBottom:card.bottom,paperHeight:paper.height,viewportHeight:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.ok(bounds.scrollY>1000);assert.ok(Math.abs(bounds.columnTop-16)<2,JSON.stringify(bounds));assert.ok(bounds.columnBottom<=viewport.height-14,JSON.stringify(bounds));assert.ok(bounds.cardTop>=14&&bounds.cardBottom<viewport.height,JSON.stringify(bounds));assert.ok(bounds.paperHeight>70,JSON.stringify(bounds));assert.equal(bounds.overflow,0);checks.push({...viewport,...bounds});
  }
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,1800));
  await page.screenshot({path:path.resolve('../artifacts/console/sticky-preview-long-content.png')});
  await page.locator('#floatingPreviewButton').click();await expect(page.locator('#floatingPreview')).toBeVisible();
  const equal=()=>page.evaluate(()=>$('previewCanvas').toDataURL()===$('floatingPreviewCanvas').toDataURL());
  assert.equal(await equal(),true);
  const handle=await page.locator('#floatingPreviewHandle').boundingBox(),before=await page.locator('#floatingPreview').boundingBox();
  await page.mouse.move(handle.x+90,handle.y+18);await page.mouse.down();await page.mouse.move(handle.x-260,handle.y+85,{steps:8});await page.mouse.up();
  const after=await page.locator('#floatingPreview').boundingBox();assert.ok(after.x<before.x-200);assert.ok(after.y>before.y+40);
  await page.locator('#floatingPreviewHandle').focus();await page.keyboard.press('ArrowLeft');assert.ok((await page.locator('#floatingPreview').boundingBox()).x<after.x);
  await page.evaluate(async()=>{doc.blocks[0].text='编辑后浮窗仍实时同步';await renderPreview();});assert.equal(await equal(),true);
  await page.locator('#minimizeFloatingPreview').click();assert.ok((await page.locator('#floatingPreview').boundingBox()).height<65);
  await page.locator('#minimizeFloatingPreview').click();assert.ok((await page.locator('#floatingPreview').boundingBox()).height>200);
  // Native resize and subsequent viewport shrink must keep the close control reachable.
  const original=await page.locator('#floatingPreview').boundingBox();
  await page.mouse.move(original.x+original.width-4,original.y+original.height-4);await page.mouse.down();await page.mouse.move(original.x+original.width+60,original.y+original.height+40,{steps:8});await page.mouse.up();
  const resized=await page.locator('#floatingPreview').boundingBox();assert.ok(resized.width>original.width+20,JSON.stringify({original,resized}));
  await page.screenshot({path:path.resolve('../artifacts/console/floating-preview-desktop.png')});
  await page.setViewportSize({width:390,height:600});await page.waitForTimeout(150);
  const mobile=await page.locator('#floatingPreview').boundingBox();assert.ok(mobile.x>=10&&mobile.y>=10);assert.ok(mobile.x+mobile.width<=380&&mobile.y+mobile.height<=590,JSON.stringify(mobile));
  await page.screenshot({path:path.resolve('../artifacts/console/floating-preview-mobile.png')});
  await page.locator('#closeFloatingPreview').click();await expect(page.locator('#floatingPreview')).toBeHidden();await expect(page.locator('#previewLauncher')).toBeVisible();
  await page.evaluate(()=>scrollTo(0,2400));await page.locator('#previewLauncher').click();assert.equal(await equal(),true);
  await page.evaluate(()=>setPage('settings'));await expect(page.locator('#floatingPreview')).toBeHidden();await expect(page.locator('#previewLauncher')).toBeHidden();
  await page.evaluate(()=>setPage('editor'));await expect(page.locator('#floatingPreview')).toBeVisible();
  await page.locator('#floatingPreviewHandle').focus();await page.keyboard.press('Escape');await expect(page.locator('#floatingPreview')).toBeHidden();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.resolve('../logs/console/preview-layout.json'),JSON.stringify({desktopSticky:checks,floatingPixelMatch:true,drag:true,keyboardMove:true,minimize:true,resize:true,smallViewportBounds:mobile,pageVisibility:true,errors,hardwareWrites:0},null,2));
  console.log('Long content sticky preview, viewport height, floating sync, drag/resize/minimize, mobile bounds and page visibility: passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
