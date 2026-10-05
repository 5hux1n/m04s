'use strict';
const $ = (id) => document.getElementById(id);
const WIDTH = 592, DPI = 300, DOTS_MM = DPI / 25.4, MAX_HEIGHT = 12000;
const papers = {'53':{dots:568,mm:53},'80':{dots:848,mm:80},'110':{dots:1248,mm:110},legacy:{dots:592,mm:53}};
function paperProfile(layout=doc.layout){return papers[String(layout.paperWidth)]||papers.legacy;}
const token = document.querySelector('meta[name="console-token"]').content;
let doc = null, documentId = null, selectedPage = 'editor', settings = null, device = {}, jobs = [], drafts = [];
let previewVersion = 0, previewReady = false, previewError = '', zoom = 1, saveTimer, previewTimer, toastTimer, saving = false, dirty = false, booted = false, pollInProgress = false, submitting = false;
const imageCache = new Map();
const fonts = {sans:'"PingFang SC", "Microsoft YaHei", sans-serif',serif:'"Songti SC", "SimSun", serif',mono:'Menlo, "PingFang SC", monospace'};
const modeNames = {continuous:'连续纸',gap:'间隙模式', 'black-mark':'黑标模式'};
const statusNames = {queued:'等待处理',running:'处理中',completed:'已完成',failed:'失败',cancelled:'已取消'};
const jobNames = {print:'打印作品',feed:'空白走纸',connect:'连接设备',disconnect:'断开设备',refresh:'刷新状态',settings:'应用设置'};

async function api(path, data, method='POST') {
  if(window.WebPlatform) return window.WebPlatform.request(path,data,data===undefined?'GET':method);
  const options = {method:data===undefined?'GET':method,headers:{'X-Console-Token':token},cache:'no-store'};
  if (data!==undefined) {
    if (data instanceof FormData) options.body=data;
    else { options.headers['Content-Type']='application/json'; options.body=JSON.stringify(data); }
  }
  const response=await fetch(path,options);
  let value;
  try { value=await response.json(); } catch { throw new Error('服务暂时不可用，请检查控制台是否已启动'); }
  if (!response.ok) throw new Error(value.error||'操作失败');
  return value;
}
function toast(message,error=false) {
  clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;
  toastTimer=setTimeout(()=>{$('toast').hidden=true;},error?6500:3500);
}
function element(tag,attrs={},children=[]) {
  const node=document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (key==='text') node.textContent=value;
    else if (key==='class') node.className=value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2),value);
    else if(key==='src' && window.WebPlatform && value.startsWith('/media/')) window.WebPlatform.assetURL(value.slice(7)).then(url=>node.src=url).catch(error=>toast(error.message,true));
    else if (key in node) node[key]=value;
    else node.setAttribute(key,value);
  }
  for (const child of children) node.append(child);
  return node;
}
function clamp(value,min,max,fallback=min) {const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;}
function numberInput(value,min,max,onchange,step=1) {
  return element('input',{type:'number',value,min,max,step,oninput:e=>onchange(clamp(e.target.value,min,max,value))});
}
function selectInput(value,options,onchange) {
  return element('select',{onchange:e=>onchange(e.target.value)},options.map(([v,label])=>element('option',{value:v,text:label,selected:v===value})));
}
function labelInput(label,input) {input.setAttribute('aria-label',label);return element('label',{text:label},[input]);}
function uid() {return crypto.randomUUID();}
function textBlock(text='请输入文字',size=12,align='left',bold=false) {return {id:uid(),type:'text',text,size,align,bold,font:'sans',lineHeight:1.5,gap:3};}
function defaultDocument() {
  return {version:1,layout:{paperWidth:settings?.paperWidth||'53',heightMode:'auto',height:60,margin:3,processing:'threshold',threshold:180},blocks:[textBlock('你好，M04S',20,'center',true),{id:uid(),type:'divider',style:'dashed',gap:3},textBlock('这是我的第一张作品。\n\n编辑文字，上传图片，\n让每一次打印都刚刚好。',11),textBlock('— 记录生活的小片段 —',9,'center')]};
}
function normalizeDocument(content) {
  const base=defaultDocument();
  return {...content,version:1,layout:{...base.layout,paperWidth:'legacy',...content.layout},blocks:(content.blocks||[]).map(block=>({...block,id:block.id||uid()}))};
}
function setPage(page) {
  selectedPage=page;
  for (const node of document.querySelectorAll('.page')) node.classList.toggle('active',node.id==='page-'+page);
  for (const node of document.querySelectorAll('.nav-item')) node.classList.toggle('active',node.dataset.page===page);
  $('pageTitle').textContent={editor:'图文编辑器',device:'设备状态',settings:'打印设置',history:'打印记录'}[page];
  PreviewPanel.setPage(page);
  history.replaceState(null,'','#'+page);
}
function changed() {saveActivePage();dirty=true;$('saveState').textContent='有未保存修改';scheduleSave();previewVersion++;previewReady=false;updatePrintButton();clearTimeout(previewTimer);previewTimer=setTimeout(renderPreview,60);}
function scheduleSave() {clearTimeout(saveTimer);saveTimer=setTimeout(saveDocument,700);}
async function saveDocument() {
  clearTimeout(saveTimer);
  if (!doc || !dirty || saving) return;
  saving=true;dirty=false;$('saveState').textContent='正在保存…';
  const savedDocument=JSON.parse(JSON.stringify(doc));
  const title=$('documentTitle').value.trim()||'未命名作品';
  try {
    const result=await api('/api/documents'+(documentId?'/'+documentId:''),{title,content:savedDocument});
    documentId=result.id;$('saveState').textContent=dirty?'有未保存修改':'已自动保存';
    await refreshDrafts();
  } catch (error) {dirty=true;$('saveState').textContent='保存失败';toast(error.message,true);}
  finally {saving=false;if(dirty)scheduleSave();}
}
async function flushSave() {clearTimeout(saveTimer);await saveDocument();while(saving){await new Promise(resolve=>setTimeout(resolve,30));}if(dirty)await saveDocument();if(dirty)throw new Error('草稿保存失败，请重试后继续');}
async function refreshDrafts() {
  drafts=await api('/api/documents');
  $('draftSelect').replaceChildren(element('option',{value:'',text:'选择已保存的草稿'}),...drafts.map(d=>element('option',{value:d.id,text:d.title,selected:d.id===documentId})));
}
async function loadDraft(id) {
  await flushSave();const draft=await api('/api/documents/'+id);documentId=draft.id;doc=normalizeDocument(draft.content);$('documentTitle').value=draft.title;dirty=false;
  $('saveState').textContent='已保存';syncLayout();renderBlocks();await renderPreview();await refreshDrafts();
}
function syncLayout() {
  const layout=doc.layout;
  const label=layout.labelPreset && layout.labelPreset!=='none';
  $('labelPreset').value=layout.labelPreset||'none';
  for(const [id,fallback] of [['labelWidth',76],['labelHeight',130],['labelInset',0]]) {$(id).value=layout[id]??fallback;$(id).disabled=!label;}
  $('paperWidth').value=layout.paperWidth;
  const paper=paperProfile(layout);
  $('paperWidthNote').textContent=`纸卷 ${paper.mm} mm，可打印约 ${(paper.dots/DOTS_MM).toFixed(1)} mm。请与实际安装纸卷保持一致。`;
  $('heightMode').value=layout.heightMode;$('paperHeight').value=layout.height;$('paperHeight').disabled=layout.heightMode!=='fixed';$('paperMargin').value=layout.margin;$('processing').value=layout.processing;$('threshold').value=layout.threshold;$('thresholdValue').value=layout.threshold;
  if(label){$('paperHeight').disabled=true;} $('heightMode').disabled=!!label;$('paperMargin').disabled=!!label;$('processing').disabled=!!label;
  $('threshold').disabled=layout.processing==='dither';
  syncImportedPages();
}
function syncImportedPages() {
  const pages=doc.pages||[];$('importPages').hidden=!pages.length;
  $('importPageSelect').replaceChildren(...pages.map((page,index)=>element('option',{value:index,text:'第 '+page.number+' 页',selected:index===(doc.activePage||0)})));
}
function saveActivePage(){if(doc.pages?.length)doc.pages[doc.activePage||0].blocks=JSON.parse(JSON.stringify(doc.blocks));}
function renderBlocks() {
  $('blockCount').textContent=doc.blocks.length+' 个内容块';
  $('blocks').replaceChildren(...doc.blocks.map((block,index)=>{
    const typeName={text:'文字',image:'图片',divider:'分隔线',space:'留白'}[block.type];
    const move=(direction)=>{const next=index+direction;if(next<0||next>=doc.blocks.length)return;[doc.blocks[index],doc.blocks[next]]=[doc.blocks[next],doc.blocks[index]];renderBlocks();changed();};
    const buttons=element('div',{class:'block-buttons'},[
      element('button',{class:'icon-button',text:'↑',title:'上移',ariaLabel:'上移'+typeName,disabled:index===0,onclick:()=>move(-1)}),
      element('button',{class:'icon-button',text:'↓',title:'下移',ariaLabel:'下移'+typeName,disabled:index===doc.blocks.length-1,onclick:()=>move(1)}),
      element('button',{class:'icon-button',text:'⧉',title:'复制',ariaLabel:'复制'+typeName,onclick:()=>{doc.blocks.splice(index+1,0,{...block,id:uid()});renderBlocks();changed();}}),
      element('button',{class:'icon-button',text:'×',title:'删除',ariaLabel:'删除'+typeName,onclick:()=>{doc.blocks.splice(index,1);renderBlocks();changed();}})]);
    const node=element('article',{class:'block','data-block-id':block.id},[
      element('div',{class:'block-top'},[element('div',{class:'block-name'},[element('span',{class:'block-number',text:String(index+1).padStart(2,'0')}),element('b',{text:typeName})]),buttons])]);
    const update=(key,value)=>{block[key]=value;changed();};
    if(block.type==='text') {
      node.append(element('textarea',{value:block.text,maxLength:20000,ariaLabel:'文字内容 '+(index+1),oninput:e=>update('text',e.target.value)}));
      node.append(element('div',{class:'form-grid three'},[
        labelInput('字号（pt）',numberInput(block.size||12,6,48,v=>update('size',v),.5)),
        labelInput('对齐',selectInput(block.align||'left',[['left','左对齐'],['center','居中'],['right','右对齐']],v=>update('align',v))),
        labelInput('字体',selectInput(block.font||'sans',[['sans','黑体'],['serif','宋体'],['mono','等宽']],v=>update('font',v)))]));
      node.append(element('div',{class:'form-grid'},[labelInput('行距',numberInput(block.lineHeight||1.5,1,2.5,v=>update('lineHeight',v),.1)),labelInput('段后留白（mm）',numberInput(block.gap??3,0,30,v=>update('gap',v),.5))]));
      node.append(element('div',{class:'form-grid'},[
        labelInput('排版方向',selectInput(block.direction||'horizontal',[['horizontal','横排'],['vertical-rl','竖排 · 从右到左'],['vertical-lr','竖排 · 从左到右']],v=>update('direction',v))),
        labelInput('旋转 / 反向',selectInput(String(block.rotation||0),[['0','正常'],['90','顺时针 90°'],['180','反向 180°'],['270','逆时针 90°']],v=>update('rotation',Number(v))))]));
      node.append(element('label',{class:'check-label',text:'镜像文字'},[element('input',{type:'checkbox',checked:!!block.mirror,onchange:e=>update('mirror',e.target.checked)})]));
      node.append(labelInput('竖排每列字数',numberInput(block.columnChars||12,1,80,v=>update('columnChars',v))));
      node.append(element('label',{class:'check-label',text:'加粗'},[element('input',{type:'checkbox',checked:!!block.bold,onchange:e=>update('bold',e.target.checked)})]));
    } else if(block.type==='image') {
      node.append(element('img',{class:'image-thumb',src:'/media/'+block.asset,alt:'上传图片预览'}));
      node.append(element('div',{class:'form-grid three'},[
        labelInput('宽度（%）',numberInput(block.width||100,10,100,v=>update('width',v))),
        labelInput('对齐',selectInput(block.align||'center',[['left','左对齐'],['center','居中'],['right','右对齐']],v=>update('align',v))),
        labelInput('旋转',selectInput(String(block.rotation||0),[['0','不旋转'],['90','90°'],['180','180°'],['270','270°']],v=>update('rotation',Number(v))))]));
      node.append(element('div',{class:'form-grid'},[
        labelInput('裁剪',selectInput(block.crop||'original',[['original','保留全图'],['square','方形裁剪'],['wide','横幅裁剪'],['custom','自定义选区']],v=>{update('crop',v);if(v==='custom')openCrop(block); })),
        labelInput('图片后留白（mm）',numberInput(block.gap??3,0,30,v=>update('gap',v),.5))]));
      node.append(element('div',{class:'image-actions'},[
        element('button',{class:'btn small',text:'框选裁剪',onclick:()=>openCrop(block)}),
        element('button',{class:'btn small',text:'重置处理',onclick:()=>{Object.assign(block,{effect:'original',brightness:0,contrast:0,strength:50,rotation:0,crop:'original',cropRect:null,invert:false});renderBlocks();changed();}})]));
      node.append(labelInput('处理效果',selectInput(block.effect||'original',[['original','原图 · 跟随纸面处理'],['photo','黑白照片'],['line','线稿'],['sketch','素描'],['text','文字增强']],v=>update('effect',v))));
      for(const [key,title,min,max,initial] of [['brightness','明暗',-100,100,0],['contrast','对比度',-100,100,0],['strength','效果强度',1,100,50]]){
        const output=element('output',{text:String(block[key]??initial)});
        node.append(element('label',{class:'range-label',text:title},[output,element('input',{type:'range',min,max,ariaLabel:title,value:block[key]??initial,oninput:e=>{output.value=e.target.value;update(key,Number(e.target.value));}})]));
      }
      node.append(element('label',{class:'check-label',text:'反色'},[element('input',{type:'checkbox',checked:!!block.invert,onchange:e=>update('invert',e.target.checked)})]));
    } else if(block.type==='divider') {
      node.append(element('div',{class:'form-grid'},[labelInput('线条',selectInput(block.style||'dashed',[['dashed','虚线'],['solid','实线']],v=>update('style',v))),labelInput('下方留白（mm）',numberInput(block.gap??3,0,30,v=>update('gap',v),.5))]));
    } else {node.append(labelInput('留白高度（mm）',numberInput(block.height||5,1,100,v=>update('height',v),.5)));}
    return node;
  }));
  if(!doc.blocks.length)$('blocks').append(element('div',{class:'empty-state'},[element('h2',{text:'在这里开始创作'}),element('p',{text:'添加一个文字块，或上传一张图片。'})]));
}
function imageFor(asset) {
  if(!imageCache.has(asset))imageCache.set(asset,new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>{imageCache.delete(asset);reject(new Error('图片加载失败，请重新上传'));};if(window.WebPlatform)window.WebPlatform.assetURL(asset).then(url=>image.src=url).catch(reject);else image.src='/media/'+asset;}));
  return imageCache.get(asset);
}
function rotatedImage(image,rotation,maxDimension=1600) {
  const rotated=document.createElement('canvas'),quarter=rotation===90||rotation===270;
  const scale=Math.min(1,maxDimension/Math.max(image.naturalWidth,image.naturalHeight),Math.sqrt(16000000/(image.naturalWidth*image.naturalHeight)));
  const iw=Math.max(1,Math.round(image.naturalWidth*scale)),ih=Math.max(1,Math.round(image.naturalHeight*scale));
  rotated.width=quarter?ih:iw;rotated.height=quarter?iw:ih;
  const ctx=rotated.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,rotated.width,rotated.height);
  ctx.translate(rotated.width/2,rotated.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(image,-iw/2,-ih/2,iw,ih);return rotated;
}
let cropSession=null;
function drawCrop() {
  if(!cropSession)return;
  const {image,rect}=cropSession,canvas=$('cropCanvas'),ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const x=rect.x*canvas.width,y=rect.y*canvas.height,w=rect.width*canvas.width,h=rect.height*canvas.height;
  ctx.fillStyle='#0009';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.clearRect(x,y,w,h);ctx.drawImage(image,x/canvas.width*image.width,y/canvas.height*image.height,w/canvas.width*image.width,h/canvas.height*image.height,x,y,w,h);
  ctx.strokeStyle='white';ctx.lineWidth=3;ctx.strokeRect(x,y,w,h);ctx.strokeStyle='black';ctx.lineWidth=1;ctx.strokeRect(x-1,y-1,w+2,h+2);
  for(const key of ['x','y','width','height'])$('crop-'+key).value=Math.round(rect[key]*100);
}
async function openCrop(block) {
  try {
    const image=rotatedImage(await imageFor(block.asset),Number(block.rotation)||0),canvas=$('cropCanvas');
    const scale=Math.min(1,700/image.width,500/image.height);canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    cropSession={block,image,rect:validCrop(block.cropRect),start:null};drawCrop();$('cropDialog').showModal();
  }catch(error){toast(error.message,true);}
}
function validCrop(rect) {
  const x=clamp(rect?.x,0,.98,0),y=clamp(rect?.y,0,.98,0);
  return {x,y,width:clamp(rect?.width,.02,1-x,1-x),height:clamp(rect?.height,.02,1-y,1-y)};
}
function bindCrop() {
  const canvas=$('cropCanvas');
  const point=e=>{const bounds=canvas.getBoundingClientRect();return {x:clamp((e.clientX-bounds.left)/bounds.width,0,1),y:clamp((e.clientY-bounds.top)/bounds.height,0,1)};};
  canvas.onpointerdown=e=>{if(!cropSession)return;cropSession.start=point(e);canvas.setPointerCapture(e.pointerId);};
  canvas.onpointermove=e=>{if(!cropSession?.start)return;const start=cropSession.start,end=point(e);cropSession.rect=validCrop({x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)});drawCrop();};
  canvas.onpointerup=canvas.onpointercancel=()=>{if(cropSession)cropSession.start=null;};
  for(const key of ['x','y','width','height'])$('crop-'+key).onchange=e=>{if(!cropSession)return;cropSession.rect=validCrop({...cropSession.rect,[key]:Number(e.target.value)/100});drawCrop();};
  $('resetCrop').onclick=()=>{cropSession.rect={x:0,y:0,width:1,height:1};drawCrop();};
  $('cancelCrop').onclick=()=>{$('cropDialog').close();cropSession=null;};
  $('applyCrop').onclick=()=>{if(!cropSession)return;cropSession.block.crop='custom';cropSession.block.cropRect={...cropSession.rect};$('cropDialog').close();cropSession=null;renderBlocks();changed();};
  $('cropDialog').oncancel=()=>{cropSession=null;};
}
function wrapText(ctx,text,maxWidth) {
  const lines=[];
  for(const paragraph of String(text).replace(/\r/g,'').split('\n')) {
    if(!paragraph){lines.push('');continue;}
    let line='';
    const words=paragraph.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/gu)||[];
    for(const word of words) {
      if(ctx.measureText(line+word).width<=maxWidth){line+=word;continue;}
      if(line){lines.push(line.trimEnd());line='';}
      if(ctx.measureText(word).width<=maxWidth){line=word.trimStart();continue;}
      for(const character of word){if(line&&ctx.measureText(line+character).width>maxWidth){lines.push(line);line='';}line+=character;}
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
function processBitmap(canvas,mode,threshold) {
  const ctx=canvas.getContext('2d',{willReadFrequently:true});const frame=ctx.getImageData(0,0,canvas.width,canvas.height),data=frame.data;
  if(mode==='dither') {
    const gray=new Float32Array(canvas.width*canvas.height);
    for(let i=0;i<gray.length;i++)gray[i]=.2126*data[i*4]+.7152*data[i*4+1]+.0722*data[i*4+2];
    const w=canvas.width,h=canvas.height;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=y*w+x,newValue=gray[i]<128?0:255,error=gray[i]-newValue;data[i*4]=data[i*4+1]=data[i*4+2]=newValue;
      if(x+1<w)gray[i+1]+=error*7/16;
      if(y+1<h){if(x>0)gray[i+w-1]+=error*3/16;gray[i+w]+=error*5/16;if(x+1<w)gray[i+w+1]+=error/16;}
    }
  } else {
    for(let i=0;i<data.length;i+=4){const v=.299*data[i]+.587*data[i+1]+.114*data[i+2]<threshold?0:255;data[i]=data[i+1]=data[i+2]=v;}
  }
  ctx.putImageData(frame,0,0);
}
function textCanvas(block,available) {
  const size=clamp(block.size,6,48,12)*DPI/72,lineHeight=size*clamp(block.lineHeight,1,2.5,1.5);
  const font=`${block.bold?'700':'400'} ${size}px ${fonts[block.font]||fonts.sans}`;
  const rotation=Number(block.rotation)||0,quarter=rotation===90||rotation===270;
  const vertical=['vertical-rl','vertical-lr'].includes(block.direction);
  const canvas=document.createElement('canvas'),measure=canvas.getContext('2d');measure.font=font;
  let lines,columns,maxChars;
  if(vertical) {
    maxChars=clamp(block.columnChars||12,1,80,12);
    columns=[];
    for(const paragraph of String(block.text).split('\n')){
      const chars=Array.from(paragraph);if(!chars.length)columns.push([]);
      for(let i=0;i<chars.length;i+=maxChars)columns.push(chars.slice(i,i+maxChars));
    }
    if(!columns.length)columns=[[]];
    canvas.width=Math.ceil(columns.length*lineHeight);canvas.height=Math.ceil(Math.max(1,...columns.map(c=>c.length))*size*1.2);
  }else {
    lines=wrapText(measure,block.text,available);canvas.width=Math.ceil(available);canvas.height=Math.ceil(Math.max(1,lines.length)*lineHeight);
  }
  if(canvas.width*canvas.height>16000000||canvas.width>MAX_HEIGHT||canvas.height>MAX_HEIGHT)throw new Error('文字块过长，请拆成多个文字块');
  const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.font=font;ctx.fillStyle='black';ctx.textBaseline='top';
  if(vertical){ctx.textAlign='center';columns.forEach((chars,col)=>{const x=(block.direction==='vertical-rl'?columns.length-col-.5:col+.5)*lineHeight;chars.forEach((char,row)=>ctx.fillText(char,x,row*size*1.2));});}
  else {ctx.textAlign=block.align||'left';const x=block.align==='center'?canvas.width/2:block.align==='right'?canvas.width:0;lines.forEach((line,i)=>ctx.fillText(line,x,i*lineHeight+(lineHeight-size)/2));}
  const result=document.createElement('canvas');result.width=quarter?canvas.height:canvas.width;result.height=quarter?canvas.width:canvas.height;
  const out=result.getContext('2d');out.translate(result.width/2,result.height/2);out.rotate(rotation*Math.PI/180);if(block.mirror)out.scale(-1,1);out.drawImage(canvas,-canvas.width/2,-canvas.height/2);
  // Keep physical font size for normal text; large vertical/rotated blocks fit the printable width.
  const scale=Math.min(1,available/result.width);return {image:result,width:result.width*scale,height:result.height*scale};
}
async function buildLabelPreview(snapshot) {
  if(snapshot.blocks.length!==1 || snapshot.blocks[0].type!=='image') throw new Error('面单模式每页需且仅需一张完整图片；请上传面单 PDF 或新建空白草稿后添加一张面单图片');
  const block=snapshot.blocks[0], paper=paperProfile(snapshot.layout);
  if(block.crop && block.crop!=='original' || block.invert || block.effect && block.effect!=='original' || Number(block.brightness)||Number(block.contrast)) throw new Error('面单需保留完整条码，请先点击图片的“重置处理”；可以使用旋转调整方向');
  const image=rotatedImage(await imageFor(block.asset),Number(block.rotation)||0,MAX_HEIGHT);
  const g=ShippingLabel.geometry(snapshot.layout,paper.dots,image.width,image.height);
  const canvas=document.createElement('canvas');canvas.width=g.width;canvas.height=g.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,g.width,g.height);
  ctx.imageSmoothingEnabled=false;ctx.drawImage(image,g.x,g.y,g.drawWidth,g.drawHeight);
  processBitmap(canvas,'threshold',clamp(snapshot.layout.threshold,40,240,180));
  return {canvas,height:g.height,paper,clipped:false,printable:true};
}
async function buildPreview(snapshot) {
    if(snapshot.layout.labelPreset && snapshot.layout.labelPreset!=='none') return buildLabelPreview(snapshot);
    await document.fonts.ready;
    const paper=paperProfile(snapshot.layout),WIDTH=paper.dots;
    const margin=clamp(snapshot.layout.margin,0,15,3)*DOTS_MM,available=WIDTH-2*margin;
    const measure=document.createElement('canvas').getContext('2d');let y=margin;const operations=[];
    let printable=false;
    for(const block of snapshot.blocks){
      if(block.type==='text') {
        const rendered=textCanvas(block,available);
        operations.push({type:'text',block,y,...rendered});y+=rendered.height;
        if(String(block.text).trim())printable=true;
        y+=clamp(block.gap,0,30,3)*DOTS_MM;
      } else if(block.type==='image') {
        const rotated=rotatedImage(await imageFor(block.asset),Number(block.rotation)||0);
        let sx=0,sy=0,sw=rotated.width,sh=rotated.height;
        if(block.crop==='square'){sw=sh=Math.min(sw,sh);sx=(rotated.width-sw)/2;sy=(rotated.height-sh)/2;}
        else if(block.crop==='wide'){const ratio=2;if(sw/sh>ratio){sw=sh*ratio;sx=(rotated.width-sw)/2;}else{sh=sw/ratio;sy=(rotated.height-sh)/2;}}
        else if(block.crop==='custom'){const rect=validCrop(block.cropRect);sx=rect.x*sw;sy=rect.y*sh;sw*=rect.width;sh*=rect.height;}
        const width=available*clamp(block.width,10,100,100)/100,height=width*sh/sw;
        operations.push({type:'image',block,image:rotated,sx,sy,sw,sh,width,height,y});y+=height+clamp(block.gap,0,30,3)*DOTS_MM;printable=true;
      } else if(block.type==='divider'){operations.push({type:'divider',block,y});y+=3+clamp(block.gap,0,30,3)*DOTS_MM;printable=true;}
      else y+=clamp(block.height,1,100,5)*DOTS_MM;
      if(y+margin>MAX_HEIGHT)throw new Error('内容超过最大长度，请缩短文字、图片或留白');
    }
    const contentHeight=Math.ceil(y+margin);
    const height=snapshot.layout.heightMode==='fixed'?Math.round(clamp(snapshot.layout.height,15,1000,60)*DOTS_MM):Math.max(180,contentHeight);
    if(height>MAX_HEIGHT)throw new Error('纸面高度超过最大长度');
    const clipped=snapshot.layout.heightMode==='fixed'&&contentHeight>height;
    const canvas=document.createElement('canvas');canvas.width=WIDTH;canvas.height=height;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='white';ctx.fillRect(0,0,WIDTH,height);
    for(const op of operations){
      if(op.type==='text') {
        const x=op.block.align==='center'?(WIDTH-op.width)/2:op.block.align==='right'?WIDTH-margin-op.width:margin;
        ctx.drawImage(op.image,x,op.y,op.width,op.height);
      }else if(op.type==='image') {
        const x=op.block.align==='left'?margin:op.block.align==='right'?WIDTH-margin-op.width:(WIDTH-op.width)/2;
        const processed=document.createElement('canvas');processed.width=Math.max(1,Math.round(op.width));processed.height=Math.max(1,Math.round(op.height));
        processed.getContext('2d').drawImage(op.image,op.sx,op.sy,op.sw,op.sh,0,0,processed.width,processed.height);
        ImageTools.canvas(processed,op.block);ctx.drawImage(processed,x,op.y,op.width,op.height);
      }else {
        ctx.strokeStyle='black';ctx.lineWidth=2;ctx.setLineDash(op.block.style==='solid'?[]:[10,7]);ctx.beginPath();ctx.moveTo(margin,op.y+1);ctx.lineTo(WIDTH-margin,op.y+1);ctx.stroke();ctx.setLineDash([]);
      }
    }
    processBitmap(canvas,snapshot.layout.processing,clamp(snapshot.layout.threshold,40,240,180));
    return {canvas,height,paper,clipped,printable};
}
async function renderPreview() {
  if(!doc)return;
  const version=++previewVersion;previewReady=false;$('previewState').textContent='正在更新…';updatePrintButton();
  PreviewPanel.syncState();
  const snapshot=JSON.parse(JSON.stringify(doc));
  try {
    const {canvas,height,paper,clipped,printable}=await buildPreview(snapshot),WIDTH=canvas.width;
    if(version!==previewVersion)return;
    $('previewCanvas').width=WIDTH;$('previewCanvas').height=height;$('previewCanvas').getContext('2d').drawImage(canvas,0,0);
    $('widthRuler').textContent=`${paper.mm} mm 纸 · 可打印 ${(WIDTH/DOTS_MM).toFixed(1)} mm`;
    $('paperDimensions').textContent=`${(WIDTH/DOTS_MM).toFixed(1)} × ${(height/DOTS_MM).toFixed(1)} mm · ${WIDTH} × ${height} 点`;
    previewError=clipped?'内容超出固定高度，请增加高度或改为自动延长':!printable?'请添加文字或图片后打印':'';
    $('previewState').textContent=previewError|| (snapshot.layout.labelPreset && snapshot.layout.labelPreset!=='none'?`面单 ${snapshot.layout.labelWidth} × ${snapshot.layout.labelHeight} mm · 完整等比例适配`:snapshot.layout.processing==='dither'?'照片抖动':'黑白点阵');$('previewState').style.color=previewError?'#111':'';
    previewReady=printable&&!clipped;updatePrintButton();PreviewPanel.sync();
  } catch(error) {
    if(version!==previewVersion)return;previewReady=false;previewError=error.message;$('previewState').textContent=error.message;$('previewState').style.color='#111';updatePrintButton();PreviewPanel.syncState();
  }
}
function updatePrintButton() {
  $('printButton').disabled=submitting||!previewReady||!device.connected||!device.worker_online;
  $('printButton').title=previewError||(!device.connected?'请先连接打印机':'将当前预览提交到打印队列');
  $('downloadButton').disabled=!previewReady;
  $('printAllPages').disabled=submitting||!device.connected||!device.worker_online||!doc?.pages?.length;
}
function syncSettings() {
  document.querySelector(`input[name="density"][value="${settings.density}"]`).checked=true;
  $('settingCoefficient').value=settings.coefficient??'';$('settingSpeed').value=settings.speed??'';$('settingPaper').value=settings.paper??'';$('settingCopies').value=settings.copies;
  $('settingPaperWidth').value=settings.paperWidth||'53';
}
function readSettings() {
  const coefficient=$('settingCoefficient').value,speed=$('settingSpeed').value;
  const value={density:document.querySelector('input[name="density"]:checked').value,coefficient:coefficient===''?null:Number(coefficient),speed:speed===''?null:Number(speed),paper:$('settingPaper').value||null,copies:Number($('settingCopies').value),paperWidth:$('settingPaperWidth').value};
  if(!Number.isInteger(value.copies)||value.copies<1||value.copies>20)throw new Error('打印份数应为 1–20 的整数');
  for(const key of ['coefficient','speed'])if(value[key]!==null&&(!Number.isInteger(value[key])||value[key]<1||value[key]>255))throw new Error('高级参数应为 1–255 的整数');
  return value;
}
function dateTime(timestamp){return new Date(timestamp*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}
function updateDevice(next) {
  device=next;const online=!!device.worker_online,connected=!!device.connected;
  $('serviceDot').classList.toggle('online',online);$('serviceLabel').replaceChildren(document.createTextNode(window.WebPlatform?(online?'浏览器打印已就绪':'此浏览器无法连接蓝牙'):(online?'打印服务已就绪':'打印服务未启动')),element('small',{text:window.WebPlatform?'此设备的浏览器':'本机工作区'}));
  const dot=$('connectionChip').querySelector('.dot');dot.classList.toggle('online',connected);$('connectionChip').querySelector('span').textContent=connected?'M04S 已连接':device.phase||'未连接';
  for(const id of ['connectionButton','deviceConnectButton']){$(id).textContent=connected?'断开连接':'连接打印机';$(id).disabled=!online||jobs.some(j=>['connect','disconnect'].includes(j.kind)&&['queued','running'].includes(j.status));}
  $('devicePhase').textContent=device.phase||'尚未连接';$('deviceError').hidden=!device.error;$('deviceError').textContent=device.error||'';
  const values=device.values||{};
  $('batteryValue').textContent=connected&&values.battery?.percent!=null?values.battery.percent+'%':'—';$('batteryBar').style.width=connected&&values.battery?.percent!=null?values.battery.percent+'%':'0%';
  $('coverValue').textContent=!connected||values.cover?.open==null?'未知':values.cover.open?'上盖打开':'上盖已合';
  $('paperValue').textContent=!connected||values.paper?.present==null?'未知':values.paper.present?'纸张就绪':'缺纸';
  $('temperatureValue').textContent=!connected?'未知':({normal:'温度正常',overheated:'温度过高'}[values.temperature?.state]||'未知');
  $('devicePaperMode').textContent=connected?(modeNames[values.paper_mode?.mode]||'未知'):'—';
  $('deviceAutoOff').textContent=connected&&values.auto_off?.minutes!=null?(values.auto_off.minutes===0?'不自动关机':values.auto_off.minutes+' 分钟'):'—';
  $('statusUpdated').textContent=connected&&device.updated_at?'更新于 '+dateTime(device.updated_at):'尚未读取';
  for(const id of ['refreshStatusButton','feedButton','applyDeviceSettingsButton'])$(id).disabled=!connected||!online;
  if(connected&&values.auto_off?.minutes!=null&&!$('autoOffMinutes').dataset.touched){
    const minutes=values.auto_off.minutes;if(!Array.from($('autoOffMinutes').options).some(o=>Number(o.value)===minutes))$('autoOffMinutes').append(element('option',{value:minutes,text:minutes+' 分钟'}));$('autoOffMinutes').value=minutes;
  }
  updatePrintButton();
}
function updateJobs(next) {
  const previous=new Map(jobs.map(j=>[j.id,j.status]));jobs=next;
  for(const job of jobs){if(booted&&previous.has(job.id)&&previous.get(job.id)!==job.status){if(job.status==='failed')toast(job.error||'任务失败',true);else if(job.status==='completed')toast((job.title||'任务')+' · 已完成');}}
  const pending=jobs.filter(j=>['queued','running'].includes(j.status));
  $('queueBadge').hidden=!pending.length;$('queueBadge').textContent=pending.length;
  $('completedCount').textContent=jobs.filter(j=>j.kind==='print'&&j.status==='completed').length;$('pendingCount').textContent=pending.length;$('failedCount').textContent=jobs.filter(j=>j.status==='failed').length;
  const active=pending.find(j=>j.status==='running'&&['print','feed'].includes(j.kind))||pending.find(j=>['print','feed'].includes(j.kind));
  $('activeJob').hidden=!active;if(active){$('activeJobTitle').textContent=active.title;$('activeJobPhase').textContent=active.phase;$('activeJobProgress').value=active.progress;}
  $('historyEmpty').hidden=jobs.length>0;$('historyBody').replaceChildren(...jobs.map(job=>{
    const title=element('td',{},[element('strong',{text:job.title}),element('small',{text:jobNames[job.kind]+(job.kind==='print'?' · '+job.copies+' 份':'')})]);
    const status=element('td',{},[element('span',{class:'status-pill '+job.status,text:statusNames[job.status]}),element('small',{text:job.error||job.phase})]);
    const actions=element('td',{},[element('button',{class:'btn',text:'详情',onclick:()=>jobDetail(job)})]);
    if(job.status==='queued')actions.append(element('button',{class:'btn',text:'取消',onclick:async()=>{try{await api('/api/jobs/'+job.id+'/cancel',{});await poll();}catch(e){toast(e.message,true);}}}));
    return element('tr',{},[title,element('td',{text:dateTime(job.created_at)}),status,actions]);
  }));
}
async function poll() {
  if(pollInProgress)return;pollInProgress=true;
  try {const state=await api('/api/state');updateJobs(state.jobs);updateDevice(state.device);}
  catch(error){updateDevice({...device,worker_online:false,connected:false,phase:'服务连接中断'});}
  finally {pollInProgress=false;}
}
async function deviceAction(action,extra={}) {
  try {const job=await api('/api/device',{action,...extra});toast(action==='connect'?'正在连接 M04S…':'操作已加入队列');await poll();return job;}
  catch(error){toast(error.message,true);}
}
async function confirmAction(title,message,label='确认') {
  $('confirmTitle').textContent=title;$('confirmMessage').textContent=message;$('confirmOkay').textContent=label;$('confirmDialog').showModal();
  return new Promise(resolve=>{
    const finish=(value)=>{$('confirmOkay').removeEventListener('click',ok);$('confirmCancel').removeEventListener('click',no);$('confirmDialog').removeEventListener('cancel',cancel);$('confirmDialog').close();resolve(value);};
    const ok=()=>finish(true),no=()=>finish(false),cancel=(e)=>{e.preventDefault();finish(false);};
    $('confirmOkay').addEventListener('click',ok);$('confirmCancel').addEventListener('click',no);$('confirmDialog').addEventListener('cancel',cancel);
  });
}
async function jobDetail(job) {
  $('jobDialogTitle').textContent=job.title;const content=$('jobDialogContent');content.replaceChildren(element('p',{text:statusNames[job.status]+' · '+(job.error||job.phase)}));
  if(job.preview)content.append(element('img',{src:job.preview,alt:'此任务实际提交的打印预览'}));
  if(job.result?.jobs)content.append(element('p',{class:'field-note',text:'完成结果来自打印机通知。'+job.result.jobs.length+' 份已确认完成。'}));
  $('jobDialog').showModal();
  try {
    const {events}=await api('/api/jobs/'+job.id);
    const names={console_job_start:'开始处理',scan:'寻找打印机',connected:'设备已连接',print_settings:'应用打印参数',job_start:'开始打印',transport_drained:'传输完成',waiting_print_finished:'等待设备打印完成',print_finished:'收到设备完成通知',job_complete:'本份打印完成',status_snapshot:'状态已更新',console_job_complete:'任务完成',console_job_failed:'任务失败',disconnected:'设备已断开',auto_off_verified:'关机时间回读一致',paper_mode_verified:'纸张模式回读一致'};
    for(const item of events)if(names[item.event])content.append(element('div',{class:'job-event'},[element('time',{text:dateTime(item.created_at)}),element('b',{text:names[item.event]})]));
  }catch(error){toast(error.message,true);}
}
function downloadPreview() {
  if(!previewReady){toast(previewError||'预览尚未生成',true);return;}
  $('previewCanvas').toBlob(blob=>{const link=element('a',{href:URL.createObjectURL(blob),download:($('documentTitle').value||'M04S作品')+'.png'});link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);},'image/png');
}
async function printDocument() {
  if(!previewReady||!device.connected){toast(previewError||'请先连接打印机',true);return;}
  if(submitting)return;submitting=true;updatePrintButton();
  try {
    const snapshot=$('previewCanvas').toDataURL('image/png');
    const widthDots=$('previewCanvas').width,title=$('documentTitle').value||'未命名作品';
    const value=readSettings();await flushSave();
    await api('/api/print',{title,settings:value,png:snapshot,widthDots});toast('作品已加入打印队列');await poll();
  }catch(error){toast(error.message,true);}finally{submitting=false;updatePrintButton();}
}
async function uploadImages(files) {
  if(!files.length)return;
  $('addImageButton').disabled=true;
  try {
    for(const file of files){if(file.size>10*1024*1024)throw new Error('图片最大 10 MB');const data=new FormData();data.append('image',file);const uploaded=await api('/api/uploads',data);doc.blocks.push({id:uid(),type:'image',asset:uploaded.id,width:100,align:'center',rotation:0,crop:'original',gap:3,invert:false});}
    renderBlocks();changed();toast('图片已添加，可选择效果、调整明暗或框选裁剪');
  }catch(error){renderBlocks();changed();toast(error.message,true);}finally{$('addImageButton').disabled=false;$('imageFile').value='';}
}
async function importContent(kind,file) {
  const buttons=[$('importWebButton'),$('importDocumentButton')];buttons.forEach(b=>b.disabled=true);$('importState').textContent='正在导入，请稍候…';
  try {
    await flushSave();let imported;
    if(kind==='web'){
      const url=$('webUrl').value.trim();if(!url)throw new Error('请先粘贴网页链接');
      imported=await api('/api/import/web',{url,images:$('webImages').checked});
    }else {
      if(!file)return;if(file.size>10*1024*1024)throw new Error('文档最大 10 MB');
      const form=new FormData();form.append('document',file);form.append('pages',$('importPageRange').value);
      imported=await api('/api/import/document',form);
    }
    const layout={...doc.layout,heightMode:'auto'};
    doc={version:1,layout,blocks:imported.blocks,pages:imported.pages||[],activePage:0,sourceUrl:imported.sourceUrl||null};documentId=null;
    $('documentTitle').value=imported.title;syncLayout();renderBlocks();changed();await saveDocument();
    $('importState').textContent=imported.note;toast('已导入，检查预览后即可打印');
  }catch(error){$('importState').textContent=error.message;toast(error.message,true);}
  finally{buttons.forEach(b=>b.disabled=false);$('documentFile').value='';}
}
async function printAllImportedPages() {
  if(!doc.pages?.length||!device.connected)return;
  if(submitting)return;submitting=true;updatePrintButton();let submitted=0;
  try {
    saveActivePage();await flushSave();const snapshot=JSON.parse(JSON.stringify(doc)),value=readSettings(),title=$('documentTitle').value;
    const ready=[];
    // Validate every page before submitting the first one. Each page uses the same preview pipeline.
    for(const page of snapshot.pages){const rendered=await buildPreview({...snapshot,blocks:page.blocks});if(rendered.clipped||!rendered.printable)throw new Error('第 '+page.number+' 页无法打印，请检查内容');ready.push({page,canvas:rendered.canvas});}
    for(const {page,canvas} of ready){await api('/api/print',{title:title+' · 第 '+page.number+' 页',settings:value,png:canvas.toDataURL('image/png'),widthDots:canvas.width});submitted++;}
    toast(submitted+' 页已加入队列');await poll();
  }catch(error){toast((submitted?submitted+' 页已提交；':'')+error.message,true);}
  finally{submitting=false;updatePrintButton();}
}
function bindEvents() {
  PreviewPanel.init();
  $('uploadLabelButton').onclick=()=>$('labelFile').click();
  $('labelFile').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    $('uploadLabelButton').disabled=true;
    try {
      await flushSave();
      const layout={...doc.layout};
      if(!layout.labelPreset || layout.labelPreset==='none')Object.assign(layout,{labelPreset:'76x130',labelWidth:76,labelHeight:130,labelInset:0,paperWidth:'110',processing:'threshold'});
      if(file.size>10*1024*1024)throw new Error('面单文件最大 10 MB');
      let imported;
      if(file.name.toLowerCase().endsWith('.pdf')){
        const form=new FormData();form.append('document',file);form.append('pages',$('importPageRange').value);
        imported=await api('/api/import/document',form);
      }else{
        const form=new FormData();form.append('image',file);const uploaded=await api('/api/uploads',form);
        imported={title:file.name,blocks:[{id:uid(),type:'image',asset:uploaded.id,rotation:0,crop:'original',effect:'original'}]};
      }
      doc={version:1,layout,blocks:imported.blocks,pages:imported.pages||[],activePage:0};documentId=null;
      $('documentTitle').value=imported.title;syncLayout();renderBlocks();changed();await saveDocument();toast('面单已导入，请核对预览、纸卷与尺寸');
    }catch(error){toast(error.message,true);}finally{$('uploadLabelButton').disabled=false;$('labelFile').value='';}
  };
  $('labelPreset').onchange=e=>{
    const value=e.target.value;doc.layout.labelPreset=value;
    if(value!=='none'){
      const [width,height]=value==='custom'?[doc.layout.labelWidth||76,doc.layout.labelHeight||130]:value.split('x').map(Number);
      Object.assign(doc.layout,{labelWidth:width,labelHeight:height,labelInset:doc.layout.labelInset??0,paperWidth:'110',processing:'threshold'});
    }
    syncLayout();changed();
  };
  for(const id of ['labelWidth','labelHeight','labelInset'])$(id).onchange=e=>{doc.layout[id]=Number(e.target.value);doc.layout.labelPreset='custom';syncLayout();changed();};
  bindCrop();
  $('importWebButton').onclick=()=>importContent('web');
  $('importDocumentButton').onclick=()=>$('documentFile').click();
  $('documentFile').onchange=e=>{if(e.target.files[0])importContent('document',e.target.files[0]);};
  $('importPageSelect').onchange=e=>{saveActivePage();doc.activePage=Number(e.target.value);doc.blocks=JSON.parse(JSON.stringify(doc.pages[doc.activePage].blocks));renderBlocks();changed();};
  $('printAllPages').onclick=printAllImportedPages;
  document.querySelectorAll('[data-page]').forEach(node=>node.addEventListener('click',()=>setPage(node.dataset.page)));
  document.querySelectorAll('[data-go]').forEach(node=>node.addEventListener('click',()=>setPage(node.dataset.go)));
  $('documentTitle').addEventListener('input',()=>{dirty=true;scheduleSave();});
  $('addTextButton').onclick=()=>{doc.blocks.push(textBlock());renderBlocks();changed();const textareas=$('blocks').querySelectorAll('textarea');textareas[textareas.length-1].focus();};
  $('addImageButton').onclick=()=>$('imageFile').click();$('imageFile').multiple=true;$('imageFile').onchange=e=>uploadImages(Array.from(e.target.files));
  $('addDividerButton').onclick=()=>{doc.blocks.push({id:uid(),type:'divider',style:'dashed',gap:3});renderBlocks();changed();};
  $('addSpaceButton').onclick=()=>{doc.blocks.push({id:uid(),type:'space',height:5});renderBlocks();changed();};
  $('draftSelect').onchange=async e=>{if(e.target.value)try{await loadDraft(e.target.value);}catch(error){toast(error.message,true);}};
  $('newDocumentButton').onclick=async()=>{try{await flushSave();doc=defaultDocument();documentId=null;$('documentTitle').value='未命名作品';syncLayout();renderBlocks();changed();await saveDocument();}catch(error){toast(error.message,true);}};
  $('deleteDraftButton').onclick=async()=>{if(!documentId)return;if(!await confirmAction('删除当前草稿？','已上传的图片和打印记录仍会保留。','删除草稿'))return;try{clearTimeout(saveTimer);await flushSave();await api('/api/documents/'+documentId,{},'DELETE');documentId=null;doc=defaultDocument();$('documentTitle').value='未命名作品';syncLayout();renderBlocks();dirty=true;changed();await refreshDrafts();toast('草稿已删除');}catch(error){toast(error.message,true);}};
  for(const [id,key] of [['paperWidth','paperWidth'],['heightMode','heightMode'],['paperHeight','height'],['paperMargin','margin'],['processing','processing'],['threshold','threshold']])$(id).addEventListener(id==='threshold'?'input':'change',e=>{doc.layout[key]=['paperWidth','heightMode','processing'].includes(key)?e.target.value:Number(e.target.value);syncLayout();changed();});
  $('zoomIn').onclick=()=>{zoom=Math.min(1.6,zoom+.2);updateZoom();};$('zoomOut').onclick=()=>{zoom=Math.max(.6,zoom-.2);updateZoom();};
  $('downloadButton').onclick=downloadPreview;$('printButton').onclick=printDocument;
  for(const id of ['connectionButton','deviceConnectButton'])$(id).onclick=async()=>{if(device.connected&&jobs.some(j=>j.status==='running'&&['print','feed'].includes(j.kind))){toast('打印中，请等待任务完成后断开',true);return;}await deviceAction(device.connected?'disconnect':'connect');};
  $('refreshStatusButton').onclick=()=>deviceAction('refresh');$('refreshHistoryButton').onclick=poll;
  $('feedButton').onclick=()=>{const n=Number($('feedLength').value);if(!Number.isFinite(n)||n<1||n>200){toast('走纸长度应为 1–200 mm',true);return;}deviceAction('feed',{millimeters:n});};
  $('saveSettingsButton').onclick=async()=>{try{settings=await api('/api/settings',readSettings());toast('默认设置已保存');}catch(error){toast(error.message,true);}};
  $('applyDeviceSettingsButton').onclick=async()=>{try{const value=readSettings(),autoOff=Number($('autoOffMinutes').value);await deviceAction('settings',{settings:value,autoOff});}catch(error){toast(error.message,true);}};
  $('autoOffMinutes').onchange=()=>{$('autoOffMinutes').dataset.touched='1';};
  $('closeJobDialog').onclick=()=>$('jobDialog').close();
  window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')poll();});
}
function updateZoom() {$('zoomLabel').textContent=Math.round(zoom*100)+'%';$('previewCanvas').style.width=300*zoom+'px';}
async function init() {
  try {
    const initial=await api('/api/bootstrap');settings=initial.settings;drafts=initial.documents;syncSettings();updateJobs(initial.jobs);updateDevice(initial.device);
    if(drafts.length){const latest=await api('/api/documents/'+drafts[0].id);documentId=latest.id;doc=normalizeDocument(latest.content);$('documentTitle').value=latest.title;$('saveState').textContent='已保存';}
    else {doc=defaultDocument();dirty=true;}
    bindEvents();syncLayout();renderBlocks();await renderPreview();await refreshDrafts();if(dirty)await saveDocument();
    const page=location.hash.slice(1);if(['editor','device','settings','history'].includes(page))setPage(page);booted=true;setInterval(poll,1500);
  }catch(error){toast(error.message,true);$('saveState').textContent='加载失败，请刷新重试';}
}
init();
