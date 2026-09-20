import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),origin='https://127.0.0.1:19445';
const store=resolve(root,'host-data-test',`pairing-${randomUUID()}.json`);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,log;
async function start(){
 log='';child=spawn('dotnet',[resolve(root,'web-host/bin/Release/net10.0-windows/OpenDisplay.Web.dll'),'--ip','127.0.0.1','--port','19445','--cert',resolve(root,'host-data-test/host.pfx'),'--dry-run','true','--pairing-store',store],{cwd:resolve(root,'web-host'),stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',d=>log+=d);child.stderr.resume();
 for(let i=0;i<100;i++){if(log.includes('Pairing code:')){try{await fetch(origin);return;}catch{}}await delay(50);}throw Error('Startup failed');
}
async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.stdin.write('quit\n');await Promise.race([exited,delay(4000)]);if(child.exitCode===null){child.kill();await exited;}}
const post=(path,data,headers={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
async function pair(code){
 const ticket=await (await post('/pair',{code})).json();
 child.stdin.write('approve\n');
 for(let i=0;i<100;i++){
  const result=await post('/pair/status',ticket);assert.equal(result.status,200);
  if((await result.clone().json()).ready)return result.headers.get('set-cookie');
  await delay(20);
 }
 throw Error('Pair approval timed out');
}
try{
 await start();
 const code=log.match(/Pairing code: ([A-F0-9]+)/)[1];
 const cookie=await pair(code);assert.match(cookie,/expires=/i);
 const auth=cookie.split(';')[0];
 child.stdin.write('pair\n');
 const oldCode=code;
 for(let i=0;i<100;i++){
  const codes=[...log.matchAll(/Pairing code: ([A-F0-9]+)/g)].map(m=>m[1]);
  if(codes.at(-1)!==oldCode)break;
  await delay(20);
 }
 await delay(1000); // pairing endpoint intentionally rate-limits attempts
 const secondCode=[...log.matchAll(/Pairing code: ([A-F0-9]+)/g)].at(-1)[1];
 const secondAuth=(await pair(secondCode)).split(';')[0];
 const stored=await readFile(store,'utf8');
 assert.ok(!stored.includes(auth.split('=')[1])&&!stored.includes(secondAuth.split('=')[1]),'raw tokens must not be stored');
 await stop();await start();
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:auth}})).status,200,'paired device survives restart');
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:secondAuth}})).status,200,'second paired device survives restart');
 const forgotten=await post('/unpair',{}, {Cookie:auth});
 assert.equal(forgotten.status,200,'device can forget its own pairing');
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:auth}})).status,401,'forgotten device is revoked immediately');
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:secondAuth}})).status,200,'forgetting one device preserves other devices');
 await stop();await start();
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:auth}})).status,401,'individual revocation survives restart');
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:secondAuth}})).status,200,'unrevoked device remains paired after restart');
 child.stdin.write('revoke\n');
 for(let i=0;i<100&&!log.includes('sessions revoked');i++)await delay(20);
 await stop();await start();
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:secondAuth}})).status,401,'global revocation survives restart');
 console.log('Pairing restart, per-device/global revocation, persistent cookie and hashed storage checks passed');
}finally{await stop();}
