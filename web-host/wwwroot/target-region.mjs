export const FULL_REGION=Object.freeze({x:0,y:0,width:1,height:1});
const MIN_SIZE=.1;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const clean=region=>Object.fromEntries(Object.entries(region).map(([key,value])=>[key,Math.round(value*1e6)/1e6]));

export function sanitizeRegion(value){
  if(!value||typeof value!=='object')return undefined;
  const region={x:Number(value.x),y:Number(value.y),width:Number(value.width),height:Number(value.height)};
  if(!Object.values(region).every(Number.isFinite)||region.x<0||region.y<0||
    region.width<MIN_SIZE||region.height<MIN_SIZE||region.x+region.width>1||region.y+region.height>1)return undefined;
  return region;
}

export function sanitizeRegionStore(value){
  if(!value||typeof value!=='object')return {};
  const result={};let count=0;
  for(const [id,valueRegion] of Object.entries(value)){
    if(++count>64)break;
    const region=sanitizeRegion(valueRegion);
    if(typeof id==='string'&&id.length>0&&id.length<=4096&&region)result[id]=region;
  }
  return result;
}

export function dragRegion(start,action,dx,dy){
  const region=sanitizeRegion(start)||FULL_REGION;
  if(!Number.isFinite(dx)||!Number.isFinite(dy))return {...region};
  if(action==='move')return clean({...region,x:clamp(region.x+dx,0,1-region.width),y:clamp(region.y+dy,0,1-region.height)});
  let left=region.x,top=region.y,right=region.x+region.width,bottom=region.y+region.height;
  if(action.includes('w'))left=clamp(left+dx,0,right-MIN_SIZE);
  if(action.includes('e'))right=clamp(right+dx,left+MIN_SIZE,1);
  if(action.includes('n'))top=clamp(top+dy,0,bottom-MIN_SIZE);
  if(action.includes('s'))bottom=clamp(bottom+dy,top+MIN_SIZE,1);
  return clean({x:left,y:top,width:right-left,height:bottom-top});
}
