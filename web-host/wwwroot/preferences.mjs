export function sanitizePreferences(value) {
  if(!value || typeof value!=='object')return {};
  const result={};
  const options={mode:['pen','mirror','extend'],mapping:['preserve','stretch'],fps:['30','60'],quality:['fast','balanced','high'],pressureCurve:['linear','soft','firm'],trackpadSensitivity:['slow','normal','fast']};
  for(const [key,allowed] of Object.entries(options))if(allowed.includes(value[key]))result[key]=value[key];
  for(const [key,min] of [['panelWidth',640],['panelHeight',480]]) {
    const n=Number(value[key]);if(Number.isInteger(n)&&n>=min&&n<=4096&&n%2===0)result[key]=String(n);
  }
  // Deliberately do not restore target identity, input authorization or finger mode.
  return result;
}
