import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SnapshotBuffer, ReplayArchive, sampleRun, interpolatePose, pointInLoop, cleanLoop, seededRandom, distanceToLoop } from '../AI-Car-Racer/graphics/state.js';
import { createRoadGeometry } from '../AI-Car-Racer/graphics/world.js';

const snapshot=(frame,x,angle=0)=>({frameCount:frame,N:1,positions:new Float32Array([x,200,angle,0,2])});
const presetSource=await readFile(new URL('../AI-Car-Racer/trackPresets.js',import.meta.url),'utf8');
const presetContext=vm.createContext({window:{}});
vm.runInContext(presetSource.slice(0,presetSource.indexOf('\n];')+3),presetContext);
for(const preset of presetContext.window.TRACK_PRESETS){
  test(`3D road triangles stay inside the ${preset.name} collision corridor`,()=>{
    const g=createRoadGeometry(preset.points2,preset.points),p=g.attributes.position,idx=g.index.array;
    let area=0;
    for(let i=0;i<idx.length;i+=3){
      const [a,b,c]=[idx[i],idx[i+1],idx[i+2]];
      const triangleArea=Math.abs((p.getX(b)-p.getX(a))*(p.getZ(c)-p.getZ(a))-(p.getZ(b)-p.getZ(a))*(p.getX(c)-p.getX(a)))/2;
      // Earcut may retain zero-area faces on collinear boundary vertices.
      if(triangleArea<1e-8)continue;
      const cx=(p.getX(a)+p.getX(b)+p.getX(c))/3/.035+1600;
      const cy=(p.getZ(a)+p.getZ(b)+p.getZ(c))/3/.035+900;
      assert.ok(pointInLoop(cx,cy,preset.points2)&&!pointInLoop(cx,cy,preset.points),`triangle at ${cx},${cy}`);
      area+=triangleArea;
      assert.ok(g.attributes.normal.getY(a)>.99);
    }
    const polygonArea=loop=>Math.abs(loop.reduce((s,a,i)=>{const b=loop[(i+1)%loop.length];return s+a.x*b.y-b.x*a.y;},0)/2);
    const expected=(polygonArea(preset.points2)-polygonArea(preset.points))*.035**2;
    assert.ok(Math.abs(area-expected)<.01,`area ${area} versus ${expected}`);g.dispose();
  });
}
test('heading interpolation takes the short turn across the ±π seam',()=>{
  const p=interpolatePose({x:0,y:0,angle:Math.PI-.1},{x:10,y:20,angle:-Math.PI+.1},.5);
  assert.ok(Math.abs(p.angle-Math.PI)<1e-6);assert.equal(p.x,5);assert.equal(p.y,10);
});
test('snapshot interpolation never crosses a manual restart or a large training jump',()=>{
  const b=new SnapshotBuffer();b.push(snapshot(10,100),1,0);b.push(snapshot(12,120),1,20);
  assert.equal(b.pose(0,30).x,110);
  b.push(snapshot(0,1800),2,40);assert.equal(b.pose(0,41).x,1800);
  b.push(snapshot(100,2200),2,60);assert.equal(b.pose(0,61).x,2200);
  assert.equal(b.pose(-1,70),null);assert.equal(b.pose(1,70),null);
});
test('road membership preserves the original corridor and irregular vertices',()=>{
  const outer=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:6,y:7},{x:0,y:10}];
  const inner=[{x:3,y:3},{x:7,y:3},{x:5,y:6}];
  assert.equal(pointInLoop(1,5,outer)&&!pointInLoop(1,5,inner),true);
  assert.equal(pointInLoop(5,4,inner),true);
  assert.equal(pointInLoop(12,5,outer),false);
  assert.equal(distanceToLoop(-2,4,[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]),2);
  assert.deepEqual(cleanLoop([...outer,outer[0]]),outer);
});
test('scenery uses a private deterministic random stream',()=>{
  const a=seededRandom('oval'),b=seededRandom('oval'),c=seededRandom('triangle');
  const first=Array.from({length:10},a);assert.deepEqual(first,Array.from({length:10},b));assert.notDeepEqual(first,Array.from({length:10},c));
});
test('replay scrubbing handles endpoints, control bits, and exact timing',()=>{
  const run={samples:new Float32Array([0,10,20,0,3,3,0,60,70,80,1,6,4,0,120,130,140,2,0,0,1])};
  assert.equal(sampleRun(run,-10).x,10);assert.equal(sampleRun(run,.5).x,40);
  assert.equal(sampleRun(run,.5).controls,3);assert.equal(sampleRun(run,20).x,130);
  assert.equal(sampleRun(run,20).damaged,true);assert.equal(sampleRun(run,1).controls,4);
  assert.equal(sampleRun(null,0),null);
});
test('archive stays bounded and cannot show ghosts from a different track',()=>{
  const a=new ReplayArchive();a.setTrack('oval');
  for(let i=0;i<20;i++)a.add({generation:i,samples:new Float32Array([0,0,0,0,0,0,0,60,1,1,0,0,0,0])});
  assert.equal(a.runs.length,6);assert.equal(a.runs[0].generation,19);
  a.setTrack('oval');assert.equal(a.runs.length,6);a.setTrack('triangle');assert.equal(a.runs.length,0);
});

const context=vm.createContext({});vm.runInContext(await readFile(new URL('../AI-Car-Racer/graphics/recorder.js',import.meta.url),'utf8'),context);
const Recorder=context.PresentationRecorder;
const car=(i)=>({x:i,y:i*2,angle:0,speed:3,controls:{forward:true,left:i===0},damaged:false,checkPointsCount:0,laps:0});
test('recording is optional, memory bounded, and chooses one actual driver',()=>{
  const cars=Array.from({length:10000},(_,i)=>car(i));const off=new Recorder(cars,false);
  off.capture(0,true);assert.equal(off.entries.length,0);assert.equal(off.finish(5),null);
  const r=new Recorder(cars,true);assert.equal(r.entries.length,16);
  const before=JSON.stringify(cars);r.capture(0,true);assert.equal(JSON.stringify(cars),before);
  cars.at(-1).checkPointsCount=9;
  for(let f=1;f<8000;f++){cars.at(-1).x=f;r.capture(f);}
  const run=r.finish(5);assert.equal(run.driverIndex,9999);assert.equal(run.truncated,true);
  assert.equal(run.samples.length,2401*7);assert.equal(run.samples[1],9999);assert.equal(run.samples[8],3);
  assert.equal(run.samples.at(-7),7200);
});
