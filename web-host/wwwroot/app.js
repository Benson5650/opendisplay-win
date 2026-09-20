'use strict';
import {VideoReceiver} from './video.mjs';
import {surfaceChanged} from './geometry.mjs';
import {sanitizePreferences} from './preferences.mjs';
import {FingerController} from './finger.mjs';
let sessionSurface;
let fingerController,lastPenAt=-Infinity;
let videoSocket, videoReceiver, stopping=false;
const $ = id => document.getElementById(id);
const wsOrigin=location.origin.replace(/^http/, 'ws');
let socket, generation = 0, sequence = 0, pointer = null, wakeLock, displays = [], heartbeat, ticketTimer;
const status = text => { $('status').textContent = text; };
function updateMode() {
  const mode=$('mode').value;
  $('targetField').hidden=mode==='extend';
  $('panelFields').hidden=mode!=='extend';
  $('fpsField').hidden=mode==='pen';
  $('qualityField').hidden=mode==='pen';
  $('mapping').disabled=mode!=='pen';
  if(mode!=='pen')$('mapping').value='preserve';
}
$('mode').onchange=updateMode;
function updateFingerMode(){ $('sensitivityField').hidden=$('fingerMode').value!=='trackpad'; }
$('fingerMode').onchange=updateFingerMode;
$('forget').onclick=async()=>{
  if(!confirm('撤銷此瀏覽器的配對？下次需要重新輸入配對碼。'))return;
  try {
    await post('/unpair',{});
    stop('已忘記此裝置。');
    $('settings').hidden=true;$('pairing').hidden=false;
  } catch(e){status(e.message);}
};
try {
  const saved=sanitizePreferences(JSON.parse(localStorage.getItem('od-preferences')||'{}'));
  for(const [key,value] of Object.entries(saved))$(key).value=value;
} catch {}
updateMode();
updateFingerMode();
async function post(path, value) {
  const r = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  if (!r.ok) throw new Error(`請求失敗 (${r.status})，請檢查主機配對狀態。`);
  return r.json();
}
async function refresh() {
  const r = await fetch('/displays');
  if (!r.ok) { $('pairing').hidden = false; $('settings').hidden = true; return; }
  displays = await r.json();
  $('target').replaceChildren(new Option('請選擇螢幕', ''));
  for (const d of displays) $('target').add(new Option(`${d.name} · ${d.width} × ${d.height}${d.primary?' · 主螢幕':''}`, d.id));
  $('pairing').hidden = true; $('settings').hidden = false;
  status('已配對。請明確選擇要控制的螢幕。');
}
$('pair').onclick = async () => {
  $('pair').disabled = true;
  try {
    const {ticket} = await post('/pair', {code:$('code').value.trim().toUpperCase()});
    $('code').value = ''; status('等待 Windows 主機輸入 approve。');
    clearInterval(ticketTimer);
    ticketTimer = setInterval(async () => {
      try {
        const result = await post('/pair/status', {ticket});
        if (result.ready) { clearInterval(ticketTimer); $('pair').disabled = false; await refresh(); }
      } catch(e) { clearInterval(ticketTimer); $('pair').disabled = false; status(e.message); }
    }, 1500);
  } catch(e) { $('pair').disabled = false; status(e.message); }
};
function send(m) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > 32768) { stop('網路積壓，已停止輸入。'); return false; }
  socket.send(JSON.stringify(m)); return true;
}
function stop(message = '已停止。可重新選擇螢幕。') {
  if(stopping)return;
  stopping=true;
  fingerController?.cancelAll();fingerController=undefined;
  sessionSurface=undefined;
  status(message);
  console.info('OpenDisplay stopped:',message);
  const oldControl=socket;socket=undefined;
  videoReceiver?.close(); videoReceiver=undefined;
  const oldVideo=videoSocket;videoSocket=undefined;oldVideo?.close();
  document.getElementById('videoCanvas')?.remove();
  document.querySelector('.hint').hidden=false;
  generation = 0; pointer = null; clearInterval(heartbeat);
  if (oldControl?.readyState === WebSocket.OPEN) oldControl.send(JSON.stringify({type:'stop'}));
  oldControl?.close();
  wakeLock?.release().catch(()=>{}); wakeLock = undefined;
  document.body.classList.remove('writing'); $('tablet').hidden = true; $('settings').hidden = false;
  $('start').disabled = false; status(message);
}
$('start').onclick = async () => {
  try {
    const saved={};
    for(const key of ['mode','mapping','fps','quality','pressureCurve','trackpadSensitivity','panelWidth','panelHeight'])saved[key]=$(key).value;
    localStorage.setItem('od-preferences',JSON.stringify(sanitizePreferences(saved)));
  } catch {}
  stopping=false;
  const mode=$('mode').value;
  if(mode!=='pen'&&!('VideoDecoder' in window)){status('此瀏覽器不支援 WebCodecs VideoDecoder。');return;}
  if(mode!=='pen')$('mapping').value='preserve';
  const panelWidth=Number($('panelWidth').value),panelHeight=Number($('panelHeight').value);
  if(mode==='extend'&&(!Number.isInteger(panelWidth)||!Number.isInteger(panelHeight)||panelWidth<640||panelHeight<480||panelWidth>4096||panelHeight>4096||panelWidth%2||panelHeight%2)){
    status('Extend 解析度須為偶數，寬 640–4096、高 480–4096。');return;
  }
  const display = mode==='extend'?{id:'',name:'新的延伸螢幕',width:panelWidth,height:panelHeight}:displays.find(d=>d.id === $('target').value);
  if (!display) { status('請先選擇目標螢幕。'); return; }
  $('start').disabled = true; $('tablet').hidden = false;
  document.body.classList.add('writing');
  $('destination').textContent = `${mode==='extend'?'Extend':mode==='mirror'?'Mirror':'Pen Tablet'} → ${display.name}`;
  const surface = $('surface').getBoundingClientRect();
  sessionSurface={width:surface.width,height:surface.height};
  let width=surface.width, height=surface.height;
  if ($('mapping').value === 'preserve') {
    const scale=Math.min(width/display.width,height/display.height);
    width=display.width*scale; height=display.height*scale;
  }
  Object.assign($('activeArea').style,{width:`${width}px`,height:`${height}px`,left:`${(surface.width-width)/2}px`,top:`${(surface.height-height)/2}px`});
  const ws = new WebSocket(`${wsOrigin}/control`); socket = ws;
  ws.onopen = () => send({type:'start',mode,quality:$('quality').value,pressureCurve:$('pressureCurve').value,fingerMode:$('fingerMode').value,trackpadSensitivity:$('trackpadSensitivity').value,panelWidth,panelHeight,fps:Number($('fps').value),target:display.id,width:surface.width,height:surface.height,mapping:$('mapping').value});
  ws.onmessage = e => {
    if (socket !== ws) return;
    const m = JSON.parse(e.data);
    if (m.type === 'hello' && m.dryRun) $('destination').textContent += ' · 測試模式（不注入）';
    if (m.type === 'started') {
      if (!m.generation) { stop(m.error==='EXTEND_UNAVAILABLE_REGISTER_RESOLUTION_LOCALLY'?'Extend 無法建立：請先在 Windows 註冊此解析度並確認 Parsec 驅動。':'目標螢幕或映射無效。'); return; }
      generation=m.generation; sequence=0;
      fingerController=new FingerController($('fingerMode').value,message=>send({...message,generation,sequence:++sequence}));
      heartbeat=setInterval(()=>send({type:'heartbeat',generation}),500);
      if(m.videoTicket){
        const canvas=document.createElement('canvas');canvas.id='videoCanvas';
        Object.assign(canvas.style,{position:'absolute',pointerEvents:'none',width:`${width}px`,height:`${height}px`,left:`${(surface.width-width)/2}px`,top:`${(surface.height-height)/2}px`});
        $('surface').prepend(canvas);document.querySelector('.hint').hidden=true;
        const receiver=new VideoReceiver(canvas,generation,()=>send({type:'keyframe',generation}),message=>stop(message));
        videoReceiver=receiver;
        const vs=new WebSocket(`${wsOrigin}/video?ticket=${encodeURIComponent(m.videoTicket)}`);
        videoSocket=vs;vs.binaryType='arraybuffer';
        vs.onmessage=event=>{if(videoSocket===vs)receiver.receive(event.data);};
        vs.onerror=()=>{if(videoSocket===vs)stop('影片連線失敗。');};
        vs.onclose=()=>{if(videoSocket===vs)stop('影片已中斷，輸入已停止。');};
      }
    }
    if (m.type === 'state' && m.state >= 2) stop(({2:'目標螢幕消失',3:'目標螢幕位置或解析度改變',4:'控制心跳逾時'})[m.state]||`工作階段停止 (${m.state})`);
    if (m.type === 'heartbeat' && !m.alive) stop('工作階段失效，請重新開始。');
  };
  ws.onerror = () => { if(socket===ws) stop('連線失敗；主機可能正由另一個裝置使用。'); };
  ws.onclose = () => { if(socket===ws) stop('主機已中斷連線。'); };
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
};
function sample(e, phase) {
  lastPenAt=performance.now();fingerController?.cancelAll();
  if (!generation) return;
  const r=$('surface').getBoundingClientRect();
  let az=e.azimuthAngle, alt=e.altitudeAngle;
  if (!Number.isFinite(az) || !Number.isFinite(alt)) {
    const tx=Math.tan((e.tiltX||0)*Math.PI/180), ty=Math.tan((e.tiltY||0)*Math.PI/180);
    az=(Math.atan2(ty,tx)+2*Math.PI)%(2*Math.PI); alt=Math.atan2(1,Math.hypot(tx,ty));
  }
  send({type:'pen',generation,sequence:++sequence,phase,x:e.clientX-r.left,y:e.clientY-r.top,
    pressure:phase===0||phase===1?e.pressure:0,azimuth:az,altitude:alt});
}
const surface=$('surface');
function fingerPoint(e){
  const r=surface.getBoundingClientRect();
  return {x:e.clientX-r.left,y:e.clientY-r.top};
}
surface.addEventListener('pointerdown',e=>{
  if(e.pointerType!=='touch'||!fingerController||!generation)return;
  e.preventDefault();
  if(pointer!==null||performance.now()-lastPenAt<700)return;
  const {x,y}=fingerPoint(e);
  if(fingerController.down(e.pointerId,x,y,e.timeStamp))surface.setPointerCapture(e.pointerId);
});
surface.addEventListener('pointermove',e=>{if(e.pointerType==='touch'&&fingerController){const {x,y}=fingerPoint(e);fingerController.move(e.pointerId,x,y,e.timeStamp);}});
surface.addEventListener('pointerup',e=>{if(e.pointerType==='touch'&&fingerController){const {x,y}=fingerPoint(e);fingerController.up(e.pointerId,x,y,e.timeStamp);}});
for(const name of ['pointercancel','lostpointercapture'])surface.addEventListener(name,e=>{if(e.pointerType==='touch'&&fingerController){const {x,y}=fingerPoint(e);fingerController.up(e.pointerId,x,y,e.timeStamp,true);}});
surface.addEventListener('pointerdown',e=> {
  e.preventDefault(); if(e.pointerType!=='pen'||pointer!==null||!generation)return;
  pointer=e.pointerId; surface.setPointerCapture(pointer); sample(e,0);
});
surface.addEventListener('pointermove',e=> {
  if(e.pointerType!=='pen')return; e.preventDefault();
  if(pointer!==null && pointer!==e.pointerId)return;
  const batch=e.getCoalescedEvents?.();
  for(const point of batch?.length?batch:[e]) sample(point,pointer===e.pointerId?1:3);
});
surface.addEventListener('pointerup',e=>{if(e.pointerId===pointer){sample(e,2);pointer=null;}});
surface.addEventListener('pointercancel',e=>{if(e.pointerId===pointer){sample(e,4);pointer=null;}});
surface.addEventListener('lostpointercapture',e=>{if(e.pointerId===pointer){sample(e,4);pointer=null;}});
surface.addEventListener('pointerleave',e=>{if(e.pointerType==='pen'&&pointer===null)sample(e,4);});
surface.addEventListener('contextmenu',e=>e.preventDefault());
$('stop').onclick=()=>stop(); $('refresh').onclick=()=>refresh().catch(e=>status(e.message));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&socket)stop('切到背景，已停止輸入。');});
window.addEventListener('resize',()=>{
  if(socket && surfaceChanged(sessionSurface,$('surface').getBoundingClientRect()))
    stop('畫布大小已改變，請重新開始。');
});
window.addEventListener('pagehide',()=>stop());
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
refresh().catch(e=>status(e.message));
