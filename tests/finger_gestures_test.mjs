import assert from 'node:assert/strict';
import {FingerController,sensitivityFactor} from '../web-host/wwwroot/finger.mjs';

let events=[];const make=mode=>new FingerController(mode,e=>events.push(e));
let finger=make('trackpad');
assert.equal(finger.down(1,10,10,0),true);finger.move(1,15,13,20);finger.up(1,15,13,40);
assert.deepEqual(events.map(e=>e.action),['move','leftDown','leftUp'],'single-finger move and tap');

events=[];finger=make('trackpad');
finger.down(1,10,10,0);finger.up(1,10,10,40);finger.down(2,11,10,100);finger.up(2,11,10,130);
assert.deepEqual(events.map(e=>e.action),['leftDown','leftUp','leftDown','leftUp'],'double tap becomes Windows double click');

events=[];finger=make('trackpad');
finger.down(1,10,10,0);finger.up(1,10,10,40);finger.down(2,11,10,100);finger.move(2,40,20,140);finger.up(2,40,20,180);
assert.deepEqual(events.map(e=>e.action),['leftDown','leftUp','leftDown','move','leftUp'],'double-tap hold drags');

events=[];finger=make('trackpad');
finger.down(1,0,0,0);finger.down(2,20,0,10);finger.move(1,0,20,30);finger.move(2,20,20,40);finger.up(1,0,20,50);finger.up(2,20,20,60);
assert.ok(events.some(e=>e.action==='scroll'&&e.dy>0),'two-finger natural scroll');
assert.ok(!events.some(e=>e.action?.startsWith('right')),'moved two-finger gesture is not right click');

events=[];finger=make('trackpad');
finger.down(1,0,0,0);finger.down(2,20,0,10);finger.up(1,0,0,40);finger.up(2,20,0,50);
assert.deepEqual(events.map(e=>e.action),['rightDown','rightUp'],'two-finger tap is right click');

events=[];finger=make('trackpad');
finger.down(1,0,0,0);finger.up(1,0,0,20);finger.down(2,0,0,50);finger.cancelAll();
assert.equal(events.at(-1).action,'leftUp','cancel releases active drag');

events=[];finger=make('touch');
for(let i=1;i<=5;i++)assert.equal(finger.down(i,i,i,0),true);
assert.equal(finger.down(6,6,6,0),false,'sixth direct contact rejected');
finger.move(1,10,10,10);finger.up(1,10,10,20);finger.cancelAll();
assert.equal(events.filter(e=>e.phase===0).length,5);
assert.equal(events.filter(e=>e.phase===3).length,4,'remaining contacts cancelled');
assert.deepEqual([sensitivityFactor('slow'),sensitivityFactor('normal'),sensitivityFactor('fast')],[.75,1.25,2]);
console.log('Finger gesture checks passed: move, tap, double-click, drag, scroll, right-click, sensitivity, five-touch and cancellation');
