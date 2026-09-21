'use strict';
import {VideoReceiver} from './video.mjs';
import {orientDimensions,pointInsideSurface,surfaceChanged} from './geometry.mjs';
import {sanitizePreferences} from './preferences.mjs';
import {FingerController} from './finger.mjs';
import {penTransition} from './pen-state.mjs';
import {rememberedDisplay,sanitizeDisplayMemory} from './display-memory.mjs';
import {dragRegionAspect,fitRegionAspect,FULL_REGION,sanitizeRegion,sanitizeRegionStore} from './target-region.mjs';
let sessionSurface,activeSession,pendingSession;
let displayMemory={},regionStore={},regionDrag;
let regionEditing=false,liveRegion,liveRegionOriginal,liveRegionDrag,liveRegionFrame;
let fingerController,lastPenAt=-Infinity;
const fingerPointerIds=new Set();
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
  $('mapping').value=mode==='pen'?'stretch':'preserve';
  restoreTarget();
  renderRegionEditor();
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
// ── Pen event diagnostics & toolbar controls ──
const _dbg=document.createElement('div');
_dbg.id='debugOverlay';
Object.assign(_dbg.style,{position:'fixed',bottom:'0',left:'0',right:'0',maxHeight:'40vh',overflow:'auto',background:'rgba(0,0,0,.85)',color:'#0f0',font:'11px/1.4 monospace',padding:'6px 8px',zIndex:'9999',pointerEvents:'none',whiteSpace:'pre',display:'none'});
document.body.appendChild(_dbg);const _dbgLines=[];
const debugQueue=[];
let lastDebugMove=0;
function queueDebug(line){
  if(!activeSession?.showDebugLog)return;
  debugQueue.push(`${performance.now().toFixed(0)}ms ${line}`.slice(0,240));
  if(debugQueue.length>100)debugQueue.shift();
}
function flushDebug(){
  if(socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>8192||!debugQueue.length)return;
  socket.send(JSON.stringify({type:'debugLog',lines:debugQueue.splice(0,10)}));
}
setInterval(flushDebug,500);
function updateDebugOverlay(show){
  _dbg.style.display=show?'block':'none';
  if($('toggleLogBtn'))$('toggleLogBtn').hidden=!show;
  if(show){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
}
function penLog(tag,e){
  const line=`${tag.padEnd(10)} id=${e.pointerId} btn=${e.buttons} p=${(e.pressure??-1).toFixed(3)} ptr=${pointer} gen=${generation} type=${e.pointerType}`;
  queueDebug(line);
  _dbgLines.push(line);if(_dbgLines.length>30)_dbgLines.shift();
  if(_dbg.style.display!=='none'){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
}
function sysLog(msg){
  queueDebug(`>>> ${msg}`);
  _dbgLines.push(`>>> ${msg}`);if(_dbgLines.length>30)_dbgLines.shift();
  if(_dbg.style.display!=='none'){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
}
$('showDebugLog').onchange=()=>updateDebugOverlay($('showDebugLog').checked);
if($('toggleLogBtn'))$('toggleLogBtn').onclick=()=>{
  const next=_dbg.style.display==='none'?'block':'none';
  _dbg.style.display=next;
  if(next==='block'){_dbg.textContent=_dbgLines.join('\n');_dbg.scrollTop=_dbg.scrollHeight;}
};
try {
  const saved=sanitizePreferences(JSON.parse(localStorage.getItem('od-preferences')||'{}'));
  for(const [key,value] of Object.entries(saved)){
    if(typeof value==='boolean')$(key).checked=value;else $(key).value=value;
  }
} catch {}
try { displayMemory=sanitizeDisplayMemory(JSON.parse(localStorage.getItem('od-last-displays')||'{}')); } catch {}
try { regionStore=sanitizeRegionStore(JSON.parse(localStorage.getItem('od-target-regions')||'{}')); } catch {}
updateMode();
updateFingerMode();
updateDebugOverlay($('showDebugLog').checked);
function restoreTarget(){
  if(!$('target'))return;
  $('target').value=rememberedDisplay(displayMemory,$('mode').value,displays);
  renderRegionEditor();
}
function saveTarget(){
  const mode=$('mode').value,id=$('target').value;
  if(mode!=='pen'&&mode!=='mirror')return;
  if(id)displayMemory[mode]=id;else delete displayMemory[mode];
  try { localStorage.setItem('od-last-displays',JSON.stringify(displayMemory)); } catch {}
}
function selectedDisplay(){return displays.find(display=>display.id===$('target').value);}
function regionAspect(display,bounds={width:window.innerWidth,height:window.innerHeight}){
  return (bounds.width/bounds.height)/(display.width/display.height);
}
function currentTargetRegion(){
  const display=selectedDisplay();
  return display?fitRegionAspect(regionStore[display.id]||FULL_REGION,regionAspect(display)):FULL_REGION;
}
function saveRegions(){
  try { localStorage.setItem('od-target-regions',JSON.stringify(regionStore)); } catch {}
}
function renderRegionEditor(){
  const editor=$('regionEditor'),rect=$('regionRect'),empty=$('regionEmpty'),display=selectedDisplay();
  if(!editor||!rect)return;
  editor.classList.toggle('disabled',!display);rect.hidden=!display;empty.hidden=!!display;
  if(!display){$('regionReadout').textContent='請先選擇 Windows 螢幕';return;}
  editor.style.aspectRatio=`${display.width} / ${display.height}`;
  const region=currentTargetRegion();
  Object.assign(rect.style,{left:`${region.x*100}%`,top:`${region.y*100}%`,width:`${region.width*100}%`,height:`${region.height*100}%`});
  $('regionReadout').textContent=`X ${Math.round(region.x*100)}% · Y ${Math.round(region.y*100)}% · 寬 ${Math.round(region.width*100)}% · 高 ${Math.round(region.height*100)}%`;
}
$('regionReset').onclick=()=>{
  const display=selectedDisplay();if(!display)return;
  regionStore[display.id]=fitRegionAspect(FULL_REGION,regionAspect(display));saveRegions();renderRegionEditor();
};
const regionEditor=$('regionEditor');
regionEditor.addEventListener('pointerdown',e=>{
  const display=selectedDisplay(),body=e.target.closest?.('#regionRect');
  if(!display||!body)return;
  e.preventDefault();
  const bounds=regionEditor.getBoundingClientRect();
  regionDrag={pointerId:e.pointerId,displayId:display.id,action:e.target.dataset.handle||'move',startX:e.clientX,startY:e.clientY,start:{...currentTargetRegion()},width:bounds.width,height:bounds.height};
  regionEditor.setPointerCapture(e.pointerId);
});
regionEditor.addEventListener('pointermove',e=>{
  if(!regionDrag||regionDrag.pointerId!==e.pointerId)return;
  e.preventDefault();
  const display=displays.find(item=>item.id===regionDrag.displayId);
  regionStore[regionDrag.displayId]=dragRegionAspect(regionDrag.start,regionDrag.action,(e.clientX-regionDrag.startX)/regionDrag.width,(e.clientY-regionDrag.startY)/regionDrag.height,regionAspect(display));
  renderRegionEditor();
});
function finishRegionDrag(e){
  if(!regionDrag||regionDrag.pointerId!==e.pointerId)return;
  regionDrag=undefined;saveRegions();renderRegionEditor();
}
regionEditor.addEventListener('pointerup',finishRegionDrag);
regionEditor.addEventListener('pointercancel',finishRegionDrag);
$('target').onchange=()=>{saveTarget();renderRegionEditor();};

function liveAspect(){
  const display=activeSession?.display,bounds=$('surface').getBoundingClientRect();
  return display?regionAspect(display,bounds):1;
}
function renderLiveRegion(){
  if(!liveRegion||!activeSession)return;
  const editor=$('liveRegionEditor'),rect=$('liveRegionRect'),display=activeSession.display;
  editor.style.aspectRatio=`${display.width} / ${display.height}`;
  Object.assign(rect.style,{left:`${liveRegion.x*100}%`,top:`${liveRegion.y*100}%`,width:`${liveRegion.width*100}%`,height:`${liveRegion.height*100}%`});
  $('liveRegionReadout').textContent=`X ${Math.round(liveRegion.x*100)}% · Y ${Math.round(liveRegion.y*100)}% · 寬 ${Math.round(liveRegion.width*100)}% · 高 ${Math.round(liveRegion.height*100)}%`;
}
function setLiveRegion(value,sendUpdate=false){
  const clean=sanitizeRegion(value);if(!clean||!activeSession)return;
  liveRegion=fitRegionAspect(clean,liveAspect());
  activeSession.targetRegion={...liveRegion};
  regionStore[activeSession.display.id]={...liveRegion};
  renderLiveRegion();
  if(sendUpdate&&!liveRegionFrame)liveRegionFrame=requestAnimationFrame(()=>{
    liveRegionFrame=undefined;
    if(regionEditing&&generation)send({type:'regionEditUpdate',generation,region:liveRegion});
  });
}
function closeLiveRegion(){
  regionEditing=false;liveRegionDrag=undefined;
  if(liveRegionFrame)cancelAnimationFrame(liveRegionFrame);liveRegionFrame=undefined;
  $('liveRegionPanel').hidden=true;
}
function beginLiveRegion(){
  if(regionEditing||activeSession?.mode!=='pen'||!generation)return;
  fingerController?.cancelAll();
  liveRegionOriginal={...activeSession.targetRegion};
  liveRegion={...activeSession.targetRegion};
  regionEditing=true;$('liveRegionPanel').hidden=false;renderLiveRegion();
  send({type:'regionEditBegin',generation});
}
$('editRegionBtn').onclick=beginLiveRegion;
$('liveRegionReset').onclick=()=>setLiveRegion(FULL_REGION,true);
function flushLiveRegion(){
  if(liveRegionFrame){cancelAnimationFrame(liveRegionFrame);liveRegionFrame=undefined;}
  if(regionEditing&&generation)send({type:'regionEditUpdate',generation,region:liveRegion});
}
$('liveRegionDone').onclick=()=>{if(regionEditing){flushLiveRegion();send({type:'regionEditEnd',generation,commit:true});}};
$('liveRegionCancel').onclick=()=>{
  if(liveRegionFrame){cancelAnimationFrame(liveRegionFrame);liveRegionFrame=undefined;}
  if(regionEditing)send({type:'regionEditEnd',generation,commit:false});
};
const liveRegionEditor=$('liveRegionEditor');
liveRegionEditor.addEventListener('pointerdown',e=>{
  const body=e.target.closest?.('#liveRegionRect');if(!regionEditing||!body)return;
  e.preventDefault();const bounds=liveRegionEditor.getBoundingClientRect();
  liveRegionDrag={pointerId:e.pointerId,action:e.target.dataset.handle||'move',startX:e.clientX,startY:e.clientY,start:{...liveRegion},width:bounds.width,height:bounds.height};
  liveRegionEditor.setPointerCapture(e.pointerId);
});
liveRegionEditor.addEventListener('pointermove',e=>{
  if(!liveRegionDrag||liveRegionDrag.pointerId!==e.pointerId)return;
  e.preventDefault();setLiveRegion(dragRegionAspect(liveRegionDrag.start,liveRegionDrag.action,
    (e.clientX-liveRegionDrag.startX)/liveRegionDrag.width,(e.clientY-liveRegionDrag.startY)/liveRegionDrag.height,liveAspect()),true);
});
function finishLiveDrag(e){if(liveRegionDrag?.pointerId===e.pointerId)liveRegionDrag=undefined;}
liveRegionEditor.addEventListener('pointerup',finishLiveDrag);
liveRegionEditor.addEventListener('pointercancel',finishLiveDrag);
$('liveRegionPanel').addEventListener('pointerdown',e=>e.stopPropagation());
$('liveRegionPanel').addEventListener('pointermove',e=>e.stopPropagation());
$('liveRegionPanel').addEventListener('pointerup',e=>e.stopPropagation());
$('liveRegionPanel').addEventListener('pointercancel',e=>e.stopPropagation());
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
if ($('code')) $('code').onkeydown = e => { if (e.key === 'Enter') $('pair').click(); };
function send(m) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > 32768) { stop('網路積壓，已停止輸入。'); return false; }
  socket.send(JSON.stringify(m)); return true;
}
function stop(message = '已停止。可重新選擇螢幕。') {
  if(stopping)return;
  stopping=true;
  if(typeof sysLog==='function')sysLog(`STOP: ${message}`);
  flushDebug();
  fingerController?.cancelAll();fingerController=undefined;
  if(regionEditing&&liveRegionOriginal&&activeSession){
    activeSession.targetRegion={...liveRegionOriginal};regionStore[activeSession.display.id]={...liveRegionOriginal};
  }
  closeLiveRegion();
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
  const targetRegion=isPen?fitRegionAspect(activeSession.targetRegion,regionAspect(display,bounds)):FULL_REGION;
  let width=bounds.width,height=bounds.height;
  if(!isPen&&activeSession.mapping==='preserve'){
    const scale=Math.min(bounds.width/display.width,bounds.height/display.height);
    width=display.width*scale;height=display.height*scale;
  }
  teardownGeneration();
  sessionSurface={width:bounds.width,height:bounds.height};
  $('surface').dataset.background=activeSession.mode==='pen'?activeSession.penBackground:'dark';
  $('activeArea').hidden=true;
  const modeName=activeSession.mode==='extend'?'Extend':activeSession.mode==='mirror'?'Mirror':'Pen Tablet';
  const resolution=activeSession.mode==='extend'?` · ${panel.width} × ${panel.height}`:'';
  $('destination').textContent=`${modeName} → ${display.name}${resolution}${testMode?' · 測試模式（不注入）':''}`;
  if(reason)status(reason);
  pendingSession={...activeSession,panelWidth:panel.width,panelHeight:panel.height,width,height,bounds,reason};
  startInFlight=true;
  if(!send({type:'start',mode:activeSession.mode,quality:activeSession.quality,pressureCurve:activeSession.pressureCurve,
    fingerMode:activeSession.fingerMode,trackpadSensitivity:activeSession.trackpadSensitivity,
    panelWidth:panel.width,panelHeight:panel.height,fps:activeSession.fps,target:display.id,
    width:bounds.width,height:bounds.height,mapping:isPen?'stretch':activeSession.mapping,
    targetRegion,
    hideCursor:activeSession.hideCursor,resolutionScale:activeSession.resolutionScale}))startInFlight=false;
}
$('start').onclick = async () => {
  try {
    const saved={};
    for(const key of ['mode','mapping','fps','quality','pressureCurve','trackpadSensitivity','panelWidth','panelHeight','penBackground','resolutionScale'])saved[key]=$(key).value;
    saved.showHover=$('showHover').checked;saved.showDebugLog=$('showDebugLog').checked;
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
    targetRegion:{...currentTargetRegion()},hideCursor:$('hideCursor').checked,
    resolutionScale:Number($('resolutionScale').value)||1,
    showHover:$('showHover').checked,showDebugLog:$('showDebugLog').checked};
  updateDebugOverlay(activeSession.showDebugLog);
  debugQueue.length=0;
  $('start').disabled = true; $('tablet').hidden = false;
  $('editRegionBtn').hidden=mode!=='pen';
  document.body.classList.add('writing');
  const ws = new WebSocket(`${wsOrigin}/control`); socket = ws;
  ws.onopen=()=>{sysLog(`session mode=${activeSession.mode} finger=${activeSession.fingerMode}`);requestSession();};
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
    if(m.type==='regionChanged'){
      const next=sanitizeRegion(m.region);
      if(next)setLiveRegion(next,false);
      if(m.state==='committed'){
        saveRegions();closeLiveRegion();status('有效區已更新。');
      }else if(m.state==='canceled'){
        if(next)setLiveRegion(next,false);else if(liveRegionOriginal)setLiveRegion(liveRegionOriginal,false);
        saveRegions();closeLiveRegion();status('已取消有效區調整。');
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
  if(regionEditing)return;
  lastPenAt=performance.now();cancelFingerPointers();
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
  send({type:'pen',generation,sequence:++sequence,phase,x:e.clientX-r.left,y:e.clientY-r.top,
    pressure,azimuth:az,altitude:alt});
}
const surface=$('surface');
function cancelFingerPointers(){
  fingerController?.cancelAll();
  for(const id of fingerPointerIds)try{if(surface.hasPointerCapture(id))surface.releasePointerCapture(id);}catch{}
  fingerPointerIds.clear();
}
function fingerPoint(e){
  const r=surface.getBoundingClientRect();
  return {x:e.clientX-r.left,y:e.clientY-r.top};
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
  if(e.pointerType==='touch')penLog('TOUCH DOWN',e);
  if(regionEditing||e.pointerType!=='touch'||!fingerController||!generation)return;
  e.preventDefault();
  if(pointer!==null||performance.now()-lastPenAt<700)return;
  const {x,y}=fingerPoint(e);
  if(fingerController.down(e.pointerId,x,y,e.timeStamp)){
    fingerPointerIds.add(e.pointerId);try{surface.setPointerCapture(e.pointerId);}catch{}
  }
});
surface.addEventListener('pointermove',e=>{if(!regionEditing&&e.pointerType==='touch'&&fingerController){const {x,y}=fingerPoint(e);fingerController.move(e.pointerId,x,y,e.timeStamp);}});
surface.addEventListener('pointerup',e=>{if(e.pointerType==='touch'&&fingerController){fingerPointerIds.delete(e.pointerId);if(!regionEditing){const {x,y}=fingerPoint(e);fingerController.up(e.pointerId,x,y,e.timeStamp);}}});
for(const name of ['pointercancel','lostpointercapture'])surface.addEventListener(name,e=>{if(e.pointerType==='touch'&&fingerController){fingerPointerIds.delete(e.pointerId);const {x,y}=fingerPoint(e);fingerController.up(e.pointerId,x,y,e.timeStamp,true);}});
// ── End diagnostics & toolbar controls ──
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
  e.preventDefault(); if(e.pointerType!=='pen'||!generation)return;
  if(pointer!==null&&pointer!==e.pointerId){sample(e,4);pointer=null;}
  if(pointer!==null)return;
  updateHoverIndicator(e,false);pointer=e.pointerId;try{surface.setPointerCapture(pointer);}catch{}sample(e,0);
});
surface.addEventListener('pointerenter',e=>{if(e.pointerType==='pen'){penLog('ENTER',e);if(pointer===null&&generation){e.preventDefault();sample(e,3);updateHoverIndicator(e,true);}}});
surface.addEventListener('pointermove',e=> {
  if(e.pointerType!=='pen'||regionEditing||!generation)return; e.preventDefault();
  if(performance.now()-lastDebugMove>150){lastDebugMove=performance.now();penLog('MOVE',e);}
  const next=penTransition(pointer,e);
  pointer=next.pointer;
  for(const phase of next.phases){
    if(phase===0){
      sysLog('Pencil: recovered down');
      try{surface.setPointerCapture(pointer);}catch{}
    }
    if(phase===2)sysLog('Pencil: recovered up');
    // Only replay coalesced events within an established stroke. Crossing a
    // contact boundary must use the newest event to avoid stale hover frames.
    const batch=phase===1?e.getCoalescedEvents?.():null;
    for(const point of batch?.length?batch:[e])sample(point,phase);
  }
  updateHoverIndicator(e,pointer===null);
});
surface.addEventListener('pointerup',e=>{if(e.pointerType==='pen'){penLog('UP',e);if(e.pointerId===pointer){sample(e,2);pointer=null;updateHoverIndicator(e,true);}}});
surface.addEventListener('pointercancel',e=>{if(e.pointerType==='pen'){penLog('CANCEL',e);if(e.pointerId===pointer){sample(e,4);pointer=null;}updateHoverIndicator(e,false);}});
surface.addEventListener('lostpointercapture',e=>{if(e.pointerType==='pen'){penLog('LOSTCAP',e);if(e.pointerId===pointer){sample(e,4);pointer=null;}updateHoverIndicator(e,pointer===null);}});
surface.addEventListener('pointerleave',e=>{if(e.pointerType==='pen'){penLog('LEAVE',e);sample(e,4);if(e.pointerId===pointer)pointer=null;updateHoverIndicator(e,false);}});
surface.addEventListener('contextmenu',e=>e.preventDefault());
$('stop').onclick=()=>stop(); $('refresh').onclick=()=>refresh().catch(e=>status(e.message));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&socket)stop('切到背景，已停止輸入。');});
window.addEventListener('resize',()=>{
  if(!socket||stopping)return;
  if(regionEditing){
    send({type:'regionEditEnd',generation,commit:false});
    clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{
      if(socket&&!stopping&&surfaceChanged(sessionSurface,$('surface').getBoundingClientRect()))
        requestSession('偵測到 iPad 旋轉，正在重建工作階段。');
    },500);return;
  }
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if(socket&&!stopping&&surfaceChanged(sessionSurface,$('surface').getBoundingClientRect()))
      requestSession('偵測到 iPad 旋轉，正在重建工作階段。');
  },350);
});
window.addEventListener('pagehide',()=>stop());
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
refresh().catch(e=>status(e.message));
