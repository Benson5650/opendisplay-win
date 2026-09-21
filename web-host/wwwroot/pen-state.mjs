// Reconcile missing pointerdown/up using the current event, not older coalesced
// samples. Explicit pointerdown remains authoritative for zero-pressure tips.
export function penTransition(activeId,event){
  const contact=(event.buttons&1)!==0||event.pressure>0;
  const phases=[];
  if(activeId!==null&&activeId!==event.pointerId){
    if(!contact)return {pointer:activeId,phases};
    phases.push(4);activeId=null;
  }
  if(contact){
    phases.push(activeId===null?0:1);
    return {pointer:event.pointerId,phases};
  }
  if(activeId!==null)phases.push(2);
  phases.push(3);
  return {pointer:null,phases};
}
