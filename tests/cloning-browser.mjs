// Behavioural cloning in the real module worker, in Chromium: the worker gives
// the same weights as training on the page, sends progress, can be cancelled,
// reports bad data, and the page keeps running while it trains.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {waitForServer} from './helpers/server-ready.mjs';

const port=8890,origin=`http://127.0.0.1:${port}`,out='test-results/cloning';
await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1'],{stdio:'ignore'});
let browser;
try{
  await waitForServer(origin,server);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();page.setDefaultTimeout(120000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.stack||error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  // A blank page on the test origin, so module imports and the worker URL resolve.
  await page.route(`${origin}/__cloning__`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Cloning worker test</title>'}));
  await page.goto(`${origin}/__cloning__`);
  const result=await page.evaluate(async()=>{
    const clone=await import('/AI-Car-Racer/learning/clone.js');
    const {syntheticDataset}=await import('/tests/helpers/synthetic.mjs');
    const dataset=syntheticDataset({runs:8,steps:1500,seed:'browser-worker'});
    const options={lags:[1,2,4],maxEpochs:40,patience:40};
    // A 4 ms timer on the page records the longest wait between its ticks.
    let last=performance.now(),longestWait=0;
    const timer=setInterval(()=>{const now=performance.now();longestWait=Math.max(longestWait,now-last);last=now;},4);
    const progress=[];let started=performance.now();
    const worker=await clone.trainCloneInWorker(dataset,{...options,onProgress:p=>progress.push(p)});
    const workerMs=performance.now()-started;clearInterval(timer);
    started=performance.now();
    const page=clone.trainClone(dataset,options);
    const pageMs=performance.now()-started;
    const same=worker.weights.length===244&&worker.weights.every((v,i)=>Object.is(v,page.weights[i]));
    const controller=new AbortController();let cancelled=null,afterCancel=0;
    try{await clone.trainCloneInWorker(dataset,{...options,signal:controller.signal,onProgress:()=>{afterCancel++;controller.abort();}});}
    catch(error){cancelled=error.name;}
    await new Promise(resolve=>setTimeout(resolve,300));
    let refused=null;
    try{await clone.trainCloneInWorker({inputs:new Float32Array(0),keys:new Uint8Array(0),episode:new Uint32Array(0)});}
    catch(error){refused={name:error.name,code:error.code};}
    return {same,weights:Array.from(worker.weights),float32:worker.weights instanceof Float32Array,lag:worker.report.lag,agreement:worker.report.heldOut.agreement,
      progress:progress.length,phases:[...new Set(progress.map(p=>p.phase))],workerMs,pageMs,longestWait,cancelled,afterCancel,refused};
  });
  // The same training in Node. Reported, not asserted: a browser or Node update
  // could change the last bit of Math.tanh or Math.exp.
  const {trainClone}=await import('../AI-Car-Racer/learning/clone.js');
  const {syntheticDataset}=await import('./helpers/synthetic.mjs');
  const node=trainClone(syntheticDataset({runs:8,steps:1500,seed:'browser-worker'}),{lags:[1,2,4],maxEpochs:40,patience:40});
  result.sameAsNode=result.weights.every((v,i)=>Object.is(v,node.weights[i]));delete result.weights;
  console.log(JSON.stringify(result));
  await writeFile(`${out}/worker.json`,JSON.stringify(result,null,2)+'\n');
  assert.equal(result.same,true,'the worker and the page train the same weights');
  assert.equal(result.float32,true);
  assert.ok(result.progress>0&&result.phases.includes('screen')&&result.phases.includes('train'));
  assert.ok(result.workerMs>500,`training should take long enough to measure (${result.workerMs} ms)`);
  assert.ok(result.longestWait<250,`the page waited ${result.longestWait} ms while the worker trained`);
  assert.equal(result.cancelled,'AbortError');assert.equal(result.afterCancel,1,'no progress after cancelling');
  assert.deepEqual(result.refused,{name:'CloneError',code:'not-enough-data'});
  assert.deepEqual(errors,[]);
  console.log('cloning worker browser test passed');
}finally{
  await browser?.close();
  server.kill();
}
