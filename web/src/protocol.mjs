import {lzo1xCompress, lzo1xDecompress} from 'lzo1x';
export const UUID = n => `0000${n.toString(16).padStart(4,'0')}-0000-1000-8000-00805f9b34fb`;
export const QUERIES={battery:[8,4],cover:[18,5],paper:[17,6],temperature:[19,3],auto_off:[14,9],paper_mode:[25,12],serial_number:[9,8]};
export const PAPER={continuous:[31,17,11],gap:[31,17,10],'black-mark':[31,17,38]};
export const DENSITY={light:[1,100],medium:[2,100],dark:[4,100],special:[4,150]};
export const DEFAULTS={density:'medium',coefficient:null,speed:null,paper:null,copies:1,paperWidth:'53'};
export function settings(input={}) {
  const s={...DEFAULTS,...input};
  if(!Object.hasOwn(DENSITY,s.density) || ![null,...Object.keys(PAPER)].includes(s.paper) || !['53','80','110','legacy'].includes(s.paperWidth))throw Error('打印参数无效');
  if(!Number.isInteger(s.copies)||s.copies<1||s.copies>20)throw Error('份数需为 1–20');
  for(const key of ['coefficient','speed'])if(s[key]!==null&&(!Number.isInteger(s[key])||s[key]<1||s[key]>255))throw Error('协议参数需为 1–255 的整数');
  return s;
}
export function commands(input={}) {
  const s=settings(input), [density,coefficient]=DENSITY[s.density];
  const result=[[31,17,2,density]];
  if(s.paper)result.push(PAPER[s.paper]);
  result.push([31,17,55,s.coefficient??coefficient]);
  if(s.speed!==null)result.push([31,17,35,s.speed]);
  return result.map(x=>Uint8Array.from(x));
}
export function packRGBA(rgba,width,height,threshold=180) {
  if(width%8 || width<8 || width>1248 || height<1 || height>12000 || rgba.length!==width*height*4)throw Error('点阵尺寸无效');
  const raw=new Uint8Array(width*height/8);
  for(let i=0;i<width*height;i++) {
    const p=i*4,a=rgba[p+3]/255;
    const gray=(.299*rgba[p]+.587*rgba[p+1]+.114*rgba[p+2])*a+255*(1-a);
    if(gray<threshold)raw[i>>3]|=1<<(7-(i&7));
  }
  return raw;
}
export function buildTask(raw,width,height,encoding='lzo') {
  if(!(raw instanceof Uint8Array)||!Number.isInteger(width)||width%8||width<8||width>1256||!Number.isInteger(height)||height<1||height>12000||raw.length!==width*height/8)throw Error('点阵尺寸无效');
  if(!['lzo','raw'].includes(encoding))throw Error('点阵编码无效');
  const blocks=[];
  if(encoding==='lzo')for(let i=0;i<raw.length;i+=4096){
    const source=raw.subarray(i,i+4096),compressed=lzo1xCompress(source);
    const restored=lzo1xDecompress(compressed,source.length);
    if(restored.some((v,j)=>v!==source[j]))throw Error('LZO 压缩回读不一致');
    const frame=new Uint8Array(compressed.length+3);new DataView(frame.buffer).setUint16(0,compressed.length,true);frame.set(compressed,3);blocks.push(frame);
  } else blocks.push(raw);
  const tail=Uint8Array.from(encoding==='lzo'?[0,0,0,27,100,2,27,100,2]:[27,100,2,27,100,2]);
  const data=new Uint8Array(8+blocks.reduce((n,b)=>n+b.length,0)+tail.length);
  data.set([29,118,48,0]);const view=new DataView(data.buffer);view.setUint16(4,width/8,true);view.setUint16(6,height,true);
  let offset=8;for(const b of blocks){data.set(b,offset);offset+=b.length;}data.set(tail,offset);
  return {data,width,height,encoding};
}
export function taskForSerial(raw,width,height,serial) {
  if(!serial || !/^[a-z0-9]+$/i.test(serial))throw Error('无法确认设备序列号，停止打印以避免错误编码');
  const prefix=serial.slice(0,4),encoding=['Q171','Q466'].includes(prefix)?'raw':'lzo';
  if(['Q016','Q171'].includes(prefix)&&[568,848,1248].includes(width)) {
    const [left,right]=width===568?[6,18]:width===848?[0,32]:[0,8];
    const wireWidth=width+left+right,wire=new Uint8Array(wireWidth*height/8);
    // Q016 narrow-paper padding starts six pixels from the byte boundary.
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(raw[y*width/8+(x>>3)]&(1<<(7-(x&7)))){
      const position=x+left;wire[y*wireWidth/8+(position>>3)]|=1<<(7-(position&7));
    }
    return buildTask(wire,wireWidth,height,encoding);
  }
  return buildTask(raw,width,height,encoding);
}
export class CreditWindow {
  constructor(){this.capacity=0;this.available=0;this.packetSize=182;this.peerSize=null;}
  notify(data){
    if(data.length===2&&data[0]===1&&data[1]>0){if(!this.capacity){this.capacity=this.available=data[1];}else this.available=Math.min(this.capacity,this.available+data[1]);}
    else if([2,3].includes(data.length)&&data[0]===2&&data[1]>0){this.peerSize=data[1];this.packetSize=Math.min(182,data[1]);}
  }
  get configured(){return !!this.capacity&&this.peerSize!==null;}
  reserve(){if(this.available<1)throw Error('没有可用发送额度');this.available--;}
}
export class Replies {
  constructor(onFrame){this.buffer=[];this.onFrame=onFrame;}
  notify(data){
    this.buffer.push(...data);
    while(this.buffer.length){
      const pos=this.buffer.indexOf(26);if(pos<0){this.buffer=[];return;}this.buffer.splice(0,pos);
      if(this.buffer.length<2)return;const code=this.buffer[1];
      if(![3,4,5,6,8,9,12,15].includes(code)){this.buffer.shift();continue;}
      const size=code===8?17:3;if(this.buffer.length<size)return;
      this.onFrame(Uint8Array.from(this.buffer.splice(0,size)));
    }
  }
}
export function decodeStatus(frame) {
  const [,code,value]=frame;
  if(code===8){const serial=new TextDecoder().decode(frame.subarray(2)).replace(/[\0 ]+$/,'');return /^[a-z0-9]+$/i.test(serial)?{serial_number:serial}:{};}
  if(code===4)return {percent:value<=100?value:null};
  if(code===5)return {open:value===153?true:value===152?false:null};
  if(code===6)return {present:value===137?true:value===136?false:null};
  if(code===3)return {state:value===168?'normal':value===169?'overheated':'unknown'};
  if(code===9)return {minutes:value*5};
  if(code===12)return {mode:{11:'continuous',38:'black-mark',10:'gap'}[value]||'unknown'};
  return {};
}
