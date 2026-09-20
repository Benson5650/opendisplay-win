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
const post=(path,data)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
try{
 await start();
 const code=log.match(/Pairing code: ([A-F0-9]+)/)[1];
 const ticket=await (await post('/pair',{code})).json();
 child.stdin.write('approve\n');
 for(let i=0;i<100&&!log.includes('device approved');i++)await delay(20);
 const result=await post('/pair/status',ticket);assert.equal(result.status,200);
 const cookie=result.headers.get('set-cookie');assert.match(cookie,/expires=/i);
 const auth=cookie.split(';')[0];
 assert.ok(!(await readFile(store,'utf8')).includes(auth.split('=')[1]),'raw token must not be stored');
 await stop();await start();
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:auth}})).status,200,'paired device survives restart');
 child.stdin.write('revoke\n');
 for(let i=0;i<100&&!log.includes('sessions revoked');i++)await delay(20);
 await stop();await start();
 assert.equal((await fetch(origin+'/displays',{headers:{Cookie:auth}})).status,401,'revocation survives restart');
 console.log('Pairing restart, persisted revocation, persistent cookie and hashed storage checks passed');
}finally{await stop();}
