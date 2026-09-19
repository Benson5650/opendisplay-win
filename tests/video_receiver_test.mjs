import assert from 'node:assert/strict';
import {VideoReceiver} from '../web-host/wwwroot/video.mjs';
let supported=true, deferred=null, latest;
globalThis.EncodedVideoChunk=class{constructor(v){Object.assign(this,v);}};
globalThis.VideoDecoder=class {
  constructor(callbacks){this.callbacks=callbacks;this.state='unconfigured';this.decodeQueueSize=0;this.decoded=[];latest=this;}
  static async isConfigSupported(){return deferred?await deferred:{supported};}
  configure(){this.state='configured';}
  reset(){this.state='unconfigured';this.decodeQueueSize=0;}
  close(){this.state='closed';}
  decode(frame){this.decoded.push(frame);}
};
function packet(time,key=true,generation=7){
  const buffer=new ArrayBuffer(40),v=new DataView(buffer);
  v.setBigUint64(0,BigInt(generation),true);v.setBigUint64(8,BigInt(time),true);
  v.setUint32(16,1920,true);v.setUint32(20,1080,true);v.setUint32(24,key?1:0,true);v.setUint32(28,8,true);
  new Uint8Array(buffer,32).set([0,0,0,1,key?0x67:0x41,0x64,0,0x28]);return buffer;
}
let errors=[],requests=0,draws=0,closedFrames=0;
const canvas={width:0,height:0,getContext:()=>({drawImage:()=>draws++})};
const make=()=>new VideoReceiver(canvas,7,()=>requests++,e=>errors.push(e));
let receiver=make();
await receiver.receive(packet(1,false));assert.equal(latest.decoded.length,0);
await receiver.receive(packet(2));assert.equal(latest.decoded.length,1);assert.equal(canvas.width,1920);
latest.callbacks.output({close:()=>closedFrames++});assert.equal(draws,1);assert.equal(closedFrames,1);
await receiver.receive(packet(3,false));assert.equal(latest.decoded.length,2);
latest.decodeQueueSize=4;await receiver.receive(packet(4,false));assert.equal(requests,1);assert.equal(latest.decoded.length,2);
await receiver.receive(packet(5));assert.equal(latest.decoded.length,3);
await receiver.receive(packet(6,true,8));assert.equal(latest.decoded.length,3);
receiver.close();latest.callbacks.output({close:()=>closedFrames++});assert.equal(draws,1);assert.equal(closedFrames,2);
let finish;
deferred=new Promise(resolve=>finish=resolve);receiver=make();
const initializing=receiver.receive(packet(10));
await receiver.receive(packet(11,false));finish({supported:true});await initializing;
assert.equal(latest.decoded.length,0);assert.equal(receiver.waiting,true);
deferred=null;await receiver.receive(packet(12));assert.equal(latest.decoded.length,1);receiver.close();
deferred=new Promise(resolve=>finish=resolve);receiver=make();
const stopping=receiver.receive(packet(20));receiver.close();finish({supported:true});await stopping;
assert.equal(latest.state,'closed');assert.equal(latest.decoded.length,0);
deferred=null;supported=false;receiver=make();await receiver.receive(packet(30));assert.equal(errors.length,1);receiver.close();
supported=true;errors=[];receiver=make();await receiver.receive(packet(40));await receiver.receive(packet(40));assert.equal(errors.length,1);receiver.close();
console.log('Video receiver lifecycle checks passed: IDR gating, backlog, init race, close race, frame release, codec rejection, timestamps');
