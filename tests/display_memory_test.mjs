import assert from 'node:assert/strict';
import {rememberedDisplay,sanitizeDisplayMemory} from '../web-host/wwwroot/display-memory.mjs';

const displays=[{id:'monitor-a'},{id:'monitor-b'}];
assert.deepEqual(sanitizeDisplayMemory(null),{});
assert.deepEqual(sanitizeDisplayMemory({pen:'monitor-a',mirror:'monitor-b',extend:'ignored'}),{pen:'monitor-a',mirror:'monitor-b'});
assert.deepEqual(sanitizeDisplayMemory({pen:'',mirror:42}),{});
assert.deepEqual(sanitizeDisplayMemory({pen:'x'.repeat(4097)}),{});
assert.equal(rememberedDisplay({pen:'monitor-a'},'pen',displays),'monitor-a');
assert.equal(rememberedDisplay({mirror:'monitor-b'},'mirror',displays),'monitor-b');
assert.equal(rememberedDisplay({pen:'missing'},'pen',displays),'');
assert.equal(rememberedDisplay({pen:'monitor-a'},'extend',displays),'');
console.log('8 last-display memory checks passed');
