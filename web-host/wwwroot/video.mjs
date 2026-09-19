export function parsePacket(buffer, generation) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 37) throw Error('Short video packet');
  const view = new DataView(buffer);
  if (view.getBigUint64(0,true) !== BigInt(generation)) return null;
  const time = view.getBigUint64(8,true);
  const width=view.getUint32(16,true),height=view.getUint32(20,true);
  const key=view.getUint32(24,true),length=view.getUint32(28,true);
  if (!width || !height || width>8192 || height>8192 || width%2 || height%2 ||
      key>1 || length!==buffer.byteLength-32 || time>BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid video packet');
  return {timestamp:Number(time),width,height,key:!!key,data:new Uint8Array(buffer,32)};
}
export function codecFromAnnexB(data) {
  for(let i=0;i+7<data.length;i++) {
    if(data[i]===0&&data[i+1]===0&&data[i+2]===0&&data[i+3]===1&&(data[i+4]&31)===7)
      return 'avc1.'+[data[i+5],data[i+6],data[i+7]].map(n=>n.toString(16).padStart(2,'0')).join('');
  }
  return null;
}
export class VideoReceiver {
  constructor(canvas, generation, requestKey, failed) {
    this.canvas=canvas;this.generation=generation;this.requestKey=requestKey;this.failed=failed;
    this.waiting=true;this.closed=false;this.configuring=false;this.lastTime=-1;this.lastRequest=-Infinity;
    this.decoder=new VideoDecoder({output:frame=>{
      try { if(!this.closed) this.canvas.getContext('2d').drawImage(frame,0,0,this.canvas.width,this.canvas.height); }
      finally { frame.close(); }
    },error:()=>{if(!this.closed)this.failed('影片解碼失敗，請重新開始。');}});
  }
  recover() {
    if(this.closed)return;
    this.waiting=true;
    if(this.decoder.state==='configured')this.decoder.reset();
    const now=performance.now();
    if(now-this.lastRequest>500){this.lastRequest=now;this.requestKey();}
  }
  async receive(buffer) {
    if(this.closed)return;
    try {
      const frame=parsePacket(buffer,this.generation);if(!frame)return;
      if(frame.timestamp<=this.lastTime)throw Error('Nonmonotonic video time');
      this.lastTime=frame.timestamp;
      if(this.configuring){this.droppedDuringConfigure=true;return;}
      if(this.decoder.decodeQueueSize>3)this.recover();
      if(this.waiting&&!frame.key){this.recover();return;}
      if(this.waiting) {
        const codec=codecFromAnnexB(frame.data);if(!codec)throw Error('Missing SPS');
        const config={codec,codedWidth:frame.width,codedHeight:frame.height,optimizeForLatency:true};
        this.configuring=true;
        this.droppedDuringConfigure=false;
        let supported;
        try { supported=await VideoDecoder.isConfigSupported(config); }
        finally { this.configuring=false; }
        if(this.closed)return;
        if(!supported.supported)throw Error('Unsupported H264 configuration');
        this.decoder.configure(config);this.waiting=false;
        this.canvas.width=frame.width;this.canvas.height=frame.height;
        if(this.droppedDuringConfigure){this.recover();return;}
      }
      this.decoder.decode(new EncodedVideoChunk({type:frame.key?'key':'delta',timestamp:frame.timestamp,data:frame.data}));
    } catch(error) { if(!this.closed)this.failed(`影片無法播放：${error.message}`); }
  }
  close(){this.closed=true;if(this.decoder.state!=='closed')this.decoder.close();}
}
