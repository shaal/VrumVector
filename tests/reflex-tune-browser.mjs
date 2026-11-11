// Issue #70 in the real page: a cold start on a weak preset tunes the reflex
// car on the main thread, within its time budget, caches it per track, and
// generation 0 drives with it.
//   node tests/reflex-tune-browser.mjs
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {waitForServer} from './helpers/server-ready.mjs';
import {startStaticServer} from './helpers/static-server.mjs';
import {chromium} from 'playwright';
import {reflexBrain} from '../AI-Car-Racer/learning/reflex.js';
import {cachedTuning,REFLEX_TUNE_BUDGET_MS} from '../AI-Car-Racer/learning/reflexTuner.js';

// A free port, so a server from another checkout on a fixed port cannot
// answer in place of this one.
const port=await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);
  probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port));});});
const server=startStaticServer(String(port));
const origin=`http://127.0.0.1:${port}`;let browser;const errors=[];
try{
  await waitForServer(origin,server);
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1120,height:800}});page.setDefaultTimeout(60000);
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.addInitScript(()=>localStorage.setItem('vv.multiplayer',JSON.stringify({enabled:false,showDrivers:false})));
  await page.goto(`${origin}/AI-Car-Racer/`);
  await page.waitForFunction(()=>window.DriverLearning&&typeof window.__switchTrackInMemory==='function');
  assert.equal(await page.evaluate(()=>localStorage.getItem('vv.reflexTuning')),null,'a fresh browser has no tuning cache');
  assert.ok(await page.evaluate(()=>window.__switchTrackInMemory('Oval')),'Oval preset loaded');
  // Record generation 0 as built, before the worker drives it.
  await page.evaluate(()=>{const learning=window.DriverLearning,build=learning.build.bind(learning);window.__builds=[];
    learning.build=(...args)=>{const batch=build(...args);window.__builds.push({kind:batch.kinds[0],slot0:Array.from(batch.flat.slice(0,244)),frameCount});return batch;};
    setN(16);setSeconds(20);setSimSpeed(5);});
  await page.locator('#ai-drive-toggle').click();
  await page.waitForFunction(()=>window.DriverLearning.coach.rounds>=1,{},{timeout:120000});
  // Read the page state only; the brains are rebuilt here in Node, so the
  // check needs no second module fetch from the page.
  const live=await page.evaluate(()=>{
    const learning=window.DriverLearning,tune=learning.reflexTune,store=JSON.parse(localStorage.getItem('vv.reflexTuning')||'{}');
    const t0=performance.now(),again=learning.reflexTuningFor(learning.context),cacheMs=performance.now()-t0;
    return {tune,again,cacheMs,first:window.__builds[0],context:learning.context,gen0:learning.coach.history[0],store};
  });
  live.budget=REFLEX_TUNE_BUDGET_MS;
  const memory={getItem:k=>k==='vv.reflexTuning'?JSON.stringify(live.store):null};
  live.cached=cachedTuning(live.context,memory);
  live.tunedBrain=live.cached?Array.from(reflexBrain(live.cached)):null;live.fixedBrain=Array.from(reflexBrain());
  live.store=Object.keys(live.store);
  console.log(`Oval cold start: tuned ${live.tune.defaultScore.toFixed(2)} -> ${live.tune.score.toFixed(2)} in ${live.tune.ms.toFixed(0)} ms `+
    `(${live.tune.searched} search + ${live.tune.drives-live.tune.searched} finalist drives, budget ${live.budget} ms) · generation 0 best ${live.gen0.best} · cache read ${live.cacheMs.toFixed(1)} ms`);
  assert.equal(live.first.kind,'reflex','generation 0 is a cold start with the reflex car');
  assert.ok(live.cached,'the tuning is cached for this track');assert.equal(live.store.length,1);
  assert.deepEqual(live.first.slot0,live.tunedBrain,'generation 0 drives the tuned reflex');
  assert.notDeepEqual(live.first.slot0,live.fixedBrain);
  assert.ok(live.tune.score>live.tune.defaultScore,'the tuner beat the fixed reflex on Oval');
  assert.ok(live.tune.ms<live.budget*2,`tuning took ${live.tune.ms} ms`);
  assert.equal(live.first.frameCount,0,'the page frame counter is put back after the tuning drives');
  assert.ok(live.gen0.best>=3,`generation 0 champion progress ${live.gen0.best} (the fixed reflex alone passes 1 gate)`);
  assert.deepEqual({...live.again,side:[...live.again.side]},{...live.cached,side:[...live.cached.side]});assert.ok(live.cacheMs<50,'a cached tuning is reused, not searched again');
  // Broken storage: the same context gets the same tuning twice (the memo),
  // so the A/B arms and the transfer check stay on one tuning.
  const memo=await page.evaluate(()=>{const learning=window.DriverLearning,context={...learning.context,seconds:21};
    const setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};
    try{const a=learning.reflexTuningFor(context),b=learning.reflexTuningFor(context);return {a,b,stored:localStorage.getItem('vv.reflexTuning').includes('|21|')};}
    finally{Storage.prototype.setItem=setItem;}});
  assert.ok(memo.a);assert.deepEqual(memo.b,memo.a);assert.equal(memo.stored,false);
  // A context for another track than the road on the page is never tuned here.
  assert.equal(await page.evaluate(()=>window.DriverLearning.reflexTuningFor({...window.DriverLearning.context,track:'another-track'})),null);
  // Opt out for one browser.
  assert.equal(await page.evaluate(()=>{localStorage.setItem('reflexTune','0');return window.DriverLearning.reflexTuningFor(window.DriverLearning.context);}),null);
  assert.deepEqual(errors,[],errors.join('\n'));
  console.log('reflex tune browser: ok');
}finally{await browser?.close();server.kill?.();}
