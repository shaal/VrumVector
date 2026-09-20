import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {chromium} from 'playwright';
import {waitForServer} from './helpers/server-ready.mjs';

const out='test-results/multiplayer';await mkdir(out,{recursive:true});
const presets={window:{}};vm.runInNewContext(await readFile('AI-Car-Racer/trackPresets.js','utf8'),presets);
const oval=presets.window.TRACK_PRESETS.find(p=>p.name==='Oval');
const bundle=await build({entryPoints:['multiplayer/worker.js'],bundle:true,write:false,format:'esm',external:['cloudflare:workers']});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-17',durableObjects:{ROOMS:{className:'LiveRoom',useSQLite:true}},bindings:{ALLOW_LOCAL:'true'},port:8878});
const server=spawn('python3',['-m','http.server','8877','--bind','127.0.0.1'],{stdio:'ignore'}),origin='http://127.0.0.1:8877';
const errors=[];let browser,stage='boot';
try{
  await waitForServer(origin,server);await mf.ready;
  browser=await chromium.launch({headless:true});
  const contexts=await Promise.all([
    browser.newContext({viewport:{width:1280,height:900}}),
    browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})
  ]);
  const [desktop,phone]=await Promise.all(contexts.map(async(context,index)=>{
    const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.route('**/multiplayer/config.json',route=>route.fulfill({json:{endpoint:'http://127.0.0.1:8878'}}));
    await page.addInitScript(({name,track})=>{
      localStorage.setItem('vv.callsign',name);
      if(track){
        localStorage.setItem('trackInner',JSON.stringify(track.points));
        localStorage.setItem('trackOuter',JSON.stringify(track.points2));
        localStorage.setItem('checkPointList',JSON.stringify(track.checkPointListEditor));
        localStorage.setItem('maxSpeed',JSON.stringify('14'));
        localStorage.setItem('traction',JSON.stringify('0.60'));
        localStorage.setItem('invincible',JSON.stringify(true));
      }
    },{name:index?'Phone':'Brave',track:index?null:oval});
    await page.goto(`${origin}/AI-Car-Racer/?rv=0`);
    await page.waitForFunction(()=>window.LiveSession?.connected&&window.LiveSession.info);
    await page.evaluate(()=>{setN(2);setSeconds(60);});
    return page;
  }));
  stage='different saved track and physics stay discoverable';console.log(stage);
  for(const page of [desktop,phone]){
    await page.waitForFunction(()=>window.LiveSession.peers.size===1);
    assert.equal(await page.evaluate(()=>window.LiveSession.showDrivers),false);
    await page.locator('.live-launch').click();await page.getByRole('checkbox',{name:'Show other drivers',exact:true}).check();
    assert.equal(await page.evaluate(()=>window.LiveSession.drivers().length),0);
  }
  await phone.getByRole('button',{name:'Join race with Brave',exact:true}).waitFor();
  await desktop.getByRole('button',{name:'Join race with Phone',exact:true}).waitFor();
  // Let multiple pose refreshes pass; they must not replace the touch target.
  await phone.getByRole('button',{name:'Join race with Brave',exact:true}).focus();
  await phone.waitForTimeout(350);
  assert.equal(await phone.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Join race with Brave');
  await phone.screenshot({path:`${out}/different-races-mobile.png`});
  const saved=await phone.evaluate(()=>Object.fromEntries(['trackInner','trackOuter','checkPointList','maxSpeed','traction','invincible'].map(k=>[k,localStorage.getItem(k)])));
  const ownKey=await phone.evaluate(()=>window.LiveSession.key);
  stage='tap Join race on mobile matches geometry, gates and physics without changing saves';console.log(stage);
  await phone.getByRole('button',{name:'Join race with Brave',exact:true}).tap();
  for(const page of [desktop,phone])await page.waitForFunction(()=>window.LiveSession.drivers().length===1);
  assert.equal(await phone.evaluate(()=>window.LiveSession.key),await desktop.evaluate(()=>window.LiveSession.key));
  assert.deepEqual(await phone.evaluate(()=>({maxSpeed,traction,invincible})),await desktop.evaluate(()=>({maxSpeed,traction,invincible})));
  assert.deepEqual(await phone.evaluate(()=>({inner:road.innerList,outer:road.outerList,gates:road.checkPointList})),await desktop.evaluate(()=>({inner:road.innerList,outer:road.outerList,gates:road.checkPointList})));
  assert.equal(await phone.evaluate(()=>window.__awaitingStart&&pause&&simSpeed===1),true);
  assert.deepEqual(await phone.evaluate(()=>Object.fromEntries(['trackInner','trackOuter','checkPointList','maxSpeed','traction','invincible'].map(k=>[k,localStorage.getItem(k)]))),saved);
  await phone.locator('.live-standings').getByText('Brave · paused',{exact:true}).waitFor();
  await desktop.locator('.live-standings').getByText('Phone · paused',{exact:true}).waitFor();
  await phone.screenshot({path:`${out}/joined-race-mobile.png`});
  await phone.getByRole('button',{name:'Restore my setup',exact:true}).tap();
  await phone.waitForFunction(key=>window.LiveSession.key===key,ownKey);
  await desktop.getByRole('button',{name:'Join race with Phone',exact:true}).waitFor();
  assert.equal(await phone.evaluate(()=>window.__awaitingStart&&pause),true);
  await phone.getByRole('button',{name:'Join race with Brave',exact:true}).tap();
  for(const page of [desktop,phone]){
    await page.waitForFunction(()=>window.LiveSession.drivers().length===1);
    await page.locator('[data-live-close]').click();await page.locator('#startOverlayBtn').click();
  }
  stage='joined desktop movement reaches the independent mobile browser';console.log(stage);
  const start=await desktop.evaluate(()=>({x:playerCar2.x,y:playerCar2.y}));
  await desktop.keyboard.down('w');
  try{
    await desktop.waitForFunction(p=>Math.hypot(playerCar2.x-p.x,playerCar2.y-p.y)>20,start);
    await phone.waitForFunction(p=>{const d=window.LiveSession.drivers()[0];return d?.name==='Brave'&&Math.hypot(d.pose.x-p.x,d.pose.y-p.y)>10;},start);
  }finally{await desktop.keyboard.up('w');}
  assert.deepEqual(errors,[]);
  await writeFile(`${out}/discovery-result.json`,JSON.stringify({passed:true,checks:['independent desktop and mobile contexts from first load','different saved tracks, gates and physics','discover Phone and Brave','stable keyboard/touch Join control','temporary join preserves saved setup and start gate','restore setup','bidirectional car visibility','WASD movement reaches mobile']},null,2));
  console.log('Cross-device discovery checks passed');
}catch(error){
  await writeFile(`${out}/discovery-failure.json`,JSON.stringify({stage,error:String(error.stack),errors},null,2));
  for(const [index,context] of (browser?.contexts()||[]).entries())for(const page of context.pages())await page.screenshot({path:`${out}/discovery-failure-${index}.png`}).catch(()=>{});
  throw error;
}finally{await browser?.close();await mf.dispose();server.kill();}
