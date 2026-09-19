import tls from 'node:tls';
import crypto from 'node:crypto';
// Test-only RFC6455 client; native TLS validates CA and IP SAN normally.
export async function connect(url,headers){
  const u=new URL(url),key=crypto.randomBytes(16).toString('base64');
  const socket=tls.connect({host:u.hostname,port:Number(u.port)});
  let buffer=Buffer.alloc(0),upgraded=false, messages=[], waiter;
  let resolveOpen,rejectOpen;
  const ready=new Promise((r,j)=>{resolveOpen=r;rejectOpen=j;});
  function dispatch(m){messages.push(m);waiter?.();}
  socket.on('secureConnect',()=>socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`));
  socket.on('error',rejectOpen);
  socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(!upgraded){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
      const response=buffer.subarray(0,end).toString();
      if(!response.startsWith('HTTP/1.1 101')){rejectOpen(Error('WebSocket handshake rejected'));socket.destroy();return;}
      const expected=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if(!response.includes(expected)){rejectOpen(Error('Invalid accept'));socket.destroy();return;}
      buffer=buffer.subarray(end+4);upgraded=true;resolveOpen();
    }
    while(buffer.length>=2){let n=buffer[1]&127,offset=2;if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);offset=4;}
      else if(n===127){if(buffer.length<10)return;const big=buffer.readBigUInt64BE(2);if(big>9000000n){socket.destroy();return;}n=Number(big);offset=10;}if(buffer.length<offset+n)return;
      const opcode=buffer[0]&15,payload=buffer.subarray(offset,offset+n);buffer=buffer.subarray(offset+n);
      if(opcode===1)dispatch(JSON.parse(payload.toString()));
      if(opcode===2)dispatch({type:'binary',data:Buffer.from(payload)});
    }
  });
  await ready;
  return {send(m){const bytes=Buffer.from(JSON.stringify(m)),mask=crypto.randomBytes(4),head=Buffer.alloc(bytes.length<126?2:4);
    head[0]=0x81;if(bytes.length<126)head[1]=0x80|bytes.length;else{head[1]=0xfe;head.writeUInt16BE(bytes.length,2);}
    const data=Buffer.from(bytes);for(let i=0;i<data.length;i++)data[i]^=mask[i%4];socket.write(Buffer.concat([head,mask,data]));},
    next(predicate){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{waiter=undefined;reject(Error('WebSocket message timeout'));},5000);
      waiter=()=>{const i=messages.findIndex(predicate);if(i>=0){clearTimeout(timeout);waiter=undefined;resolve(messages.splice(i,1)[0]);}};waiter();});},
    close(){socket.destroy();}};
}
