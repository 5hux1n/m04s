import {LocalStore} from './storage.mjs';
import {M04BrowserPrinter} from './bluetooth.mjs';
import {DEFAULTS,settings,packRGBA,taskForSerial} from './protocol.mjs';
import {importDocument,importWeb} from './imports.mjs';
const store=new LocalStore();const ready=store.open();
const now=()=>Date.now()/1000;
let active=null,queue=[],processing=false,history=[];
const printer=new M04BrowserPrinter((event,values={})=>{
  if(active){active.events.push({event,...values,created_at:now()});if(active.events.length>200)active.events.shift();}
});
const bluetoothSupported=!!navigator.bluetooth;
const getDevice=()=>({connected:printer.connected,worker_online:bluetoothSupported,phase:printer.connected?'M04S 已连接':bluetoothSupported?'请选择自己的打印机':'此浏览器支持编辑和导出，请用 Chrome 或桌面 App 连接打印机',values:printer.connected?printer.values:{},updated_at:now()});
function checkFile(file){if(!(file instanceof Blob)||file.size>10*1024*1024)throw Error('文件最大 10 MB');}
async function saveAsset(blob){checkFile(blob);const id=crypto.randomUUID();await store.set('asset:'+id,blob);await store.url(id);return id;}
async function saveHistory(){await store.set('jobs',history.slice(0,100));}
async function docs(){return (await store.entries()).filter(([k])=>k.startsWith('doc:')).map(([,v])=>v).sort((a,b)=>b.updated_at-a.updated_at);}
async function taskFromPNG(png,width){
  if(![568,848,1248,592].includes(width)||typeof png!=='string'||!png.startsWith('data:image/png;base64,')||png.length>17000000)throw Error('打印预览无效');
  const image=await createImageBitmap(await (await fetch(png)).blob());
  try{
    if(image.width!==width||image.height<1||image.height>12000)throw Error('预览点阵尺寸无效');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=image.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const raw=packRGBA(context.getImageData(0,0,width,image.height).data,width,image.height);
    return taskForSerial(raw,width,image.height,printer.values.serial_number?.serial_number);
  }finally{image.close();}
}
function enqueue(kind,title,payload,run){
  if(queue.length>=20)throw Error('待处理任务过多');
  const job={id:crypto.randomUUID(),kind,title,created_at:now(),status:'queued',phase:'等待处理',progress:0,copies:payload.settings?.copies||1,events:[],preview:payload.png||null};
  history.unshift(job);history=history.slice(0,100);queue.push({job,run});saveHistory().catch(console.error);queueMicrotask(drain);return structuredClone(job);
}
async function drain(){
  if(processing)return;processing=true;
  try{while(queue.length){const {job,run}=queue.shift();if(job.status==='cancelled')continue;
    active=job;job.status='running';job.phase='正在处理';await saveHistory();
    try{job.result=await run(job);job.status='completed';job.phase='已完成';job.progress=1;}
    catch(error){job.status='failed';job.error=error.message;job.phase='失败';}
    finally{job.finished_at=now();active=null;await saveHistory();}
  }}finally{processing=false;}
}
async function request(path,data,method){
  // requestDevice must run in the original click event, before IndexedDB awaits.
  const selection=path==='/api/device'&&data?.action==='connect'?printer.chooseDevice():null;
  if(selection)selection.catch(()=>{});
  await ready;
  if(path==='/api/bootstrap'){
    history=await store.get('jobs',[]);
    for(const job of history)if(['queued','running'].includes(job.status)){job.status='failed';job.error='页面上次关闭时尚未确认完成，请检查纸面；不会自动重发';}
    await saveHistory();return {settings:await store.get('settings',DEFAULTS),device:getDevice(),jobs:history,documents:await docs()};
  }
  if(path==='/api/state')return {device:getDevice(),jobs:structuredClone(history)};
  if(path==='/api/settings'){const value=settings(data);await store.set('settings',value);return value;}
  if(path==='/api/documents'&&method==='GET')return docs();
  if(path.startsWith('/api/documents')){
    const id=path.split('/')[3]||crypto.randomUUID(),key='doc:'+id;
    if(method==='DELETE'){await store.delete(key);return {deleted:true};}
    if(method==='GET'){const doc=await store.get(key);if(!doc)throw Error('草稿不存在');return doc;}
    if(!data?.content||!Array.isArray(data.content.blocks)||data.content.blocks.length>100)throw Error('草稿内容无效');
    return store.set(key,{id,title:String(data.title||'未命名作品').slice(0,100),content:structuredClone(data.content),updated_at:now()});
  }
  if(path==='/api/uploads'){const file=data.get('image');checkFile(file);const bitmap=await createImageBitmap(file);
    try{if(bitmap.width*bitmap.height>16000000)throw Error('图片过大，请缩小到 1600 万像素以内');const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));return {id:await saveAsset(blob)};}finally{bitmap.close();}
  }
  if(path==='/api/import/document'){const file=data.get('document');checkFile(file);return importDocument(file,data.get('pages')||'',saveAsset);}
  if(path==='/api/import/web')return importWeb(data.url);
  if(path==='/api/device'){
    const action=data.action;if(!['connect','disconnect','refresh','feed','settings'].includes(action))throw Error('设备操作无效');
    if(action==='disconnect'&&active)throw Error('请等待设备操作完成后断开');
    return enqueue(action,{connect:'连接打印机',disconnect:'断开连接',refresh:'刷新状态',feed:'空白走纸',settings:'应用设置'}[action],data,async job=>{
      if(action==='connect'){await printer.connect(selection);await printer.status();return {connected:true};}
      if(action==='disconnect'){printer.disconnect();return {connected:false};}
      if(action==='refresh')return printer.status();
      if(action==='settings')return printer.configure(settings(data.settings),data.autoOff);
      const mm=data.millimeters;if(!Number.isFinite(mm)||mm<1||mm>200)throw Error('走纸长度需为 1–200 mm');
      const height=Math.round(mm*300/25.4),task=taskForSerial(new Uint8Array(74*height),592,height,printer.values.serial_number?.serial_number);
      return printer.print(task,await store.get('settings',DEFAULTS),(n,phase)=>{job.progress=n;job.phase=phase;});
    });
  }
  if(path==='/api/print'){
    if(!printer.connected)throw Error('请先连接自己的打印机');const value=settings(data.settings);
    // Freeze all task inputs before accepting the queue entry.
    const task=await taskFromPNG(data.png,data.widthDots);
    return enqueue('print',String(data.title||'未命名作品'),{settings:value,png:data.png},async job=>{
      const results=[];for(let copy=0;copy<value.copies;copy++){job.phase=`第 ${copy+1}/${value.copies} 份`;results.push(await printer.print(task,value,(n,phase)=>{job.progress=(copy+n)/value.copies;job.phase=`第 ${copy+1}/${value.copies} 份 · ${phase}`;}));}
      return {jobs:results};
    });
  }
  const match=path.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
  if(match){const job=history.find(j=>j.id===match[1]);if(!job)throw Error('任务不存在');if(match[2]){if(job.status!=='queued')throw Error('只能取消尚未开始的任务');job.status='cancelled';await saveHistory();return job;}return {events:job.events||[]};}
  throw Error('不支持的操作');
}
window.WebPlatform={request,assetURL:async id=>{await ready;return store.url(id);},supported:bluetoothSupported};
window.addEventListener('pagehide',()=>printer.disconnect());
// Editing remains available on browsers without Bluetooth.
const notice=document.createElement('p');notice.className='notice';notice.textContent=bluetoothSupported?'作品保存在此设备的浏览器中。打印时请保持页面打开；浏览器驱动尚待真机验证。':'当前浏览器可编辑和导出作品。蓝牙打印请使用 Chrome（Mac／Windows／Android）或桌面 App；iPhone 普通浏览器暂不支持。';document.querySelector('.page-heading')?.after(notice);
