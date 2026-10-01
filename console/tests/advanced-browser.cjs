const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const out=path.resolve('../artifacts/console'),fixtures=path.join(out,'fixtures');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8766/');await page.locator('#downloadButton:not([disabled])').waitFor();
 await page.locator('#newDocumentButton').click();await expect(page.locator('#documentTitle')).toHaveValue('未命名作品');
 await page.locator('#blocks textarea').first().fill('图文工作台测试');await page.waitForTimeout(900);
 for(const [paper,width] of [['53',568],['80',848],['110',1248],['legacy',592]]){
  await page.locator('#paperWidth').selectOption(paper);await expect.poll(()=>page.locator('#previewCanvas').evaluate(c=>c.width)).toBe(width);
 }
 await page.locator('#paperWidth').selectOption('53');
 const text=page.locator('.block').filter({has:page.locator('textarea')}).first();
 const raster=()=>page.locator('#previewCanvas').evaluate(c=>c.toDataURL());
 await page.waitForTimeout(300);const original=await raster();
 await text.getByLabel('排版方向',{exact:true}).selectOption('vertical-rl');await page.waitForTimeout(300);assert.notEqual(await raster(),original);
 await text.getByLabel('排版方向',{exact:true}).selectOption('vertical-lr');await page.waitForTimeout(300);
 await text.getByLabel('旋转 / 反向',{exact:true}).selectOption('180');await page.waitForTimeout(300);
 await text.getByLabel('镜像文字',{exact:true}).check();await page.waitForTimeout(300);
 await text.getByLabel('排版方向',{exact:true}).selectOption('horizontal');await text.getByLabel('旋转 / 反向',{exact:true}).selectOption('0');await text.getByLabel('镜像文字',{exact:true}).uncheck();
 await page.locator('#imageFile').setInputFiles(path.join(fixtures,'效果测试.png'));await page.locator('.image-thumb').waitFor();
 const block=page.locator('.block').filter({has:page.locator('.image-thumb')});
 const hashes={};
 for(const effect of ['original','photo','line','sketch','text']){
  await block.getByLabel('处理效果',{exact:true}).selectOption(effect);await page.waitForTimeout(300);hashes[effect]=await raster();
  const downloadPromise=page.waitForEvent('download');await page.locator('#downloadButton').click();const download=await downloadPromise;await download.saveAs(path.join(out,'effect-'+effect+'.png'));
 }
 assert.equal(new Set(Object.values(hashes)).size,5,'each effect changes actual raster');
 for(const [label,value] of [['明暗','35'],['对比度','25']])await block.getByLabel(label,{exact:true}).evaluate((input,v)=>{input.value=v;input.dispatchEvent(new Event('input',{bubbles:true}));},value);await page.waitForTimeout(250);
 await block.getByRole('button',{name:'框选裁剪',exact:true}).click();await page.locator('#cropDialog[open]').waitFor();
 const bounds=await page.locator('#cropCanvas').boundingBox();await page.mouse.move(bounds.x+bounds.width*.15,bounds.y+bounds.height*.2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.85,bounds.y+bounds.height*.8);await page.mouse.up();
 await page.screenshot({path:path.join(out,'crop-desktop.png')});
 await page.locator('#applyCrop').click();await expect(block.getByLabel('裁剪',{exact:true})).toHaveValue('custom');
 await page.waitForTimeout(900);await page.screenshot({path:path.join(out,'editor-monochrome.png'),fullPage:true});
 await page.reload();await page.locator('#downloadButton:not([disabled])').waitFor();await expect(page.locator('#paperWidth')).toHaveValue('53');await expect(page.locator('.block').filter({has:page.locator('.image-thumb')}).getByLabel('裁剪',{exact:true})).toHaveValue('custom');
 for(const filename of ['示例文字.txt','示例文档.docx','示例两页.pdf']){
  await page.locator('#documentFile').setInputFiles(path.join(fixtures,filename));
  await expect(page.locator('#importState')).not.toContainText('正在导入',{timeout:30000});
  assert.ok(!(await page.locator('#importState').textContent()).includes('失败'));
  await expect(page.locator('#documentTitle')).toHaveValue(path.parse(filename).name);
  await page.locator('#downloadButton:not([disabled])').waitFor();
 }
 assert.equal(await page.locator('#importPageSelect option').count(),2);
 await page.locator('#importPageSelect').selectOption('1');await page.waitForTimeout(900);
 await page.reload();await page.locator('#downloadButton:not([disabled])').waitFor();await expect(page.locator('#importPageSelect')).toHaveValue('1');
 await page.screenshot({path:path.join(out,'document-desktop.png'),fullPage:true});
 await page.locator('#webUrl').fill('https://example.com');await page.locator('#webImages').uncheck();await page.locator('#importWebButton').click();
 await expect(page.locator('#importState')).toContainText('已导入',{timeout:45000});await expect(page.locator('#documentTitle')).toHaveValue('Example Domain');
 await page.locator('#downloadButton:not([disabled])').waitFor();await page.screenshot({path:path.join(out,'web-import-desktop.png'),fullPage:true});
 const result=await page.evaluate(async()=>{
   const base={version:1,layout:{paperWidth:'53',heightMode:'auto',margin:2,threshold:180},blocks:[{type:'text',text:'ABC测试',size:12,lineHeight:1.5,gap:0,align:'left'}]};
   const a=(await buildPreview(base)).canvas;const b=(await buildPreview({...base,blocks:[{...base.blocks[0],rotation:180}]})).canvas;
   return {normal:a.width,reverse:b.width,changed:a.toDataURL()!==b.toDataURL()};
 });assert.equal(result.normal,568);assert.ok(result.changed);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'editor-monochrome-mobile.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert.equal(overflow,0);assert.deepEqual(errors,[]);
 fs.writeFileSync(path.resolve('../logs/console/advanced-browser.json'),JSON.stringify({paperWidths:[568,848,1248,592],effects:Object.keys(hashes),imports:['TXT','DOCX','PDF','web'],pdfPages:2,verticalAndReverse:true,crop:true,persistence:true,mobileOverflow:overflow,errors},null,2));
 console.log('Paper widths, image effects, crop, typography, TXT/Word/PDF/web imports, persistence, mobile: passed');await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
