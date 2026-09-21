import assert from 'node:assert/strict';
import {dragRegion,FULL_REGION,sanitizeRegion,sanitizeRegionStore} from '../web-host/wwwroot/target-region.mjs';

assert.deepEqual(sanitizeRegion({x:.1,y:.2,width:.5,height:.6}),{x:.1,y:.2,width:.5,height:.6});
for(const bad of [null,{x:-.1,y:0,width:1,height:1},{x:0,y:0,width:.05,height:1},{x:.5,y:0,width:.6,height:1},{x:NaN,y:0,width:1,height:1}])assert.equal(sanitizeRegion(bad),undefined);
assert.deepEqual(dragRegion({x:.2,y:.2,width:.4,height:.4},'move',.1,-.1),{x:.3,y:.1,width:.4,height:.4});
assert.deepEqual(dragRegion({x:.8,y:.8,width:.2,height:.2},'move',.5,.5),{x:.8,y:.8,width:.2,height:.2});
assert.deepEqual(dragRegion({x:.2,y:.2,width:.4,height:.4},'nw',.1,.1),{x:.3,y:.3,width:.3,height:.3});
assert.deepEqual(dragRegion({x:.2,y:.2,width:.4,height:.4},'se',.2,.3),{x:.2,y:.2,width:.6,height:.7});
assert.deepEqual(dragRegion({x:.2,y:.2,width:.4,height:.4},'sw',-.5,.5),{x:0,y:.2,width:.6,height:.8});
assert.deepEqual(dragRegion({x:.2,y:.2,width:.4,height:.4},'ne',.8,-.5),{x:.2,y:0,width:.8,height:.6});
assert.deepEqual(dragRegion({x:.2,y:.2,width:.4,height:.4},'nw',.39,.39),{x:.5,y:.5,width:.1,height:.1});
assert.deepEqual(dragRegion(FULL_REGION,'move',.5,.5),FULL_REGION);
assert.deepEqual(sanitizeRegionStore({screen:{x:0,y:0,width:1,height:1},bad:{x:0,y:0,width:2,height:1}}),{screen:{x:0,y:0,width:1,height:1}});
console.log('15 Windows target-region checks passed');
