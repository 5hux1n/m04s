const assert = require('node:assert/strict');
const {geometry} = require('../public/assets/shipping-label.js');
for (const [width,height] of [[76,130],[100,180]]) {
  const g=geometry({labelWidth:width,labelHeight:height},1248,width*10,height*10);
  assert.equal(g.width,1248);assert.equal(g.height,Math.round(height*300/25.4));
  assert.ok(g.x>=0 && g.y>=0);
  assert.ok(g.x+g.drawWidth<=g.width && g.y+g.drawHeight<=g.height+1e-8);
  assert.ok(Math.abs(g.drawWidth/g.drawHeight-width/height)<1e-9);
}
const landscape=geometry({labelWidth:76,labelHeight:130,labelInset:2},1248,2000,1000);
assert.equal(landscape.drawWidth/landscape.drawHeight,2);
assert.ok(landscape.y>0);assert.ok(landscape.drawWidth<76*300/25.4);
assert.throws(()=>geometry({labelWidth:76,labelHeight:130},848,760,1300),/超过/);
for(const layout of [{labelWidth:NaN,labelHeight:130},{labelWidth:106,labelHeight:130},{labelWidth:76,labelHeight:0},{labelWidth:76,labelHeight:130,labelInset:11}])assert.throws(()=>geometry(layout,1248,100,100));
assert.throws(()=>geometry({labelWidth:20,labelHeight:30,labelInset:10},1248,100,100));
console.log('Shipping label geometry passed: physical size, aspect ratio, margins, narrow-paper rejection, invalid dimensions.');
