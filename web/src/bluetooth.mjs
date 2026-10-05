import {UUID,QUERIES,PAPER,commands,CreditWindow,Replies,decodeStatus} from './protocol.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class M04BrowserPrinter {
  constructor(log=()=>{}){this.log=log;this.waiters=new Set();this.values={};this.pending=new Map();this.busy=false;this.fault=null;this.completion=null;}
  get connected(){return !!this.device?.gatt?.connected && !this.fault;}
  chooseDevice(){
    if(!globalThis.navigator?.bluetooth)throw Error('当前浏览器无法连接蓝牙；请使用 Mac／Windows／Android 的 Chrome，或桌面 App。iPhone 可编辑并导出图片。');
    return navigator.bluetooth.requestDevice({filters:[{name:'M04S'}],optionalServices:[UUID(0xff00)]});
  }
  wake(){for(const fn of [...this.waiters])fn();}
  waitFor(predicate,timeout=20000){
    return new Promise((resolve,reject)=>{
      const finish=(error)=>{clearTimeout(timer);this.waiters.delete(check);error?reject(error):resolve();};
      const check=()=>{if(this.fault)finish(Error(this.fault));else if(predicate())finish();};
      const timer=setTimeout(()=>finish(Error('等待打印机响应超时')),timeout);
      this.waiters.add(check);check();
    });
  }
  async connect(selection){
    if(this.device?.gatt?.connected)this.device.gatt.disconnect();
    this.device=await selection;this.fault=null;this.values={};this.credit=new CreditWindow();this.pending.clear();this.completion=null;
    this.disconnectHandler=()=>{this.fault='打印机已断开；未确认完成的任务不会自动重发';this.values={};this.log('disconnected');this.wake();};
    this.device.addEventListener('gattserverdisconnected',this.disconnectHandler);
    try {
      const server=await this.device.gatt.connect();const service=await server.getPrimaryService(UUID(0xff00));
      this.writeChar=await service.getCharacteristic(UUID(0xff02));
      if(!this.writeChar.properties.writeWithoutResponse)throw Error('打印机 FF02 不支持无回应写入');
      this.statusChar=await service.getCharacteristic(UUID(0xff01));this.creditChar=await service.getCharacteristic(UUID(0xff03));
      this.replies=new Replies(frame=>this.onFrame(frame));
      this.onStatus=e=>this.replies.notify(new Uint8Array(e.target.value.buffer,e.target.value.byteOffset,e.target.value.byteLength));
      this.onCredit=e=>{const v=e.target.value;this.credit.notify(new Uint8Array(v.buffer,v.byteOffset,v.byteLength));this.wake();};
      this.statusChar.addEventListener('characteristicvaluechanged',this.onStatus);this.creditChar.addEventListener('characteristicvaluechanged',this.onCredit);
      await this.statusChar.startNotifications();await this.creditChar.startNotifications();
      await this.waitFor(()=>this.credit.configured);
      // 20 bytes also works when the browser does not expose negotiated MTU.
      this.packetSize=Math.min(20,this.credit.packetSize);
      await this.exclusive(()=>this.readStatus(['serial_number']));
      if(!this.values.serial_number?.serial_number)throw Error('设备未返回序列号，无法确认打印编码');
      this.log('connected',{name:this.device.name,packetSize:this.packetSize});return this;
    }catch(error){this.disconnect();throw error;}
  }
  disconnect(){
    if(this.device){this.device.removeEventListener('gattserverdisconnected',this.disconnectHandler);this.device.gatt?.disconnect();}
    this.statusChar?.removeEventListener('characteristicvaluechanged',this.onStatus);this.creditChar?.removeEventListener('characteristicvaluechanged',this.onCredit);
    this.fault='打印机已断开';this.values={};this.wake();
  }
  onFrame(frame){
    this.log('ff01',{raw:Array.from(frame).map(x=>x.toString(16).padStart(2,'0')).join(' ')});
    if(frame[1]===15&&frame[2]===12&&this.completion){
      if(this.completion.sent<this.completion.expected){this.completion.error='图片尚未发完就收到完成通知，可能已截断';}
      else this.completion.finished=true;
    }else if(frame[1]!==15){
      const name=Object.keys(QUERIES).find(k=>QUERIES[k][1]===frame[1]);
      if(name){this.values[name]=decodeStatus(frame);if(this.pending.has(frame[1]))this.pending.set(frame[1],true);}
    }
    this.wake();
  }
  async exclusive(fn){if(this.busy)throw Error('请等待当前设备操作完成');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  async write(data,raster=false){
    await this.waitFor(()=>this.credit.available>0);if(!this.connected)throw Error('请先连接打印机');
    this.credit.reserve();if(raster)this.completion.sent+=data.length;
    try{await this.writeChar.writeValueWithoutResponse(data);}catch(error){this.fault='蓝牙发送失败：'+error.message;this.wake();throw error;}
  }
  async readStatus(names=Object.keys(QUERIES).filter(k=>k!=='serial_number')){
    for(const name of names){const [request,response]=QUERIES[name];this.pending.set(response,false);
      try{await this.write(Uint8Array.from([31,17,request]));await this.waitFor(()=>this.pending.get(response),3000);}
      catch(error){if(this.fault)throw error;this.values[name]={available:false,reason:'response_timeout'};}
      finally{this.pending.delete(response);}
    }
    await this.waitFor(()=>this.credit.available===this.credit.capacity);return structuredClone(this.values);
  }
  status(){return this.exclusive(()=>this.readStatus());}
  async configure(input,autoOff){return this.exclusive(async()=>{
    if(autoOff!==undefined&&(!Number.isInteger(autoOff)||autoOff<0||autoOff>1275||autoOff%5))throw Error('自动关机时间需为 5 分钟的整数倍');
    for(const c of commands(input))await this.write(c);
    if(autoOff!==undefined){await this.write(Uint8Array.from([27,78,7,autoOff/5]));}
    await this.waitFor(()=>this.credit.available===this.credit.capacity);
    const values=await this.readStatus();
    if(autoOff!==undefined&&values.auto_off?.minutes!==autoOff)throw Error('自动关机时间回读不一致');
    if(input.paper&&values.paper_mode?.mode!==input.paper)throw Error('纸张模式回读不一致');
    return values;
  });}
  print(task,input,onProgress=()=>{}){return this.exclusive(async()=>{
    if(!this.connected)throw Error('请先连接打印机');
    for(const c of commands(input))await this.write(c);await pause(15);
    this.completion={expected:task.data.length,sent:0,finished:false,error:null};
    try {
      for(let offset=0;offset<task.data.length;offset+=this.packetSize){
        await this.write(task.data.subarray(offset,offset+this.packetSize),true);
        if(this.completion.error)throw Error(this.completion.error);
        onProgress(Math.min(1,(offset+this.packetSize)/task.data.length),'正在传输');
      }
      await this.waitFor(()=>this.credit.available===this.credit.capacity);
      onProgress(1,'等待打印机完成');
      await this.waitFor(()=>this.completion.finished||this.completion.error,Math.max(120000,task.height/300*25.4/5*1000+30000));
      if(this.completion.error)throw Error(this.completion.error);
      await pause(1000);
      // A valid completion remains valid even if the idle connection then closes.
      return {completion:'ff01_1a0f0c',height:task.height,bytes:task.data.length,encoding:task.encoding};
    }catch(error){if(!this.completion?.finished)this.disconnect();throw error;}finally{this.completion=null;}
  });}
}
