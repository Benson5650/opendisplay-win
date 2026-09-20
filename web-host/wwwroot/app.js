'use strict';
import {VideoReceiver} from './video.mjs';
import {orientDimensions,pointInsideSurface,surfaceChanged} from './geometry.mjs';
import {sanitizePreferences} from './preferences.mjs';
import {FingerController} from './finger.mjs';
import {rememberedDisplay,sanitizeDisplayMemory} from './display-memory.mjs';
let sessionSurface,activeSession,pendingSession;
let displayMemory={};
let fingerController,lastPenAt=-Infinity;
let videoSocket,videoReceiver,stopping=false,startInFlight=false,queuedRestartReason,resizeTimer,testMode=false;
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
  $('scaleField').hidden=mode!=='mirror';
  $('penFields').hidden=mode!=='pen';
  $('mapping').disabled=mode!=='pen';
  if(mode!=='pen')$('mapping').value='preserve';
  restoreTarget();
}
$('mode').onchange=updateMode;
if($('identify'))$('identify').onclick=async()=>{
  try {
    await post('/identify',{});
    status('已在 Windows 螢幕顯示識別號碼。');
  } catch(e) {
    status(e.message);
  }
};
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
  for(const [key,value] of Object.entries(saved)){
    if(typeof value==='boolean')$(key).checked=value;else $(key).value=value;
  }
} catch {}
try { displayMemory=sanitizeDisplayMemory(JSON.parse(localStorage.getItem('od-last-displays')||'{}')); } catch {}
updateMode();
updateFingerMode();
updateDebugOverlay($('showDebugLog').checked);
function restoreTarget(){
  if(!$('target'))return;
  $('target').value=rememberedDisplay(displayMemory,$('mode').value,displays);
}
function saveTarget(){
  const mode=$('mode').value,id=$('target').value;
  if(mode!=='pen'&&mode!=='mirror')return;
  if(id)displayMemory[mode]=id;else delete displayMemory[mode];
  try { localStorage.setItem('od-last-displays',JSON.stringify(displayMemory)); } catch {}
}
$('target').onchange=saveTarget;
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
  restoreTarget();
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
  if(typeof sysLog==='function')sysLog(`STOP: ${message}`);
  fingerController?.cancelAll();fingerController=undefined;
  sessionSurface=undefined;activeSession=undefined;pendingSession=undefined;
  startInFlight=false;queuedRestartReason=undefined;clearTimeout(resizeTimer);
  status(message);
  console.info('OpenDisplay stopped:',message);
  const oldControl=socket;socket=undefined;
  videoReceiver?.close(); videoReceiver=undefined;
  const oldVideo=videoSocket;videoSocket=undefined;oldVideo?.close();
  document.getElementById('videoCanvas')?.remove();
  $('hoverIndicator').classList.remove('visible');
  document.querySelector('.hint').hidden=false;
  generation = 0; pointer = null; clearInterval(heartbeat);
  if (oldControl?.readyState === WebSocket.OPEN) oldControl.send(JSON.stringify({type:'stop'}));
  oldControl?.close();
  wakeLock?.release().catch(()=>{}); wakeLock = undefined;
  document.body.classList.remove('writing'); $('tablet').hidden = true; $('settings').hidden = false;
  $('start').disabled = false; status(message);
}
function teardownGeneration(){
  fingerController?.cancelAll();fingerController=undefined;
  const receiver=videoReceiver;videoReceiver=undefined;receiver?.close();
  const oldVideo=videoSocket;videoSocket=undefined;oldVideo?.close();
  document.getElementById('videoCanvas')?.remove();
  $('hoverIndicator').classList.remove('visible');
  document.querySelector('.hint').hidden=false;
  generation=0;sequence=0;pointer=null;clearInterval(heartbeat);
}
function requestSession(reason){
  if(!activeSession||socket?.readyState!==WebSocket.OPEN)return;
  if(startInFlight){queuedRestartReason=reason||'畫布再次改變，正在重新調整。';return;}
  const bounds=$('surface').getBoundingClientRect();
  if(!Number.isFinite(bounds.width)||!Number.isFinite(bounds.height)||bounds.width<=0||bounds.height<=0)return;
  let panel={width:activeSession.panelWidth,height:activeSession.panelHeight};
  if(activeSession.mode==='extend')panel=orientDimensions(panel.width,panel.height,bounds);
  const display=activeSession.mode==='extend'?{...activeSession.display,...panel}:activeSession.display;
  const isPen = activeSession.mode === 'pen';
  const areaScale = isPen ? (Number(activeSession.activeAreaScale) || 1.0) : 1.0;
  let maxW = bounds.width * areaScale;
  let maxH = bounds.height * areaScale;
  let width = maxW, height = maxH;
  if(activeSession.mapping==='preserve'){
    const scale=Math.min(maxW/display.width,maxH/display.height);
    width=display.width*scale;height=display.height*scale;
  }
  teardownGeneration();
  const offsetX = (bounds.width - width) / 2;
  const offsetY = (bounds.height - height) / 2;
  sessionSurface={width:bounds.width,height:bounds.height,offsetX,offsetY,activeWidth:width,activeHeight:height};
  $('surface').dataset.background=activeSession.mode==='pen'?activeSession.penBackground:'dark';
  $('activeArea').hidden=!activeSession.showActiveArea;
  Object.assign($('activeArea').style,{width:`${width}px`,height:`${height}px`,left:`${offsetX}px`,top:`${offsetY}px`});
  const modeName=activeSession.mode==='extend'?'Extend':activeSession.mode==='mirror'?'Mirror':'Pen Tablet';
  const resolution=activeSession.mode==='extend'?` · ${panel.width} × ${panel.height}`:'';
  $('destination').textContent=`${modeName} → ${display.name}${resolution}${testMode?' · 測試模式（不注入）':''}`;
  if(reason)status(reason);
  pendingSession={...activeSession,panelWidth:panel.width,panelHeight:panel.height,width,height,bounds,reason};
  startInFlight=true;
  if(!send({type:'start',mode:activeSession.mode,quality:activeSession.quality,pressureCurve:activeSession.pressureCurve,
    fingerMode:activeSession.fingerMode,trackpadSensitivity:activeSession.trackpadSensitivity,
    panelWidth:panel.width,panelHeight:panel.height,fps:activeSession.fps,target:display.id,
    width:isPen?width:bounds.width,height:isPen?height:bounds.height,mapping:isPen?'stretch':activeSession.mapping,
    hideCursor:activeSession.hideCursor,resolutionScale:activeSession.resolutionScale}))startInFlight=false;
}
$('start').onclick = async () => {
  try {
    const saved={};
    for(const key of ['mode','mapping','fps','quality','pressureCurve','trackpadSensitivity','panelWidth','panelHeight','penBackground','activeAreaScale','resolutionScale'])saved[key]=$(key).value;
    saved.showActiveArea=$('showActiveArea').checked;saved.showHover=$('showHover').checked;saved.showDebugLog=$('showDebugLog').checked;
    saved.hideCursor=$('hideCursor').checked;
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
  saveTarget();
  activeSession={mode,display,panelWidth,panelHeight,mapping:$('mapping').value,fps:Number($('fps').value),
    quality:$('quality').value,pressureCurve:$('pressureCurve').value,fingerMode:$('fingerMode').value,
    trackpadSensitivity:$('trackpadSensitivity').value,penBackground:$('penBackground').value,
    activeAreaScale:Number($('activeAreaScale').value)||1,hideCursor:$('hideCursor').checked,
    resolutionScale:Number($('resolutionScale').value)||1,
    showActiveArea:$('showActiveArea').checked,showHover:$('showHover').checked,showDebugLog:$('showDebugLog').checked};
  updateDebugOverlay(activeSession.showDebugLog);
  $('start').disabled = true; $('tablet').hidden = false;
  document.body.classList.add('writing');
  const ws = new WebSocket(`${wsOrigin}/control`); socket = ws;
  ws.onopen=()=>requestSession();
  ws.onmessage = e => {
    if (socket !== ws) return;
    const m = JSON.parse(e.data);
    if(m.type==='hello'&&m.dryRun){testMode=true;if(!$('destination').textContent.includes('測試模式'))$('destination').textContent+=' · 測試模式（不注入）';}
    if (m.type === 'started') {
      startInFlight=false;
      if(typeof sysLog==='function')sysLog(`started gen=${m.generation} err=${m.error||'none'}`);
      if (!m.generation) { stop(m.error==='EXTEND_UNAVAILABLE_REGISTER_RESOLUTION_LOCALLY'?'Extend 無法建立：請先在 Windows 註冊此解析度並確認 Parsec 驅動。':'目標螢幕或映射無效。'); return; }
      if(queuedRestartReason){const reason=queuedRestartReason;queuedRestartReason=undefined;requestSession(reason);return;}
      const started=pendingSession;
      if(!started){stop('工作階段狀態無效。');return;}
      generation=m.generation; sequence=0;
      fingerController=new FingerController(started.fingerMode,message=>send({...message,generation,sequence:++sequence}));
      heartbeat=setInterval(()=>send({type:'heartbeat',generation}),500);
      status(started.reason?'旋轉完成，工作階段已自動重建。':'已連線。');
      if(m.videoTicket){
        const canvas=document.createElement('canvas');canvas.id='videoCanvas';
        Object.assign(canvas.style,{position:'absolute',pointerEvents:'none',width:`${started.width}px`,height:`${started.height}px`,left:`${(started.bounds.width-started.width)/2}px`,top:`${(started.bounds.height-started.height)/2}px`});
        $('surface').prepend(canvas);document.querySelector('.hint').hidden=true;
        const receiver=new VideoReceiver(canvas,generation,()=>send({type:'keyframe',generation}),message=>{if(videoReceiver===receiver)stop(message);});
        videoReceiver=receiver;
        const vs=new WebSocket(`${wsOrigin}/video?ticket=${encodeURIComponent(m.videoTicket)}`);
        videoSocket=vs;vs.binaryType='arraybuffer';
        vs.onmessage=event=>{if(videoSocket===vs)receiver.receive(event.data);};
        vs.onerror=()=>{if(videoSocket===vs)stop('影片連線失敗。');};
        vs.onclose=()=>{if(videoSocket===vs)stop('影片已中斷，輸入已停止。');};
      }
    }
    if (m.type === 'state' && m.state >= 2) {if(typeof sysLog==='function')sysLog(`state=${m.state} → stop`);stop(({2:'目標螢幕消失',3:'目標螢幕位置或解析度改變',4:'控制心跳逾時'})[m.state]||`工作階段停止 (${m.state})`);}
    if (m.type === 'heartbeat' && !m.alive) {if(typeof sysLog==='function')sysLog('heartbeat dead → stop');stop('工作階段失效，請重新開始。');}
  };
  ws.onerror = () => { if(socket===ws){if(typeof sysLog==='function')sysLog('ws.onerror → stop');stop('連線失敗；主機可能正由另一個裝置使用。');} };
  ws.onclose = () => { if(socket===ws){if(typeof sysLog==='function')sysLog('ws.onclose → stop');stop('主機已中斷連線。');} };
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
  let pressure=0;
  if(phase===0||phase===1){
    pressure=(typeof e.pressure==='number'&&e.pressure>0)?Math.min(1,e.pressure):0.5;
  }
  const isPen = activeSession?.mode === 'pen';
  const ox = isPen ? (sessionSurface?.offsetX || 0) : 0;
  const oy = isPen ? (sessionSurface?.offsetY || 0) : 0;
  send({type:'pen',generation,sequence:++sequence,phase,x:(e.clientX-r.left)-ox,y:(e.clientY-r.top)-oy,
    pressure,azimuth:az,altitude:alt});
}
const surface=$('surface');
function fingerPoint(e){
  const r=surface.getBoundingClientRect();
  const isPen = activeSession?.mode === 'pen';
  const ox = isPen ? (sessionSurface?.offsetX || 0) : 0;
  const oy = isPen ? (sessionSurface?.offsetY || 0) : 0;
  return {x:(e.clientX-r.left)-ox,y:(e.clientY-r.top)-oy};
}
function updateHoverIndicator(e,visible){
  const indicator=$('hoverIndicator');
  if(!visible||!activeSession?.showHover||!generation){indicator.classList.remove('visible');return;}
  const point=pointInsideSurface(e.clientX,e.clientY,surface.getBoundingClientRect());
  if(!point){indicator.classList.remove('visible');return;}
  const {x,y}=point;
  indicator.style.transform=`translate(${x}px,${y}px)`;indicator.classList.add('visible');
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
// ── Pen event diagnostics & toolbar controls ──
const _dbg=document.createElement('div');
_dbg.id='debugOverlay';
Object.assign(_dbg.style,{position:'fixed',bottom:'0',left:'0',right:'0',maxHeight:'40vh',overflow:'auto',background:'rgba(0,0,0,.85)',color:'#0f0',font:'11px/1.4 monospace',padding:'6px 8px',zIndex:'9999',pointerEvents:'none',whiteSpace:'pre',display:'none'});
document.body.appendChild(_dbg);const _dbgLines=[];
function updateDebugOverlay(show){
  _dbg.style.display=show?'block':'none';
  if($('toggleLogBtn'))$('toggleLogBtn').hidden=!show;
  if(show){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
}
function penLog(tag,e){
  const line=`${tag.padEnd(10)} id=${e.pointerId} btn=${e.buttons} p=${(e.pressure??-1).toFixed(3)} ptr=${pointer} gen=${generation} type=${e.pointerType}`;
  _dbgLines.push(line);if(_dbgLines.length>30)_dbgLines.shift();
  if(_dbg.style.display!=='none'){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
}
function sysLog(msg){
  _dbgLines.push(`>>> ${msg}`);if(_dbgLines.length>30)_dbgLines.shift();
  if(_dbg.style.display!=='none'){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
}
$('showDebugLog').onchange=()=>updateDebugOverlay($('showDebugLog').checked);
$('toggleLogBtn').onclick=()=>{
  const next=_dbg.style.display==='none'?'block':'none';
  _dbg.style.display=next;
  if(next==='block'){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
};
$('fullscreenBtn').onclick=async()=>{
  try{
    if(document.fullscreenElement||document.webkitFullscreenElement){
      if(document.exitFullscreen)await document.exitFullscreen();
      else if(document.webkitExitFullscreen)await document.webkitExitFullscreen();
    }else{
      const el=$('tablet');
      if(el.requestFullscreen)await el.requestFullscreen();
      else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();
      else if(document.documentElement.webkitRequestFullscreen)await document.documentElement.webkitRequestFullscreen();
    }
  }catch{}
};
const syncFullscreen=()=>{
  const isFs=!!(document.fullscreenElement||document.webkitFullscreenElement);
  $('fullscreenBtn').textContent=isFs?'離開全螢幕':'全螢幕';
};
document.addEventListener('fullscreenchange',syncFullscreen);
document.addEventListener('webkitfullscreenchange',syncFullscreen);
// ── End diagnostics & toolbar controls ──
surface.addEventListener('pointerdown',e=> {
  if(e.pointerType==='pen')penLog('DOWN',e);
  e.preventDefault(); if(e.pointerType!=='pen'||pointer!==null||!generation)return;
  updateHoverIndicator(e,false);pointer=e.pointerId;try{surface.setPointerCapture(pointer);}catch{}sample(e,0);
});
surface.addEventListener('pointerenter',e=>{if(e.pointerType==='pen'){penLog('ENTER',e);if(pointer===null&&generation){e.preventDefault();sample(e,3);updateHoverIndicator(e,true);}}});
surface.addEventListener('pointermove',e=> {
  if(e.pointerType!=='pen')return; e.preventDefault();
  if(pointer!==null && pointer!==e.pointerId)return;
  const batch=e.getCoalescedEvents?.();
  for(const point of batch?.length?batch:[e]) sample(point,pointer===e.pointerId?1:3);
  updateHoverIndicator(e,pointer===null);
});
surface.addEventListener('pointerup',e=>{if(e.pointerType==='pen'){penLog('UP',e);if(e.pointerId===pointer){sample(e,2);pointer=null;updateHoverIndicator(e,true);}}});
surface.addEventListener('pointercancel',e=>{if(e.pointerType==='pen'){penLog('CANCEL',e);if(e.pointerId===pointer){sample(e,4);pointer=null;}updateHoverIndicator(e,false);}});
surface.addEventListener('lostpointercapture',e=>{if(e.pointerType==='pen'){penLog('LOSTCAP',e);updateHoverIndicator(e,pointer===null);}});
surface.addEventListener('pointerleave',e=>{if(e.pointerType==='pen'){penLog('LEAVE',e);if(pointer===null)sample(e,4);updateHoverIndicator(e,false);}});
surface.addEventListener('contextmenu',e=>e.preventDefault());
$('stop').onclick=()=>stop(); $('refresh').onclick=()=>refresh().catch(e=>status(e.message));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&socket)stop('切到背景，已停止輸入。');});
window.addEventListener('resize',()=>{
  if(!socket||stopping)return;
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if(socket&&!stopping&&surfaceChanged(sessionSurface,$('surface').getBoundingClientRect()))
      requestSession('偵測到 iPad 旋轉，正在重建工作階段。');
  },350);
});
window.addEventListener('pagehide',()=>stop());
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
refresh().catch(e=>status(e.message));
