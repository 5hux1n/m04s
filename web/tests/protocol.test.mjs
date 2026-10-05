import test from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {lzo1xDecompress} from 'lzo1x';
import {buildTask,taskForSerial,packRGBA,CreditWindow,Replies,commands,decodeStatus} from '../src/protocol.mjs';
import {pageNumbers} from '../src/page-ranges.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const folder=root+'artifacts/web-tests';mkdirSync(folder,{recursive:true});
function decode(data){const view=new DataView(data.buffer,data.byteOffset,data.length),width=view.getUint16(4,true)*8,height=view.getUint16(6,true);let offset=8,raw=[];while(offset<data.length-9){const length=view.getUint16(offset,true);assert.equal(data[offset+2],0);raw.push(...lzo1xDecompress(data.subarray(offset+3,offset+3+length)));offset+=length+3;}return {width,height,raw:Uint8Array.from(raw)};}
test('LZO interop with native library, official samples, and multi-block raster',()=>{
  const cases=[];
  for(const [width,height] of [[568,154],[848,150],[1248,2126],[592,540]]){
    const raw=new Uint8Array(width*height/8);let seed=77;
    for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[i]=i%17===0?seed>>>24:(i>>9)%3?0:255;}
    const task=buildTask(raw,width,height);assert.deepEqual(decode(task.data).raw,raw);
    const file=`${folder}/${width}.bin`;writeFileSync(file,task.data);writeFileSync(file+'.raw',raw);cases.push(file);
  }
  for(const sample of ['m04_printtask_1.bin','m04_last_printtask.bin']){
    const decoded=decode(new Uint8Array(readFileSync(root+'samples/'+sample)));const task=buildTask(decoded.raw,decoded.width,decoded.height);assert.deepEqual(decode(task.data).raw,decoded.raw);
  }
  const python=process.env.M04_PYTHON||(existsSync(root+'logs/publish-venv/bin/python')?root+'logs/publish-venv/bin/python':'python3');
  const script='from pathlib import Path\nfrom m04s_codec import MiniLZO\nimport sys\nc=MiniLZO(max_width=1256)\nfor f in sys.argv[1:]:\n p=Path(f);t=c.parse(p.read_bytes());assert t.raw==Path(f+".raw").read_bytes()\nprint("Native LZO accepted every browser-generated task")';
  const result=spawnSync(python,['-c',script,...cases],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr||String(result.error));
});
test('serial branch encoding and exact non-byte-aligned SDK paper padding',()=>{
  const raw=new Uint8Array(71);raw[0]=0x80;raw[70]=1;
  const q016=taskForSerial(raw,568,1,'Q01612345678901');assert.equal(q016.width,592);const decoded=decode(q016.data).raw;assert.equal(decoded[0],2);assert.equal(decoded[71],4);assert.equal(decoded[73],0);
  const q171=taskForSerial(raw,568,1,'Q17112345678901');assert.equal(q171.encoding,'raw');assert.equal(q171.data[8],2);
  assert.equal(taskForSerial(new Uint8Array(156),1248,1,'Q01612345678901').width,1256);
  assert.equal(taskForSerial(new Uint8Array(74),592,1,'Q01612345678901').width,592);
  assert.throws(()=>taskForSerial(raw,568,1,''));
});
test('pixel order, transparency and dimensions',()=>{
  const data=new Uint8ClampedArray(32).fill(255);data.set([0,0,0,255]);data.set([0,0,0,0],4);assert.equal(packRGBA(data,8,1)[0],128);assert.throws(()=>buildTask(new Uint8Array(1),9,1));
});
test('credit bounded and packet size capped',()=>{
  const c=new CreditWindow();c.notify([1,7]);assert.equal(c.configured,false);c.notify([2,244,0]);assert.equal(c.packetSize,182);assert.equal(c.configured,true);for(let i=0;i<7;i++)c.reserve();assert.throws(()=>c.reserve());c.notify([1,8]);assert.equal(c.available,7);
});
test('fragmented status and completion frames, serial validation',()=>{
  const frames=[],r=new Replies(frame=>frames.push(frame));r.notify([99,26]);r.notify([15,12,26,8,...new TextEncoder().encode('Q01612345678901').subarray(0,7)]);assert.equal(frames.length,1);r.notify(new TextEncoder().encode('Q01612345678901').subarray(7));assert.equal(frames.length,2);assert.equal(decodeStatus(frames[1]).serial_number,'Q01612345678901');assert.deepEqual(decodeStatus([26,5,153]),{open:true});
});
test('commands match verified density settings; PDF ranges fail closed',()=>{
  assert.deepEqual(Array.from(commands({density:'special'})[1]),[31,17,55,150]);assert.throws(()=>commands({copies:0}));assert.throws(()=>commands({speed:256}));assert.deepEqual(pageNumbers('1-3,2,5',5),[1,2,3,5]);for(const s of ['0','2-1','x','9'])assert.throws(()=>pageNumbers(s,5));
});
