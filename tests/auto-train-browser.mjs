// Auto Train in the real app: the toggle applies Fresh, real generations reach
// the policy through performNextBatch, a phase change lands before the next
// generation is built, and any user change to the training knobs turns it off.
import assert from 'node:assert/strict';
import {waitForServer} from './helpers/server-ready.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const out='test-results/auto-train';await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8886','--bind','127.0.0.1'],{stdio:'ignore'});
const origin='http://127.0.0.1:8886';let browser,page,stage='boot';const errors=[];
const mark=value=>{stage=value;console.log(stage);};
const knobs=()=>page.evaluate(()=>({N:batchSize,seconds:Number(nextSeconds),mutate:Number(mutateValue),simSpeed,conservativeInit,
  on:window.AutoTrain.enabled,phase:window.AutoTrain.policy.phase,pressed:document.getElementById('autoTrainToggle').getAttribute('aria-pressed'),
  label:document.getElementById('autoTrainToggle').textContent,status:document.getElementById('autoTrainStatus').textContent,
  lock:!document.getElementById('autoTrainLock').hidden,locked:document.getElementById('trainingTuning').classList.contains('auto-locked'),
  active:[...document.querySelectorAll('#trainingPresets .auto-active')].map(b=>b.dataset.preset)}));
const enable=async()=>{await page.locator('#autoTrainToggle').click();assert.equal((await knobs()).on,true);};
try{
  await waitForServer(origin,server);
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1120,height:800}});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  // Solo training with the control panel open (it starts collapsed).
  await page.addInitScript(()=>{localStorage.setItem('vv.multiplayer',JSON.stringify({enabled:false,showDrivers:false}));localStorage.setItem('vv.panelCollapsed','0');});
  await page.goto(`${origin}/AI-Car-Racer/`);
  await page.waitForFunction(()=>window.AutoTrain&&window.DriverLearning&&document.getElementById('autoTrainToggle'));
  // The Vector Memory panel mounts late and shifts the training panel; wait for it.
  await page.waitForFunction(()=>window.__rvBridge?.info?.().ready,{},{timeout:90000});
  await page.evaluate(()=>window.__rvBridge.ready());

  mark('off by default');
  let k=await knobs();
  assert.deepEqual([k.on,k.pressed,k.label,k.status,k.lock,k.locked,k.active],[false,'false','🤖 Auto Train: off','',false,false,[]]);

  mark('turning it on applies Fresh and locks the tuning controls');
  await page.locator('#trainingTuning summary').click();
  await enable();k=await knobs();
  assert.deepEqual({N:k.N,seconds:k.seconds,mutate:k.mutate,simSpeed:k.simSpeed,conservativeInit:k.conservativeInit},{N:500,seconds:15,mutate:.25,simSpeed:2,conservativeInit:.7});
  assert.deepEqual([k.pressed,k.label,k.lock,k.locked,k.active],['true','🤖 Auto Train: on',true,true,['fresh']]);
  assert.match(k.status,/^Auto Train · 🌱 Fresh\. Turned on\. Next: 🏎️ Grind when a car passes a checkpoint\.$/);
  const locks=await page.evaluate(()=>[...['batchSize','seconds','mutateValue','conservativeInit'].map(id=>document.getElementById(id+'Output')),
    document.querySelector('#simSpeedLabel > span')].map(el=>getComputedStyle(el,'::after').content));
  assert.deepEqual(locks,Array(5).fill('" 🔒"'),'every control a preset sets shows the lock');
  const fill=await page.evaluate(()=>getComputedStyle(document.getElementById('secondsInput')).getPropertyValue('--fill').trim());
  assert.equal(fill,((15-5)/(100-5)*100).toFixed(2)+'%','the slider fill follows the preset value');
  await page.screenshot({path:`${out}/auto-train-on-desktop.png`});

  mark('real generations reach the policy, and a phase change lands before the next generation is built');
  await page.evaluate(()=>{
    // Code-set values fire no input events, so Auto Train stays on. A small,
    // short population keeps the check fast.
    setN(40);setSeconds(4);setSimSpeed(5);
    window.__autoCalls=[];const original=window.AutoTrain.onGeneration.bind(window.AutoTrain);
    window.AutoTrain.onGeneration=result=>{
      // record() must already hold this generation, so its health reading is current.
      const last=window.DriverLearning.coach.history.at(-1);
      const recorded=!!last&&last.fitness===result.fitness&&Math.abs(last.survival-result.popStillAlive/result.popN)<1e-9;
      const from=window.AutoTrain.policy.phase,to=original(result);
      window.__autoCalls.push({from,to,recorded,fitness:result.fitness,laps:result.laps,serial:presentationRunSerial,N:batchSize,seconds:Number(nextSeconds)});return to;};
    pauseGame();
  });
  assert.equal((await knobs()).on,true,'programmatic setters do not turn Auto Train off');
  await page.waitForFunction(()=>window.__autoCalls.some(c=>c.to==='grind'),{},{timeout:120000});
  const calls=await page.evaluate(()=>window.__autoCalls);
  for(const call of calls){assert.ok(Number.isFinite(call.fitness)&&call.fitness>=1,'real generation results (the start gate counts)');
    assert.ok(call.recorded,`the hook runs after DriverLearning.record: ${JSON.stringify(call)}`);
    assert.equal(call.to==='grind',call.from==='fresh'&&call.fitness>=2,`fresh→grind exactly at the first checkpoint past the start: ${JSON.stringify(call)}`);}
  const change=calls.find(c=>c.to==='grind');
  assert.deepEqual([change.N,change.seconds],[600,15],'the Grind preset is applied in the generation hook');
  // The generation after the change is built with Grind's population and round length.
  // (The weights buffer is transferred to the worker, so count the per-car parent list.)
  await page.waitForFunction(serial=>presentationRunSerial>serial&&window.DriverLearning.batch?.parents.length===600,change.serial);
  const built=await page.evaluate(()=>({cars:window.DriverLearning.batch.parents.length,seconds:window.DriverLearning.context.seconds,simSpeed}));
  assert.deepEqual(built,{cars:600,seconds:15,simSpeed:20});
  k=await knobs();assert.equal(k.phase,'grind');assert.deepEqual(k.active,['grind']);
  assert.match(k.status,/🏎️ Grind\. A car passed a checkpoint\. Next: ✨ Polish when a car completes a lap\./);
  await page.evaluate(()=>{if(!pause)pauseGame();delete window.AutoTrain.onGeneration;});

  mark('a lap moves to Polish, a plateau bounces to Grind, and Grind stays before returning');
  // Laps and 20-generation plateaus take too long for a browser check; the
  // controller gets those results directly, with the health reading it would see.
  const cycle=await page.evaluate(()=>{
    const A=window.AutoTrain,L=window.DriverLearning,snap=()=>({phase:A.policy.phase,N:batchSize,seconds:Number(nextSeconds),mutate:Number(mutateValue),simSpeed});
    const out={};A.onGeneration({fitness:9,laps:1});out.polish=snap();
    L.healthState={state:'Stuck',sinceProgress:25};
    for(let i=1;i<20;i++)A.onGeneration({fitness:9,laps:1});out.beforeBounce=snap();
    A.onGeneration({fitness:9,laps:1});out.bounced=snap();out.status=document.getElementById('autoTrainStatus').textContent;
    L.healthState=null;for(let i=1;i<8;i++)A.onGeneration({fitness:9,laps:1});out.stayed=snap();
    A.onGeneration({fitness:9,laps:1});out.back=snap();return out;
  });
  assert.deepEqual(cycle.polish,{phase:'polish',N:800,seconds:25,mutate:.05,simSpeed:2});
  assert.equal(cycle.beforeBounce.phase,'polish','19 generations in Polish do not bounce');
  assert.deepEqual(cycle.bounced,{phase:'grind',N:600,seconds:15,mutate:.18,simSpeed:20});
  assert.match(cycle.status,/Plateau: no gain for 20 generations in Polish\. Next: ✨ Polish after a lap, once Grind has run 8 generations\./);
  assert.equal(cycle.stayed.phase,'grind');assert.equal(cycle.back.phase,'polish');

  mark('a knob changed by other code (multiplayer forces 1×) is restored at the next generation');
  const drift=await page.evaluate(()=>{setSimSpeed(1);const on=window.AutoTrain.enabled;window.AutoTrain.onGeneration({fitness:9,laps:1});return {on,simSpeed,phase:window.AutoTrain.policy.phase};});
  assert.deepEqual(drift,{on:true,simSpeed:2,phase:'polish'});

  mark('a new track starts again at Fresh before its first generation is built');
  const retrack=await page.evaluate(()=>{
    window.__switchTrackInMemory('Triangle');phaseToLayout(4);
    return {phase:window.AutoTrain.policy.phase,reason:window.AutoTrain.policy.reason,N:batchSize,seconds:Number(nextSeconds)};
  });
  assert.equal(retrack.phase,'fresh');assert.match(retrack.reason,/New track/);assert.deepEqual([retrack.N,retrack.seconds],[500,15]);
  await page.evaluate(()=>{if(!pause)pauseGame();});
  // The re-render closed the tuning section.
  await page.locator('#trainingTuning summary').click();

  mark('moving a slider turns Auto Train off and keeps the new value');
  await page.locator('#batchSizeInput').focus();await page.keyboard.press('ArrowRight');
  k=await knobs();
  assert.deepEqual([k.on,k.pressed,k.lock,k.locked,k.active,k.N],[false,'false',false,false,[],501],'Fresh set 500; the key press added 1');
  assert.equal(k.status,'Auto Train off: you changed a training setting.');

  mark('choosing a preset turns Auto Train off and applies that preset');
  await enable();assert.equal((await knobs()).phase,'fresh','turning it on again starts at Fresh');
  await page.locator('#trainingPresets [data-preset="polish"]').click();
  k=await knobs();assert.deepEqual([k.on,k.N,k.seconds,k.mutate],[false,800,25,.05]);
  assert.equal(k.status,'Auto Train off: you chose ✨ Polish.');

  mark('the variance slider (mouse only) and the sim-speed select turn Auto Train off');
  await enable();
  await page.locator('#mutateValueInput').scrollIntoViewIfNeeded();
  const variance=await page.locator('#mutateValueInput').boundingBox();
  await page.mouse.click(variance.x+variance.width*.15,variance.y+variance.height/2); // away from the thumb (0.25 sits at 83%)
  k=await knobs();assert.equal(k.on,false);assert.ok(k.mutate<.1,`variance ${k.mutate}`);
  await enable();
  await page.locator('#simSpeedInput').focus();await page.keyboard.press('5'); // type-ahead picks 5×; ArrowDown opens the popup on macOS
  k=await knobs();assert.equal(k.on,false,'keyboard change of the sim-speed select');assert.equal(k.simSpeed,5);

  mark('the small-population buttons turn Auto Train off');
  await enable();await page.getByRole('button',{name:'3 AI cars',exact:true}).click();
  k=await knobs();assert.deepEqual([k.on,k.N],[false,3]);

  mark('the panel re-render keeps the Auto Train state');
  await enable();await page.evaluate(()=>phaseToLayout(4));
  k=await knobs();assert.deepEqual([k.on,k.pressed,k.lock,k.locked,k.active],[true,'true',true,true,['fresh']]);

  mark('mobile layout');
  await page.setViewportSize({width:390,height:844});
  const box=await page.locator('#autoTrainToggle').boundingBox(),status=await page.locator('#autoTrainStatus').boundingBox();
  assert.ok(box&&box.x>=0&&box.x+box.width<=390,`toggle ${JSON.stringify(box)}`);assert.ok(status&&status.x+status.width<=390);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal page scroll');
  await page.locator('#autoTrainToggle').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/auto-train-on-mobile.png`});
  await page.setViewportSize({width:1120,height:800});

  mark('demo mode turns Auto Train off');
  await page.locator('#demoModeBtn').click();
  k=await knobs();assert.equal(k.on,false);assert.equal(k.status,'Auto Train off: demo mode sets its own training values.');

  mark('a click before the Auto Train module loads is kept');
  const slow=await browser.newPage({viewport:{width:1120,height:800}});
  slow.on('pageerror',error=>errors.push(error.stack||error.message));
  // Hold the module until after the click.
  let release;const held=new Promise(resolve=>{release=resolve;});
  await slow.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort();
    if(url.pathname.endsWith('/learning/autoTrain.js'))await held;
    return route.continue();
  });
  await slow.addInitScript(()=>{localStorage.setItem('vv.multiplayer',JSON.stringify({enabled:false,showDrivers:false}));localStorage.setItem('vv.panelCollapsed','0');});
  // Module scripts delay DOMContentLoaded and load; the panel is drawn before them.
  await slow.goto(`${origin}/AI-Car-Racer/`,{waitUntil:'commit'});
  await slow.waitForSelector('#autoTrainToggle',{state:'visible'});
  assert.equal(await slow.evaluate(()=>!!window.AutoTrain),false,'the module is still loading');
  await slow.locator('#autoTrainToggle').click();
  assert.deepEqual(await slow.evaluate(()=>{const b=document.getElementById('autoTrainToggle');return [b.textContent,b.getAttribute('aria-pressed')];}),
    ['🤖 Auto Train: on','true'],'the click shows at once');
  release();
  await slow.waitForFunction(()=>window.AutoTrain?.enabled===true,{},{timeout:60000});
  assert.equal(await slow.evaluate(()=>batchSize),500);
  await slow.close();
  // A preset chosen before the module loads cancels the pending click.
  const slow2=await browser.newPage({viewport:{width:1120,height:800}});
  let release2;const held2=new Promise(resolve=>{release2=resolve;});
  await slow2.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(url.pathname.endsWith('/learning/autoTrain.js'))await held2;return route.continue();});
  await slow2.addInitScript(()=>{localStorage.setItem('vv.multiplayer',JSON.stringify({enabled:false,showDrivers:false}));localStorage.setItem('vv.panelCollapsed','0');});
  await slow2.goto(`${origin}/AI-Car-Racer/`,{waitUntil:'commit'});
  await slow2.waitForSelector('#autoTrainToggle',{state:'visible'});
  await slow2.locator('#autoTrainToggle').click();await slow2.locator('#trainingPresets [data-preset="polish"]').click();release2();
  await slow2.waitForFunction(()=>!!window.AutoTrain,{},{timeout:60000});
  assert.deepEqual(await slow2.evaluate(()=>[window.AutoTrain.enabled,batchSize,document.getElementById('autoTrainToggle').getAttribute('aria-pressed')]),[false,800,'false']);
  await slow2.close();

  assert.deepEqual(errors,[]);
  await writeFile(`${out}/result.json`,JSON.stringify({passed:true,calls,built},null,2));
  console.log('Auto Train browser checks passed');
}catch(error){
  await writeFile(`${out}/failure.json`,JSON.stringify({stage,error:String(error.stack),errors},null,2));
  await page?.screenshot({path:`${out}/failure.png`}).catch(()=>{});throw error;
}finally{await browser?.close();server.kill();}
