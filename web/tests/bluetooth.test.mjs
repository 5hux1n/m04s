import test from 'node:test';
import assert from 'node:assert/strict';
import {M04BrowserPrinter} from '../src/bluetooth.mjs';
import {buildTask} from '../src/protocol.mjs';
function transport(){
  const driver=new M04BrowserPrinter(),device=new EventTarget();device.gatt={connected:true,disconnect:()=>{device.gatt.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));}};
  driver.device=device;driver.fault=null;driver.credit={capacity:2,available:2,reserve(){if(this.available<1)throw Error('no credit');this.available--;}};driver.packetSize=20;
  const packets=[];driver.writeChar={async writeValueWithoutResponse(packet){packets.push(packet.slice());queueMicrotask(()=>{driver.credit.available=Math.min(2,driver.credit.available+1);driver.wake();});}};
  driver.disconnectHandler=()=>{driver.fault='断开';driver.wake();};device.addEventListener('gattserverdisconnected',driver.disconnectHandler);
  return {driver,packets};
}
const task=()=>buildTask(new Uint8Array(74*50).fill(91),592,50);
test('credit recovery alone never marks a print completed; FF01 completion is required',async()=>{
  const {driver}=transport();let done=false,waiting;
  const arrived=new Promise(resolve=>waiting=resolve);
  const pending=driver.print(task(),{},(_n,phase)=>{if(phase==='等待打印机完成')waiting();}).then(value=>{done=true;return value;});
  await arrived;assert.equal(done,false);assert.equal(driver.credit.available,2);
  driver.onFrame(Uint8Array.from([26,15,12]));assert.equal((await pending).completion,'ff01_1a0f0c');
});
test('early completion fails and disconnects the transport',async()=>{
  const {driver,packets}=transport();const original=driver.writeChar.writeValueWithoutResponse;
  driver.writeChar.writeValueWithoutResponse=async packet=>{await original(packet);if(packet[0]===29)driver.onFrame(Uint8Array.from([26,15,12]));};
  await assert.rejects(driver.print(task(),{}),/尚未发完/);assert.equal(driver.connected,false);assert.ok(packets.length<10);
});
test('disconnect wakes credit waiters and overlapping jobs are rejected',async()=>{
  const {driver}=transport();driver.credit.available=0;const pending=driver.print(task(),{});await Promise.resolve();await assert.rejects(driver.status(),/等待/);driver.device.gatt.disconnect();await assert.rejects(pending,/断开/);assert.equal(driver.waiters.size,0);
});
test('invalid auto-off is rejected before a device write',async()=>{
  const {driver,packets}=transport();await assert.rejects(driver.configure({},7),/5 分钟/);assert.equal(packets.length,0);
});
