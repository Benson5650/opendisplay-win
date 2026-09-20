const TAP_MS=250,DOUBLE_MS=300,TAP_DISTANCE=10,DOUBLE_DISTANCE=24,MAX_TOUCHES=5;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const centroid=contacts=>{
  let x=0,y=0;for(const contact of contacts.values()){x+=contact.x;y+=contact.y;}
  return {x:x/contacts.size,y:y/contacts.size};
};

export const sensitivityFactor=value=>({slow:.75,normal:1.25,fast:2})[value]??1.25;

// Browser-only gesture recognizer. It emits semantic messages; generation,
// sequence, authorization and Windows injection remain host responsibilities.
export class FingerController {
  constructor(mode,emit){
    this.mode=mode;this.emit=emit;this.contacts=new Map();this.lastTap=null;
    this.primary=null;this.dragging=false;this.hadMulti=false;
    this.multiStarted=0;this.multiMoved=false;this.lastCentroid=null;
  }
  down(id,x,y,time){
    if(this.mode==='off'||this.contacts.has(id))return false;
    if(this.mode==='touch'){
      if(this.contacts.size>=MAX_TOUCHES)return false;
      const used=new Set([...this.contacts.values()].map(c=>c.contactId));
      let contactId=1;while(used.has(contactId))contactId++;
      this.contacts.set(id,{id,contactId,x,y,startX:x,startY:y,started:time,moved:false});
      this.emit({type:'directTouch',contactId,phase:0,x,y});return true;
    }
    if(this.mode!=='trackpad'||this.contacts.size>=2)return false;
    const contact={id,x,y,lastX:x,lastY:y,startX:x,startY:y,started:time,moved:false};
    this.contacts.set(id,contact);
    if(this.contacts.size===1){
      this.primary=id;this.hadMulti=false;
      if(this.lastTap&&time-this.lastTap.time<=DOUBLE_MS&&distance(contact,this.lastTap)<=DOUBLE_DISTANCE){
        this.dragging=true;this.lastTap=null;this.emit({type:'trackpad',action:'leftDown'});
      }
    }else{
      if(this.dragging){this.emit({type:'trackpad',action:'leftUp'});this.dragging=false;}
      this.lastTap=null;this.hadMulti=true;this.multiStarted=time;this.multiMoved=false;
      this.lastCentroid=centroid(this.contacts);
    }
    return true;
  }
  move(id,x,y,time){
    const contact=this.contacts.get(id);if(!contact)return false;
    if(this.mode==='touch'){
      contact.moved ||= Math.hypot(x-contact.startX,y-contact.startY)>TAP_DISTANCE;
      contact.x=x;contact.y=y;
      this.emit({type:'directTouch',contactId:contact.contactId,phase:1,x,y});return true;
    }
    const dx=x-contact.x,dy=y-contact.y;contact.lastX=contact.x;contact.lastY=contact.y;
    contact.x=x;contact.y=y;contact.moved ||= Math.hypot(x-contact.startX,y-contact.startY)>TAP_DISTANCE;
    if(this.contacts.size===1&&!this.hadMulti&&id===this.primary){
      if(dx||dy)this.emit({type:'trackpad',action:'move',dx,dy});
    }else if(this.contacts.size===2){
      const next=centroid(this.contacts),previous=this.lastCentroid??next;
      const scrollX=next.x-previous.x,scrollY=next.y-previous.y;
      if(scrollX||scrollY)this.emit({type:'trackpad',action:'scroll',dx:scrollX,dy:scrollY});
      this.lastCentroid=next;
      this.multiMoved ||= [...this.contacts.values()].some(c=>c.moved);
    }
    return true;
  }
  up(id,x,y,time,cancel=false){
    const contact=this.contacts.get(id);if(!contact)return false;
    if(this.mode==='touch'){
      this.emit({type:'directTouch',contactId:contact.contactId,phase:cancel?3:2,x,y});
      this.contacts.delete(id);return true;
    }
    contact.x=x;contact.y=y;
    contact.moved ||= Math.hypot(x-contact.startX,y-contact.startY)>TAP_DISTANCE;
    if(this.hadMulti){
      this.multiMoved ||= contact.moved;this.contacts.delete(id);
      if(this.contacts.size===0){
        if(!cancel&&!this.multiMoved&&time-this.multiStarted<=TAP_MS){
          this.emit({type:'trackpad',action:'rightDown'});
          this.emit({type:'trackpad',action:'rightUp'});
        }
        this.resetGesture();
      }
      return true;
    }
    this.contacts.delete(id);
    if(this.dragging){
      this.emit({type:'trackpad',action:'leftUp'});this.dragging=false;this.lastTap=null;
    }else if(!cancel&&!contact.moved&&time-contact.started<=TAP_MS){
      this.emit({type:'trackpad',action:'leftDown'});
      this.emit({type:'trackpad',action:'leftUp'});
      this.lastTap={time,x,y};
    }else this.lastTap=null;
    this.primary=null;return true;
  }
  cancelAll(){
    if(this.mode==='touch')for(const contact of this.contacts.values())
      this.emit({type:'directTouch',contactId:contact.contactId,phase:3,x:contact.x,y:contact.y});
    if(this.mode==='trackpad'&&this.dragging)this.emit({type:'trackpad',action:'leftUp'});
    this.contacts.clear();this.dragging=false;this.lastTap=null;this.resetGesture();
  }
  resetGesture(){
    this.primary=null;this.hadMulti=false;this.multiStarted=0;this.multiMoved=false;this.lastCentroid=null;
  }
}
