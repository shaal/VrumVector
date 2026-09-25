// Recording your driving (H1) in the real app: real WASD key presses record
// samples at 1×, AI driving and a crash pause recording, a generation does not
// reset the car, and Stop saves to IndexedDB with the learning context.
import assert from 'node:assert/strict';
import {waitForServer} from './helpers/server-ready.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const out='test-results/demonstration';await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8889','--bind','127.0.0.1'],{stdio:'ignore'});
const origin='http://127.0.0.1:8889';let browser,page,stage='boot';const errors=[];
const mark=value=>{stage=value;console.log(stage);};
const state=()=>page.evaluate(()=>{
  const r=window.DemonstrationRecorder,root=document.getElementById('driver-learning'),button=root.querySelector('[data-demo-record]');
  return {recording:r.recording,progress:r.progress(),last:r.last&&{...r.last,done:undefined},simSpeed,
    speedDisabled:document.getElementById('simSpeedInput')?.disabled,speedTitle:document.getElementById('simSpeedInput')?.title,
    label:button.textContent,active:button.dataset.active,pressed:button.getAttribute('aria-pressed'),disabled:button.getAttribute('aria-disabled')==='true',
    status:root.querySelector('[data-demo-status]').textContent,live:root.querySelector('[data-demo-live]').textContent,
    badge:!root.querySelector('[data-demo-badge]').hidden,summary:root.querySelector('summary').textContent};
});
const samples=async()=>(await state()).progress?.samples??-1;
const waitSamples=n=>page.waitForFunction(n=>window.DemonstrationRecorder.progress()?.samples>=n,n);
// Samples of driving (without rest steps): a recording needs 60 of them to be saved.
const waitDriving=n=>page.waitForFunction(n=>{const r=window.DemonstrationRecorder;return r.progress()&&r.progress().samples-r.run.restSamples>=n;},n);
// Physics runs this many more steps, but the recorder adds no samples. Wait
// on steps, not time: a busy machine can go half a second without a frame.
const steady=async(steps=30)=>{
  const a=(await state()).progress;
  await page.waitForFunction(([from,n])=>window.DemonstrationRecorder.progress().steps>=from+n,[a.steps,steps]);
  const b=(await state()).progress;assert.equal(b.samples,a.samples,`no samples in ${b.steps-a.steps} paused steps`);
  return b.samples;
};
const records=()=>page.evaluate(async()=>{
  const {DemonstrationStore}=await import('/AI-Car-Racer/learning/demonstration.js');
  return (await new DemonstrationStore().list()).map(d=>({...d,inputs:d.inputs.length,keys:Array.from(d.keys),sampleSteps:d.sampleSteps.length,
    rest:d.rest&&Array.from(d.rest),restType:d.rest?.constructor.name,
    inputType:d.inputs.constructor.name,keyType:d.keys.constructor.name,stepType:d.sampleSteps.constructor.name,borders:d.track?.borders.length,gates:d.track?.checkPointList.length}));
});
try{
  await waitForServer(origin,server);
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1120,height:800}});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(()=>localStorage.setItem('vv.multiplayer',JSON.stringify({enabled:false,showDrivers:false})));
  await page.goto(`${origin}/AI-Car-Racer/`);
  await page.waitForFunction(()=>window.DemonstrationRecorder&&window.DriverLearning&&window.PlayerAssist?.info&&window.LiveSession);
  await page.waitForFunction(()=>window.__rvBridge?.info?.().ready,{},{timeout:90000});
  await page.evaluate(()=>window.__rvBridge.ready());

  mark('multiplayer blocks recording');
  await page.locator('#driver-learning summary').click();
  await page.evaluate(()=>window.LiveSession.setEnabled(true));
  // The Multiplayer panel may close this one; reopen it.
  if(!await page.evaluate(()=>document.getElementById('driver-learning').open))await page.locator('#driver-learning summary').click();
  await page.waitForFunction(()=>document.querySelector('[data-demo-record]').getAttribute('aria-disabled')==='true');
  let s=await state();
  assert.equal(s.status,'Turn off Multiplayer to record your driving.');assert.equal(s.recording,false);
  // A click on the unavailable button does nothing.
  await page.evaluate(()=>document.querySelector('[data-demo-record]').click());assert.equal((await state()).recording,false);
  await page.evaluate(()=>window.LiveSession.setEnabled(false));
  await page.waitForFunction(()=>document.querySelector('[data-demo-record]').getAttribute('aria-disabled')==='false');
  s=await state();assert.equal(s.status,'0 of 10 recordings saved in this browser.');assert.equal(s.label,'Record my driving');

  mark('stopping a recording that started at 1× unlocks the speed menu');
  // Turning multiplayer off leaves 1×, the most common start.
  assert.deepEqual([s.simSpeed,s.speedDisabled],[1,false]);
  await page.locator('[data-demo-record]').click();assert.equal((await state()).speedDisabled,true);
  await page.locator('[data-demo-record]').click();
  s=await state();assert.deepEqual([s.recording,s.simSpeed,s.speedDisabled,s.speedTitle],[false,1,false,'Simulation speed']);

  mark('recording forces 1× and waits for the car to move');
  // Short generations, so one ends while recording.
  await page.evaluate(()=>{setN(12);setSeconds(4);setSimSpeed(5);pauseGame();});
  await page.locator('[data-demo-record]').click();
  s=await state();
  assert.deepEqual([s.recording,s.simSpeed,s.speedDisabled,s.speedTitle,s.label,s.active,s.pressed,s.badge],
    [true,1,true,'Recording runs at 1×','Stop recording','true',null,true]);
  assert.match(s.summary,/· Recording$/);
  await page.waitForTimeout(600);s=await state();
  assert.equal(s.progress.samples,0);assert.equal(s.status,'Recording. Waiting for your car to move.');
  // A speed asked for while recording (a preset, demo mode) waits for Stop.
  await page.evaluate(()=>setSimSpeed(20));assert.equal((await state()).simSpeed,1,'the speed cannot change while recording');

  mark('real WASD key presses record samples');
  const car=await page.evaluate(()=>{window.__recordedCar=playerCar2;return presentationRunSerial;});
  await page.keyboard.down('w');await waitSamples(40);
  await page.keyboard.down('a');
  await page.waitForFunction(()=>{const r=window.DemonstrationRecorder.run;return r.keys.slice(0,r.samples).includes(3);});
  await page.keyboard.up('a');
  await page.keyboard.up('w');
  s=await state();assert.equal(s.status,'Recording your driving.');assert.match(s.live,/^\d+ samples · \d+\.\d s · 0 laps · \d+ checkpoints? · 0 crashes$/);
  const {keys,rest,restSpeed}=await page.evaluate(()=>{const r=window.DemonstrationRecorder.run;
    return {keys:Array.from(r.keys.slice(0,r.samples)),rest:Array.from(r.rest.slice(0,r.samples)),restSpeed:r.restSamples?r.inputs[7]:null};});
  // Up to 0.5 s of the parked car can come first (the page may start
  // stepping only when W is pressed), with the keys held (none), then W.
  const restRows=rest.indexOf(0);
  assert.ok(restRows>=0&&restRows<=30,`rest rows ${restRows}`);assert.ok(rest.slice(restRows).every(v=>v===0),'rest rows only before the first move');
  assert.ok(keys.slice(0,restRows).every(k=>k===0),'nothing held at rest');if(restRows)assert.equal(restSpeed,0,'at rest, speed is 0');
  assert.equal(keys[restRows]&1,1,'the first moving sample holds W');
  assert.ok(keys.some(k=>k===3),'W and A together');assert.ok(keys.every(k=>(k&12)===0),'no D or S was pressed');
  await page.screenshot({path:`${out}/recording-desktop.png`});

  mark('a generation ends without resetting your car');
  await page.waitForFunction(serial=>presentationRunSerial>serial,car,{timeout:30000});
  assert.equal(await page.evaluate(()=>playerCar2===window.__recordedCar),true);
  assert.equal(await page.evaluate(()=>window.DemonstrationRecorder.run.car===playerCar2),true,'the recorder still follows the same car');

  mark('AI driving pauses recording');
  await page.locator('#ai-drive-toggle').click();
  await page.waitForFunction(()=>window.DemonstrationRecorder.progress().reason==='ai');
  await page.keyboard.down('w');await steady();await page.keyboard.up('w');
  assert.equal((await state()).status,'Recording. Paused while AI driving is on.');
  await page.locator('#ai-drive-toggle').click();
  await page.keyboard.down('w');
  let resumed=await samples();await waitSamples(resumed+20);

  mark('losing the keyboard focus pauses recording');
  // Headless pages always have focus, so report the loss directly.
  const unfocused='Recording. Paused: WASD keys are not reaching your car. Click the track to go on.';
  await page.evaluate(()=>{document.hasFocus=()=>false;});
  await page.waitForFunction(()=>window.DemonstrationRecorder.progress().reason==='unfocused');
  await steady();assert.equal((await state()).status,unfocused);
  await page.evaluate(()=>{delete document.hasFocus;});
  resumed=await samples();await waitSamples(resumed+10);
  // Keys typed into the page's own controls do not drive the car either.
  await page.locator('#adaptive-learning').focus();
  await page.waitForFunction(()=>window.DemonstrationRecorder.progress().reason==='unfocused');
  await steady();assert.equal((await state()).status,unfocused);
  await page.locator('[data-demo-record]').focus();
  resumed=await samples();await waitSamples(resumed+10);

  mark('a crash pauses recording until the car moves again');
  // Full throttle into a wall, from a car that is driving (it may already have crashed).
  const crashes=(await (await page.waitForFunction(()=>!playerCar2.damaged&&window.DemonstrationRecorder.progress().reason===''&&
    window.DemonstrationRecorder.progress(),{},{timeout:20000})).jsonValue()).crashes;
  // Read at the step that crashed: the reset follows 40 steps later.
  const hit=await (await page.waitForFunction(()=>playerCar2.damaged&&{...window.DemonstrationRecorder.progress(),
    status:document.querySelector('[data-demo-status]').textContent},{},{timeout:20000})).jsonValue();
  await page.keyboard.up('w');
  assert.equal(hit.crashes,crashes+1);assert.equal(hit.reason,'damaged');
  assert.equal(hit.status,'Recording. Paused: your car crashed. Recording resumes when it moves again.');
  await page.waitForFunction(()=>!playerCar2.damaged&&playerCar2.x===playerCar2.origin.x);
  assert.equal(await steady(20),hit.samples,'no samples while damaged or parked after the reset');
  assert.equal((await state()).progress.reason,'idle');
  // Read before W: the parked car adds no samples until it moves.
  const reset=await samples(),restBefore=await page.evaluate(()=>window.DemonstrationRecorder.run.restSamples);
  await page.keyboard.down('w');await waitSamples(reset+15);
  // The 0.5 s parked after the reset is stored with the move: no keys, speed 0, then W.
  const restart=await page.evaluate(([from,before])=>{const r=window.DemonstrationRecorder.run,n=r.restSamples-before;
    return {n,rest:Array.from(r.rest.slice(from,from+n+1)),keys:Array.from(r.keys.slice(from,from+n+1)),speed:r.inputs[from*10+7],steps:Array.from(r.sampleSteps.slice(from,from+n+1))};},[reset,restBefore]);
  assert.ok(restart.n>=20&&restart.n<=30,`rest rows after the reset: ${restart.n}`);
  assert.deepEqual(restart.rest,[...Array(restart.n).fill(1),0]);assert.deepEqual(restart.keys.slice(0,-1),Array(restart.n).fill(0));
  assert.equal(restart.keys.at(-1)&1,1);assert.equal(restart.speed,0);
  assert.ok(restart.steps.every((v,i)=>!i||v===restart.steps[i-1]+1),'numbered as the steps right before the move');

  mark('the latest sample is what the network saw');
  const check=await page.evaluate(()=>{
    pauseGame(); // no more physics steps until Play
    const r=window.DemonstrationRecorder.run,n=r.samples,row=Array.from(r.inputs.slice((n-1)*10,n*10));
    return {n,row,last:Array.from(playerCar2.lastInputs),network:Array.from(playerCar2.brain.levels[0].inputs),key:r.keys[n-1],steps:r.step,at:r.sampleSteps[n-1]};
  });
  await page.keyboard.up('w');
  assert.deepEqual(check.row,check.last);assert.deepEqual(check.row,check.network);
  assert.equal(check.key,1);assert.equal(check.at,check.steps-1,'the last physics step was recorded');
  await page.waitForFunction(()=>document.querySelector('[data-demo-status]').textContent==='Recording. Press Play to drive.');

  mark('a pause breaks the step sequence, so lag pairs cannot span it');
  // At least one frame must see the pause (the page draws slowly under SwiftShader).
  await page.waitForFunction(()=>window.DemonstrationRecorder.run.interrupted===true);
  await page.evaluate(()=>pauseGame());await waitSamples(check.n+5);
  const jump=await page.evaluate(n=>{const r=window.DemonstrationRecorder.run;return [r.sampleSteps[n-2],r.sampleSteps[n-1],r.sampleSteps[n],r.sampleSteps[n+1]];},check.n);
  // Frames slower than 250 ms (a busy CI machine) can break the log at other steps too.
  assert.ok(jump[2]-jump[1]>=2,`a step number is skipped at the pause: ${jump}`);

  mark('Stop saves to IndexedDB with the learning context');
  await page.locator('[data-demo-record]').click();
  await page.waitForFunction(()=>window.DemonstrationRecorder.last?.saved===true);
  s=await state();
  assert.deepEqual([s.recording,s.simSpeed,s.speedDisabled,s.speedTitle,s.label,s.active,s.badge],[false,20,false,'Simulation speed','Record my driving','false',false],
    'Stop applies the speed asked for while recording');
  const crashText=crashes+1===1?'1 crash':`${crashes+1} crashes`;
  assert.ok(s.status.startsWith('Saved ')&&s.status.endsWith(`s, 0 laps, ${crashText}. 1 of 10 recordings saved in this browser.`),s.status);
  let saved=await records();assert.equal(saved.length,1);
  const [demo]=saved,live=await page.evaluate(()=>({context:window.DriverLearning.context,maxSpeed,traction,gates:road.checkPointList.length,borders:road.borders.length}));
  assert.equal(demo.samples,s.last.samples);assert.equal(demo.inputs,demo.samples*10);assert.equal(demo.keys.length,demo.samples);assert.equal(demo.sampleSteps,demo.samples);
  assert.deepEqual([demo.inputType,demo.keyType,demo.stepType],['Float32Array','Uint8Array','Uint32Array']);
  assert.equal(demo.context.track,live.context.track,'the same walls key as training');
  assert.deepEqual([demo.context.maxSpeed,demo.context.traction,demo.context.profile],[live.maxSpeed,live.traction,live.context.profile]);
  assert.deepEqual([demo.gates,demo.borders],[live.gates,live.borders]);
  assert.equal(demo.crashes,crashes+1);assert.equal(demo.crashSteps.length,crashes+1);assert.equal(demo.car,'WASD');assert.equal(demo.stopReason,'user');
  assert.ok(Number.isFinite(demo.createdAt)&&demo.endedAt>=demo.createdAt);
  assert.deepEqual(demo.keys,[...keys,...demo.keys.slice(keys.length)],'the stored keys start with the pressed keys');
  assert.equal(demo.version,2);assert.deepEqual([demo.restType,demo.rest.length],['Uint8Array',demo.samples]);
  assert.equal(demo.restSamples,demo.rest.filter(Boolean).length);assert.ok(demo.restSamples>=restRows,'the start and the restart after the crash');

  mark('the stored recording converts to the cloning dataset');
  // The record as IndexedDB returns it, converted in the page (H2).
  const converted=await page.evaluate(async()=>{
    const {DemonstrationStore}=await import('/AI-Car-Racer/learning/demonstration.js'),{demonstrationDataset}=await import('/AI-Car-Racer/learning/dataset.js');
    const [stored]=await new DemonstrationStore().list(),ds=demonstrationDataset(stored),mirrored=demonstrationDataset(stored,{mirror:true});
    const restForward=[];for(let i=0;i<stored.samples;i++)if(stored.rest[i])restForward.push(ds.keys[i*4]);
    return {report:ds.report,types:[ds.inputs,ds.keys,ds.episode].map(a=>a.constructor.name),restForward,
      mirrored:{rows:mirrored.report.rows,links:mirrored.sameSplitAs.filter(v=>v>=0).length}};
  });
  assert.deepEqual(converted.types,['Float32Array','Uint8Array','Uint32Array']);
  assert.equal(converted.report.rows,demo.samples);assert.equal(converted.report.restRows,demo.restSamples);assert.equal(converted.report.crashes,demo.crashes);
  assert.ok(converted.report.runs>=3,'breaks at the pauses and the crash');
  assert.ok(converted.restForward.length&&converted.restForward.every(v=>v===1),'rest rows get W, the key that moved the car');
  assert.deepEqual(converted.mirrored,{rows:2*demo.samples,links:demo.samples});

  mark('turning on multiplayer stops and saves a recording');
  await page.locator('[data-demo-record]').click();
  await page.keyboard.down('w');await waitDriving(70);await page.keyboard.up('w');
  await page.evaluate(()=>window.LiveSession.setEnabled(true));
  await page.waitForFunction(()=>window.DemonstrationRecorder.last?.saved===true);
  assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-demo-record]')),true,'focus stays on the unavailable button');
  assert.match(await page.evaluate(()=>document.querySelector('[data-demo-status]').textContent),
    /^Stopped: Multiplayer is on\. Saved .* recordings saved in this browser\. Turn off Multiplayer to record your driving\.$/,'the result, then why Record is unavailable');
  if(!await page.evaluate(()=>document.getElementById('driver-learning').open))await page.locator('#driver-learning summary').click();
  s=await state();
  assert.equal(s.recording,false);assert.equal(s.last.reason,'multiplayer');assert.equal(s.disabled,true);
  assert.equal(s.simSpeed,1,'multiplayer keeps 1×');
  await page.evaluate(()=>window.LiveSession.setEnabled(false));
  await page.waitForFunction(()=>document.querySelector('[data-demo-record]').getAttribute('aria-disabled')==='false');
  assert.match((await state()).status,/^Stopped: Multiplayer is on\. Saved \d+\.\d s, 0 laps, \d+ crash(es)?\. 2 of 10 recordings saved in this browser\.$/);
  assert.equal((await records()).length,2);

  mark('under a second of driving is not saved');
  await page.locator('[data-demo-record]').click();await page.locator('[data-demo-record]').click();
  assert.equal((await state()).status,'Not saved: less than 1 second of driving. 2 of 10 recordings saved in this browser.');
  assert.equal((await records()).length,2);

  mark('a physics change stops and saves a recording');
  await page.locator('[data-demo-record]').click();
  await page.keyboard.down('w');await waitDriving(70);
  await page.evaluate(()=>setMaxSpeed(10)); // rebuilds the cars with the new top speed
  await page.waitForFunction(()=>window.DemonstrationRecorder.last?.reason==='context'&&window.DemonstrationRecorder.last.saved===true);
  await page.keyboard.up('w');
  assert.match((await state()).status,/^Stopped: the track, physics, or driving style changed\. Saved \d+\.\d s, 0 laps, \d+ crash(es)?\. 3 of 10 recordings saved in this browser\.$/);
  saved=await records();assert.equal(saved.length,3);
  assert.deepEqual([saved[2].stopReason,saved[2].context.maxSpeed,saved[2].context.track],['context',15,demo.context.track],'saved with the old physics');
  await page.evaluate(()=>setMaxSpeed(15));

  mark('the A/B view hides the panel, so it stops and saves a recording');
  await page.evaluate(()=>setSimSpeed(5));await page.locator('[data-demo-record]').click();
  await page.keyboard.down('w');await waitDriving(70);await page.keyboard.up('w');
  await page.evaluate(()=>window.__abSetEnabled(true));
  await page.waitForFunction(()=>window.DemonstrationRecorder.last?.reason==='away'&&window.DemonstrationRecorder.last.saved===true);
  assert.equal(await page.evaluate(()=>simSpeed),5,'the speed before recording is back');
  await page.evaluate(()=>window.__abSetEnabled(false));
  await page.waitForFunction(()=>!window.PlayerAssist.root.hidden);
  if(!await page.evaluate(()=>document.getElementById('driver-learning').open))await page.locator('#driver-learning summary').click();
  assert.match((await state()).status,/^Stopped: you left the training view\. Saved .* 4 of 10 recordings saved in this browser\.$/);

  mark('the store keeps the newest 10');
  const cap=await page.evaluate(async()=>{
    const {DemonstrationStore}=await import('/AI-Car-Racer/learning/demonstration.js'),store=new DemonstrationStore(),results=[];
    const note=i=>({note:i,inputs:new Float32Array(10),keys:new Uint8Array(1),sampleSteps:new Uint32Array(1)});
    for(let i=0;i<8;i++)results.push(await store.save(note(i)));
    // A connection that closed without an event (as when site data is cleared) is replaced.
    store.connection.close();results.push(await store.save(note(8)));
    // Reading and pruning recover the same way.
    store.connection.close();const count=await store.count();
    store.connection.close();const notes=(await store.list()).map(d=>d.note??d.stopReason);
    store.connection.close();const pruned=await store.prune();
    return {results,count,notes,pruned};
  });
  assert.deepEqual(cap.results.map(r=>r.dropped),[0,0,0,0,0,0,1,1,1]);assert.equal(cap.count,10);
  assert.deepEqual(cap.notes,['away',0,1,2,3,4,5,6,7,8],'the oldest recordings were removed');assert.deepEqual(cap.pruned,{dropped:0,count:10});

  mark('closing the page keeps what was recorded');
  await page.locator('[data-demo-record]').click();
  await page.keyboard.down('w');await waitDriving(70);await page.keyboard.up('w');
  await page.reload();
  await page.waitForFunction(()=>window.DemonstrationRecorder&&window.DriverLearning);
  // The closing save skipped the cap (11 saved); loading the panel restores it.
  await page.locator('#driver-learning summary').click();
  await page.waitForFunction(()=>document.querySelector('[data-demo-status]').textContent===
    'The oldest recording was removed to keep the newest 10. 10 of 10 recordings saved in this browser. A new recording replaces the oldest.');
  saved=await records();
  assert.equal(saved.length,10);assert.equal(saved.at(-1).stopReason,'page');assert.ok(saved.at(-1).samples>=70);
  assert.equal(saved[0].note,0,'the oldest recording was removed');

  mark('Adaptive gates block recording');
  await page.evaluate(()=>window.AdaptiveGates.setEnabled(true));
  await page.waitForFunction(()=>document.querySelector('[data-demo-record]').getAttribute('aria-disabled')==='true');
  assert.equal((await state()).status,'Turn off Adaptive green gates (Experiments) to record your driving. They can move the gates between generations.');
  await page.evaluate(()=>window.AdaptiveGates.setEnabled(false));
  await page.waitForFunction(()=>document.querySelector('[data-demo-record]').getAttribute('aria-disabled')==='false');

  mark('mobile layout');
  await page.setViewportSize({width:390,height:844});
  assert.deepEqual(await page.evaluate(()=>[innerWidth,innerHeight]),[390,844],'the viewport change applied');
  await page.locator('[data-demo-record]').scrollIntoViewIfNeeded();
  const box=await page.locator('.learning-panel').boundingBox(),button=await page.locator('[data-demo-record]').boundingBox();
  assert.ok(box.x>=0&&box.x+box.width<=390,`panel ${JSON.stringify(box)}`);assert.ok(button.x>=box.x&&button.x+button.width<=box.x+box.width);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal page scroll');
  await page.screenshot({path:`${out}/panel-mobile.png`});

  assert.deepEqual(errors,[]);
  await writeFile(`${out}/result.json`,JSON.stringify({passed:true,first:{...demo,keys:demo.keys.length,rest:demo.rest?.length}},null,2));
  console.log('Demonstration browser checks passed');
}catch(error){
  await writeFile(`${out}/failure.json`,JSON.stringify({stage,error:String(error.stack),errors},null,2));
  await page?.screenshot({path:`${out}/failure.png`}).catch(()=>{});throw error;
}finally{await browser?.close();server.kill();}
