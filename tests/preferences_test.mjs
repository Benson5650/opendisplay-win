import assert from 'node:assert/strict';
import {sanitizePreferences} from '../web-host/wwwroot/preferences.mjs';
assert.deepEqual(sanitizePreferences(null),{});
assert.deepEqual(sanitizePreferences({mode:'mirror',quality:'high',fps:'60',target:'old-monitor',fingerMode:'touch',trackpadSensitivity:'fast'}),{mode:'mirror',fps:'60',quality:'high',trackpadSensitivity:'fast'});
assert.deepEqual(sanitizePreferences({mode:'invalid',fps:'120',panelWidth:4097,panelHeight:0}),{});
assert.deepEqual(sanitizePreferences({panelWidth:2360,panelHeight:'1640',pressureCurve:'soft'}),{pressureCurve:'soft',panelWidth:'2360',panelHeight:'1640'});
assert.deepEqual(sanitizePreferences({panelWidth:641,panelHeight:Infinity}),{});
console.log('5 preference validation checks passed');
