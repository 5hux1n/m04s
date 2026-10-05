const {app,BrowserWindow,dialog,shell}=require('electron');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const devRoot=path.resolve(__dirname,'..');
// Portable app: runtime data stays alongside the app or in an explicit workspace.
const appFolder=app.isPackaged?(process.platform==='darwin'?path.resolve(path.dirname(process.execPath),'../../..'):path.dirname(process.execPath)):devRoot;
const workspace=process.env.M04_WORKSPACE||path.join(appFolder,app.isPackaged?'M04S-workspace':'storage/desktop');
try{fs.mkdirSync(workspace,{recursive:true});app.setPath('userData',path.join(workspace,'browser'));app.setPath('sessionData',path.join(workspace,'browser'));app.setAppLogsPath(path.join(workspace,'logs'));}
catch(error){console.error('请将 App 放在可写入的工作区目录，或设置 M04_WORKSPACE：'+error.message);app.exit(1);}
let window,server;
if(!app.requestSingleInstanceLock())app.quit();
else app.on('second-instance',()=>{window?.show();window?.focus();});
app.whenReady().then(async()=>{
  const root=path.join(app.getAppPath(),'web/dist');
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.txt':'text/plain','.wasm':'application/wasm','.bcmap':'application/octet-stream'};
  server=http.createServer((req,res)=>{
    let location;try{location=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
    const file=path.resolve(root,'.'+(location==='/'?'/index.html':location));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.setHeader('X-Content-Type-Options','nosniff');fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(18765,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  // A stable localhost origin preserves IndexedDB across app launches.
  window=new BrowserWindow({width:1440,height:960,minWidth:760,minHeight:600,title:'M04S Studio',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'persist:m04s'}});
  const session=window.webContents.session;
  const exportsDir=path.join(workspace,'exports');fs.mkdirSync(exportsDir,{recursive:true});
  session.on('will-download',(_event,item)=>item.setSaveDialogOptions({defaultPath:path.join(exportsDir,path.basename(item.getFilename()))}));
  session.setPermissionCheckHandler((contents,permission,requestingOrigin)=>contents===window?.webContents&&requestingOrigin===origin&&permission==='bluetooth');
  session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window?.webContents&&details.requestingUrl?.startsWith(origin+'/')&&permission==='bluetooth'));
  session.setDevicePermissionHandler(details=>details.deviceType==='bluetooth'&&details.origin===origin&&details.device?.deviceName==='M04S');
  let choosing=false;
  window.webContents.on('select-bluetooth-device',async(event,devices,callback)=>{
    event.preventDefault();if(choosing)return;
    const list=devices.filter(d=>d.deviceName==='M04S');if(!list.length)return;
    choosing=true;try{const result=await dialog.showMessageBox(window,{type:'question',title:'选择 M04S',message:'连接哪台 M04S？',detail:'请确认手机 App 已断开打印机。',buttons:[...list.map(d=>`${d.deviceName} · ${d.deviceId}`),'取消'],cancelId:list.length,noLink:true});callback(list[result.response]?.deviceId||'');}finally{choosing=false;}
  });
  window.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith('https://'))shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(origin+'/'))event.preventDefault();});
  await window.loadURL(origin);
  if(process.env.M04_DESKTOP_SMOKE==='1'){
    const result=await window.webContents.executeJavaScript('new Promise(resolve=>setTimeout(()=>resolve({title:document.title,bluetooth:!!navigator.bluetooth,platform:!!window.WebPlatform,canvas:document.getElementById("previewCanvas").width}),2000))');
    fs.writeFileSync(path.join(workspace,'smoke.json'),JSON.stringify(result));app.quit();
  }
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>server?.close());
