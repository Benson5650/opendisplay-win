import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

// NODE_EXTRA_CA_CERTS must point at the generated CA PEM. TLS verification stays ON.
const root=resolve(import.meta.dirname,'..');
const origin='https://127.0.0.1:19443';
const host=spawn('dotnet',[resolve(root,'web-host/bin/Release/net10.0-windows/OpenDisplay.Web.dll'),
  '--ip','127.0.0.1','--port','19443','--cert',resolve(root,'host-data-test/host.pfx'),'--dry-run','true'],
  {cwd:resolve(root,'web-host'),stdio:['pipe','pipe','pipe']});
let log='',errors='',checks=0;
host.stdout.on('data',d=>log+=d.toString());host.stderr.on('data',d=>errors+=d.toString());
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function check(value,label){assert.ok(value,label);checks++;console.log('PASS',label);}
async function waitFor(test,label){for(let i=0;i<100;i++){if(test())return;await delay(50);}throw Error(label);}
const post=(path,value,headers={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
let ws, video, keepalive;
try {
  await waitFor(()=>/Pairing code: ([A-F0-9]+)/.test(log),'host startup');
  const code=log.match(/Pairing code: ([A-F0-9]+)/)[1];
  let r;
  for(let i=0;i<100;i++){try{r=await fetch(origin);break;}catch{await delay(50);}}
  check(r?.status===200,'trusted TLS and static shell');
  check((await r.text()).includes('Pen Tablet'),'page content');
  check((await fetch(origin+'/displays')).status===401,'display enumeration requires auth');
  check((await post('/pair',{code},{Origin:'https://evil.example'})).status===403,'foreign origin rejected');
  r=await post('/pair',{code}); check(r.status===200,'pair request');
  const {ticket}=await r.json();
  check(!(await (await post('/pair/status',{ticket})).json()).ready,'local approval required');
  host.stdin.write('approve\n');await waitFor(()=>log.includes('device approved'),'approval');
  r=await post('/pair/status',{ticket}); check((await r.json()).ready,'pair approved');
  const cookie=r.headers.get('set-cookie');
  check(cookie.includes('httponly')&&cookie.includes('secure')&&cookie.includes('samesite=strict'),'cookie flags');
  const authCookie=cookie.split(';')[0];
  check((await post('/pair/status',{ticket})).status===401,'ticket single use');
  r=await fetch(origin+'/displays',{headers:{Cookie:authCookie}});
  const displays=await r.json();check(displays.length>0&&displays[0].id,'native display bridge');
  // Node's WebSocket has no header option; use a tiny standards-based TLS client
  // below for authenticated WebSocket frames, still verifying the test CA.
  const {connect}=await import('./ws_client.mjs');
  await assert.rejects(connect(origin.replace('https','wss')+'/control',{Origin:origin}));checks++;
  await assert.rejects(connect(origin.replace('https','wss')+'/control',{Origin:'https://evil.example',Cookie:authCookie}));checks++;
  ws=await connect(origin.replace('https','wss')+'/control',{Origin:origin,Cookie:authCookie});
  const hello=await ws.next(m=>m.type==='hello');check(hello.dryRun,'no desktop injection');
  await assert.rejects(connect(origin.replace('https','wss')+'/control',{Origin:origin,Cookie:authCookie}));checks++;
  ws.send({type:'start',target:'',width:1000,height:750,mapping:'preserve'});
  check((await ws.next(m=>m.type==='started')).generation===0,'target mandatory');
  ws.send({type:'start',target:displays[0].id,width:1000,height:750,mapping:'preserve'});
  let started=await ws.next(m=>m.type==='started');check(started.generation>0,'session start');
  let event={type:'pen',generation:started.generation,sequence:1,phase:0,x:500,y:375,pressure:.5,azimuth:0,altitude:1};
  ws.send(event);check((await ws.next(m=>m.type==='sample')).accepted===1,'sample reaches native core');
  ws.send(event);check((await ws.next(m=>m.type==='sample')).accepted===0,'duplicate rejected');
  await ws.next(m=>m.type==='state'&&m.state===4);checks++;
  ws.send({...event,sequence:2});check((await ws.next(m=>m.type==='sample')).accepted===0,'timeout rejects sample');
  ws.send({type:'start',target:displays[0].id,width:1000,height:750,mapping:'stretch'});
  const restarted=await ws.next(m=>m.type==='started');check(restarted.generation!==started.generation,'restart rotates generation');
  ws.send({...event,sequence:3});check((await ws.next(m=>m.type==='sample')).accepted===0,'old mapping rejected');
  ws.send({type:'touch',generation:restarted.generation,sequence:4,phase:0,x:500,y:375});
  check((await ws.next(m=>m.type==='sample')).accepted===0,'touch disabled by default');
  ws.send({type:'start',touch:true,target:displays[0].id,width:1000,height:750,mapping:'stretch'});
  const touchSession=await ws.next(m=>m.type==='started');
  await delay(750);
  ws.send({type:'touch',generation:touchSession.generation,sequence:1,phase:0,x:500,y:375});
  check((await ws.next(m=>m.type==='sample')).accepted===1,'enabled touch accepted');
  ws.send({...event,generation:touchSession.generation,sequence:2});
  check((await ws.next(m=>m.type==='sample')).accepted===1,'pen takes over touch');
  ws.send({type:'touch',generation:touchSession.generation,sequence:3,phase:0,x:500,y:375});
  check((await ws.next(m=>m.type==='sample')).accepted===0,'touch suppressed after pen');
  await delay(750);
  ws.send({type:'touch',generation:touchSession.generation,sequence:4,phase:0,x:500,y:375});
  check((await ws.next(m=>m.type==='sample')).accepted===0,'stationary held pen still suppresses palm');
  if(process.env.OD_TEST_MIRROR==='1'||process.env.OD_TEST_EXTEND==='1') {
    const extend=process.env.OD_TEST_EXTEND==='1';
    ws.send({type:'start',mode:extend?'extend':'mirror',panelWidth:2360,panelHeight:1640,fps:30,target:extend?'':displays[0].id,width:1000,height:750,mapping:'preserve'});
    const mirrored=await ws.next(m=>m.type==='started');
    check(mirrored.generation>0&&mirrored.videoTicket,'mirror started with ticket');
    keepalive=setInterval(()=>ws.send({type:'heartbeat',generation:mirrored.generation}),500);
    await assert.rejects(connect(origin.replace('https','wss')+'/video?ticket=wrong',{Origin:origin,Cookie:authCookie}));checks++;
    video=await connect(origin.replace('https','wss')+'/video?ticket='+mirrored.videoTicket,{Origin:origin,Cookie:authCookie});
    await assert.rejects(connect(origin.replace('https','wss')+'/video?ticket='+mirrored.videoTicket,{Origin:origin,Cookie:authCookie}));checks++;
    const {parsePacket,codecFromAnnexB}=await import('../web-host/wwwroot/video.mjs');
    let first=await video.next(m=>m.type==='binary');
    let bytes=first.data;
    let frame=parsePacket(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),mirrored.generation);
    check(frame?.key&&codecFromAnnexB(frame.data),'first frame is decodable IDR with SPS');
    check(frame.width===(extend?2360:displays[0].width)&&frame.height===(extend?1640:displays[0].height),'capture matches input target');
    ws.send({type:'keyframe',generation:mirrored.generation});
    let sawKey=false;
    for(let i=0;i<60&&!sawKey;i++) {
      bytes=(await video.next(m=>m.type==='binary')).data;
      frame=parsePacket(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),mirrored.generation);
      sawKey=frame.key;
    }
    check(sawKey,'keyframe recovery');
    ws.send({type:'stop'});await ws.next(m=>m.type==='stopped');
    clearInterval(keepalive);video.close();video=undefined;
    await assert.rejects(connect(origin.replace('https','wss')+'/video?ticket='+mirrored.videoTicket,{Origin:origin,Cookie:authCookie}));checks++;
    if(extend){
      let restored=false;
      for(let i=0;i<50&&!restored;i++){
        const current=await (await fetch(origin+'/displays',{headers:{Cookie:authCookie}})).json();
        restored=current.length===displays.length&&current.every(d=>displays.some(old=>old.id===d.id));
        if(!restored)await delay(100);
      }
      check(restored,'Extend teardown restores original active displays');
    }
  }
  host.stdin.write('revoke\n');await delay(300);
  check((await fetch(origin+'/displays',{headers:{Cookie:authCookie}})).status===401,'revocation');
  console.log(`${checks} HTTPS/WSS/native integration checks passed (dry run)`);
} finally {
  clearInterval(keepalive);video?.close();ws?.close();host.stdin.write('quit\n');
  await Promise.race([new Promise(r=>host.once('exit',r)),delay(3000)]);
  if(host.exitCode===null)host.kill();
  if(errors)console.error('Host stderr:',errors); // Never print stdout containing credentials.
}
