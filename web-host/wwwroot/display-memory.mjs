export function sanitizeDisplayMemory(value){
  if(!value||typeof value!=='object')return {};
  const result={};
  for(const mode of ['pen','mirror']){
    const id=value[mode];
    if(typeof id==='string'&&id.length>0&&id.length<=4096)result[mode]=id;
  }
  return result;
}

export function rememberedDisplay(memory,mode,displays){
  const id=mode==='pen'||mode==='mirror'?memory?.[mode]:undefined;
  return typeof id==='string'&&displays.some(display=>display.id===id)?id:'';
}
