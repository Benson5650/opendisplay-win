'use strict';
const $ = id => document.getElementById(id);
let socket, generation = 0, sequence = 0, pointer = null, wakeLock, displays = [], heartbeat, ticketTimer;
const status = text => { $('status').textContent = text; };
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
  generation = 0; pointer = null; clearInterval(heartbeat);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'stop'}));
  socket?.close(); socket = undefined;
  wakeLock?.release().catch(()=>{}); wakeLock = undefined;
  document.body.classList.remove('writing'); $('tablet').hidden = true; $('settings').hidden = false;
  $('start').disabled = false; status(message);
}
$('start').onclick = async () => {
  const display = displays.find(d=>d.id === $('target').value);
  if (!display) { status('請先選擇目標螢幕。'); return; }
  $('start').disabled = true; $('tablet').hidden = false;
  document.body.classList.add('writing');
  $('destination').textContent = `Pen Tablet → ${display.name}`;
  const surface = $('surface').getBoundingClientRect();
  let width=surface.width, height=surface.height;
  if ($('mapping').value === 'preserve') {
    const scale=Math.min(width/display.width,height/display.height);
    width=display.width*scale; height=display.height*scale;
  }
  Object.assign($('activeArea').style,{width:`${width}px`,height:`${height}px`,left:`${(surface.width-width)/2}px`,top:`${(surface.height-height)/2}px`});
  const ws = new WebSocket(`${location.origin.replace('https:', 'wss:')}/control`); socket = ws;
  ws.onopen = () => send({type:'start',target:display.id,width:surface.width,height:surface.height,mapping:$('mapping').value});
  ws.onmessage = e => {
    if (socket !== ws) return;
    const m = JSON.parse(e.data);
    if (m.type === 'hello' && m.dryRun) $('destination').textContent += ' · 測試模式（不注入）';
    if (m.type === 'started') {
      if (!m.generation) { stop('目標螢幕或映射無效。'); return; }
      generation=m.generation; sequence=0;
      heartbeat=setInterval(()=>send({type:'heartbeat',generation}),500);
    }
    if (m.type === 'state' && m.state >= 2) stop('螢幕已變更或連線逾時，請重新選擇。');
    if (m.type === 'heartbeat' && !m.alive) stop('工作階段失效，請重新開始。');
  };
  ws.onerror = () => { if(socket===ws) stop('連線失敗；主機可能正由另一個裝置使用。'); };
  ws.onclose = () => { if(socket===ws) stop('主機已中斷連線。'); };
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
};
function sample(e, phase) {
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
window.addEventListener('resize',()=>{if(socket)stop('畫布大小已改變，請重新開始。');});
window.addEventListener('pagehide',()=>stop());
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
refresh().catch(e=>status(e.message));
