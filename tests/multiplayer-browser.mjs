import assert from 'node:assert/strict';
import {waitForServer} from './helpers/server-ready.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {chromium} from 'playwright';

const out='test-results/multiplayer';await mkdir(out,{recursive:true});
const bundle=await build({entryPoints:['multiplayer/worker.js'],bundle:true,write:false,format:'esm',external:['cloudflare:workers']});
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-17',durableObjects:{ROOMS:{className:'LiveRoom',useSQLite:true}},bindings:{ALLOW_LOCAL:'true'},port:8878});
const server=spawn('python3',['-m','http.server','8877','--bind','127.0.0.1'],{stdio:'ignore'});
const origin='http://127.0.0.1:8877';
let browser;const errors=[];let stage='boot';
try{
  await waitForServer(origin,server);
  await mf.ready;
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const contexts=await Promise.all([browser.newContext({viewport:{width:1120,height:800}}),browser.newContext({viewport:{width:1120,height:800}})]);
  const [a,b]=await Promise.all(contexts.map(async (context,index)=>{
    const p=await context.newPage();p.setDefaultTimeout(30000);
    p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await p.route('**/multiplayer/config.json',route=>route.fulfill({json:{endpoint:'http://127.0.0.1:8878'}}));
    await p.addInitScript(()=>localStorage.setItem('vv.circuitStudio',JSON.stringify({enabled:true})));
    if(index===1)await p.addInitScript(()=>{
      // A returning player who used the old physics sliders stores strings.
      localStorage.setItem('maxSpeed',JSON.stringify('15'));
      localStorage.setItem('traction',JSON.stringify('0.50'));
    });
    await p.goto(`${origin}/AI-Car-Racer/?rv=0`);
    await p.waitForFunction(()=>!!window.LiveSession?.info&&!!window.PlayerAssist?.info&&!!window.CircuitStudio?.info);
    await p.evaluate(()=>{setN(2);setSeconds(4);setSimSpeed(20);});
    return p;
  }));
  stage='automatic multiplayer, hidden drivers, 2D default, and editable identity';console.log(stage);
  await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.LiveSession.connected&&window.LiveSession.peers.size===1)));
  for(const p of [a,b]){
    assert.equal(await p.evaluate(()=>window.CircuitStudio.enabled||window.CircuitStudio.ready||window.CircuitStudio.active),false);
    assert.equal(await p.locator('#graphics-toggle').isVisible(),true);
    assert.equal(await p.locator('#graphics-toggle').textContent(),'Switch to 3D graphics');
    assert.equal(await p.locator('#ai-drive-toggle').getAttribute('aria-pressed'),'false');
    assert.equal(await p.evaluate(()=>window.LiveSession.enabled&&!window.LiveSession.showDrivers&&window.LiveSession.drivers().length===0),true);
    assert.equal(await p.evaluate(()=>window.__awaitingStart&&pause),true,'Auto-joining must not start training');
    assert.equal(await p.evaluate(()=>simSpeed),1);
    assert.equal(await p.locator('#simSpeedInput').isDisabled(),true);
    assert.match(await p.locator('.live-launch').textContent(),/Other drivers hidden/);
    assert.equal(await p.locator('.live-standings').isVisible(),false);
  }
  await a.screenshot({path:`${out}/classic-start-desktop.png`});
  await a.setViewportSize({width:390,height:844});
  await a.screenshot({path:`${out}/classic-start-mobile.png`});
  const launchBounds=await a.locator('#graphics-toggle').boundingBox();
  assert.ok(launchBounds.x>=0&&launchBounds.x+launchBounds.width<=390);
  await a.setViewportSize({width:1120,height:800});
  const names=await Promise.all([a,b].map(p=>p.evaluate(()=>window.LiveSession.callsign)));
  for(const name of names)assert.match(name,/^[A-Za-z]+ [A-Za-z]+ \d+$/);
  await a.locator('.live-launch').click();await b.locator('.live-launch').click();
  assert.equal(await a.getByRole('checkbox',{name:'Multiplayer',exact:true}).isChecked(),true);
  assert.equal(await a.getByRole('checkbox',{name:'Show other drivers',exact:true}).isChecked(),false);
  await a.screenshot({path:`${out}/multiplayer-default-desktop.png`});
  await a.setViewportSize({width:390,height:844});
  await a.screenshot({path:`${out}/multiplayer-default-mobile.png`});
  const mobilePanel=await a.locator('#live-panel').boundingBox(),mobileLaunch=await a.locator('.live-launch').boundingBox();
  assert.ok(mobilePanel.x>=0&&mobilePanel.x+mobilePanel.width<=390&&mobilePanel.y>=mobileLaunch.y+mobileLaunch.height,'Panel fits below the launch button on mobile');
  for(const id of ['#live-enabled','#live-show-drivers']){
    const toggle=await a.locator(id).boundingBox();assert.ok(toggle.y>=mobilePanel.y&&toggle.y+toggle.height<=mobilePanel.y+mobilePanel.height,'Both switches are visible without scrolling');
  }
  await a.setViewportSize({width:1120,height:800});
  await a.locator('#live-callsign').fill('Silver Fox');await a.locator('[data-live-name] button').click();
  await b.locator('#live-callsign').fill('Neon Lynx');await b.locator('[data-live-name] button').click();
  assert.equal(await a.evaluate(()=>playerCar2.controls.forward||playerCar2.controls.left||playerCar2.controls.reverse),false);
  await a.locator('#live-show-drivers').check();
  await a.waitForFunction(()=>window.LiveSession.drivers().length===1);
  assert.equal(await b.evaluate(()=>window.LiveSession.drivers().length),0,'Each player controls only their own view');
  assert.equal(await b.evaluate(()=>window.LiveSession.connected),true,'Hiding rivals still shares your own car');
  await b.locator('#live-show-drivers').check();
  await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.LiveSession.connected&&window.LiveSession.drivers().length===1)));
  for(const p of [a,b])await p.locator('#startOverlayBtn').click();
  assert.deepEqual(await b.evaluate(()=>({maxSpeed,traction})),{maxSpeed:15,traction:0.5});
  const room=await a.locator('.live-room').textContent();
  assert.match(room,/Room [A-F0-9]{8}.*speed 15.*traction 0.5/);
  assert.equal(await b.locator('.live-room').textContent(),room);
  stage='slider round-trip keeps equal physics in the same room';console.log(stage);
  await b.evaluate(()=>{setMaxSpeed('14');});
  await a.waitForFunction(()=>window.LiveSession.peers.size===0);
  await b.evaluate(()=>{setMaxSpeed('15');setTraction('0.50');});
  await Promise.all([a,b].map(p=>p.waitForFunction(()=>window.LiveSession.connected&&window.LiveSession.drivers().length===1)));
  assert.equal(await b.locator('.live-room').textContent(),room);
  await a.locator('.live-standings').getByText('Neon Lynx').waitFor();
  for(const p of [a,b]){
    assert.equal(await p.evaluate(()=>simSpeed),1);
    assert.equal(await p.locator('#simSpeedInput').inputValue(),'1');
    assert.equal(await p.locator('#simSpeedInput').isDisabled(),true);
    await p.evaluate(()=>{setSimSpeed(20);phaseToLayout(4);});
    assert.equal(await p.evaluate(()=>simSpeed),1);
    assert.equal(await p.locator('#simSpeedInput').isDisabled(),true);
  }
  stage='actual WASD movement over the network';console.log(stage);
  await a.locator('#live-callsign').fill('Comet');await a.locator('[data-live-name] button').click();
  await b.waitForFunction(()=>[...window.LiveSession.peers.values()].some(p=>p.name==='Comet'));
  await a.locator('[data-live-close]').click();
  const start=await a.evaluate(()=>({x:playerCar2.x,y:playerCar2.y}));
  await a.keyboard.down('w');
  try{
    await a.waitForFunction(start=>playerCar2.controls.forward&&Math.hypot(playerCar2.x-start.x,playerCar2.y-start.y)>10,start);
    await b.waitForFunction(start=>{const p=window.LiveSession.drivers()[0];return p&&Math.hypot(p.pose.x-start.x,p.pose.y-start.y)>1;},start);
  }finally{await a.keyboard.up('w');}
  stage='human cars and remote callsigns render in Tilt';console.log(stage);
  await a.evaluate(()=>{
    window.__tiltLabels=[];
    const fillText=ctx.fillText.bind(ctx);
    ctx.fillText=(text,...args)=>{if(window.DemoPresentation.state.view3d)window.__tiltLabels.push(text);return fillText(text,...args);};
  });
  await a.getByRole('button',{name:'Tilt',exact:true}).click();
  await a.waitForFunction(()=>window.__tiltLabels.includes('Neon Lynx')&&window.__tiltLabels.includes('You · WASD'));
  await a.screenshot({path:`${out}/live-grid-tilt.png`});
  await a.getByRole('button',{name:'Tilt',exact:true}).click();
  stage='AI co-driver and manual overrides';console.log(stage);
  await a.evaluate(()=>{setSeconds(60);begin(true);});
  await a.locator('#ai-drive-toggle').click();
  assert.equal(await a.evaluate(()=>pause),false,'Enabling AI must not pause an active race');
  await a.waitForFunction(()=>window.PlayerAssist.enabled&&playerCar2.aiDriving&&window.PlayerAssist.brain?.levels.length===2&&window.PlayerAssist.run===presentationRunSerial);
  // First exercise the real worker request. Then hold a known network's output
  // steady so assertions do not depend on which random AI currently leads.
  await a.evaluate(()=>{
    const pilot=window.PlayerAssist;pilot.requestId++;pilot.nextRequest=Infinity;
    for(const level of pilot.brain.levels){level.weights.fill(0);level.biases.fill(0);}
    pilot.brain.levels.at(-1).biases.set([-1,-1,1,1]);
    playerCar2.x=startInfo.x;playerCar2.y=startInfo.y;playerCar2.angle=startInfo.heading;
    playerCar2.speed=0;playerCar2.velocity={x:0,y:0};playerCar2.damaged=false;
    window.__assistStart={x:playerCar2.x,y:playerCar2.y};
  });
  await a.waitForFunction(()=>playerCar2.controls.forward&&playerCar2.controls.left&&Math.hypot(playerCar2.x-window.__assistStart.x,playerCar2.y-window.__assistStart.y)>5);
  await a.keyboard.down('d');
  try{await a.waitForFunction(()=>playerCar2.controls.right&&!playerCar2.controls.left&&playerCar2.controls.forward);}
  finally{await a.keyboard.up('d');}
  await a.waitForFunction(()=>playerCar2.controls.left&&!playerCar2.controls.right);
  await a.keyboard.down('s');
  try{
    await a.waitForFunction(()=>playerCar2.controls.reverse&&!playerCar2.controls.forward);
    await a.locator('#ai-drive-toggle').click();
    assert.equal(await a.evaluate(()=>!playerCar2.aiDriving&&playerCar2.controls.reverse&&!playerCar2.controls.forward&&!playerCar2.controls.left),true);
  }finally{await a.keyboard.up('s');}
  assert.equal(await a.evaluate(()=>playerCar2.controls.reverse||playerCar2.controls.forward||playerCar2.controls.left||playerCar2.controls.right),false);
  await a.evaluate(()=>pauseGame());
  await a.locator('#ai-drive-toggle').click();
  assert.equal(await a.evaluate(()=>pause),false,'Enabling AI resumes a paused race');
  await a.locator('#ai-drive-toggle').click();
  await a.evaluate(()=>{setSeconds(4);begin(true);});
  stage='lap continuity and small AI cohorts';console.log(stage);
  await a.evaluate(()=>{window.__liveCar=playerCar2;window.__liveGeneration=generation;});
  await a.waitForFunction(()=>generation>window.__liveGeneration,{},{timeout:30000});
  assert.equal(await a.evaluate(()=>playerCar2===window.__liveCar),true);
  for(const n of [1,2,3,4,5]){
    await a.evaluate(n=>{setN(n);begin(true);},n);
    await a.waitForFunction(n=>latestSnapshot?.N===n,n);
  }
  await a.evaluate(()=>{setN(-5);});assert.equal(await a.evaluate(()=>batchSize),1);
  await a.evaluate(()=>{setN(3);phaseToLayout(4);});
  const slider=await a.locator('#batchSizeInput').evaluate(el=>({min:el.min,step:el.step,max:el.max}));
  assert.deepEqual(slider,{min:'1',step:'1',max:'2000'});
  stage='3D remote car and mobile layout';console.log(stage);
  await a.evaluate(()=>{window.CircuitStudio.setQuality('low');window.CircuitStudio.forceWebGL=true;});
  // CPU shader compilation can continue inside the first click. Give that
  // action the same startup budget as the renderer-ready assertion below.
  await a.locator('#graphics-toggle').click({timeout:90000});
  await a.waitForFunction(()=>window.CircuitStudio.active&&window.CircuitStudio.liveCars.size===1,{},{timeout:90000});
  await a.locator('#ai-drive-toggle').click();
  await a.waitForFunction(()=>playerCar2.aiDriving);
  await a.screenshot({path:`${out}/ai-driving-3d.png`});
  await a.locator('#ai-drive-toggle').click();
  await a.locator('.live-launch').click();
  stage='hide/show removes 3D rivals without disconnecting';console.log(stage);
  await a.evaluate(()=>{window.__visibilitySocket=window.LiveSession.ws;});
  await a.locator('#live-show-drivers').uncheck();
  await a.waitForFunction(()=>window.CircuitStudio.liveCars.size===0);
  assert.equal(await a.locator('.live-standings').isVisible(),false);
  assert.equal(await a.evaluate(()=>window.LiveSession.connected&&window.LiveSession.ws===window.__visibilitySocket),true);
  assert.equal(await b.evaluate(()=>window.LiveSession.peers.size),1);
  await a.locator('#live-show-drivers').check();
  await a.waitForFunction(()=>window.CircuitStudio.liveCars.size===1);
  await a.screenshot({path:`${out}/live-grid-desktop.png`});
  await a.setViewportSize({width:390,height:844});
  await a.waitForTimeout(500);await a.screenshot({path:`${out}/live-grid-mobile.png`});
  const bounds=await a.locator('#live-panel').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);
  await a.setViewportSize({width:1120,height:800});
  stage='room isolation, reconnect, and leaving';console.log(stage);
  await b.evaluate(()=>{maxSpeed+=1;});
  await a.waitForFunction(()=>window.LiveSession.peers.size===0);
  await b.evaluate(()=>{maxSpeed-=1;});
  await a.waitForFunction(()=>window.LiveSession.peers.size===1);
  await b.evaluate(()=>window.LiveSession.ws.close());
  await b.waitForFunction(()=>window.LiveSession.connected&&window.LiveSession.peers.size===1,{},{timeout:30000});
  await b.locator('#live-enabled').uncheck();
  assert.equal(await b.locator('#simSpeedInput').isDisabled(),false);
  assert.equal(await b.locator('#live-show-drivers').isDisabled(),true);
  assert.equal(await b.locator('#live-show-drivers').isChecked(),false);
  await a.waitForFunction(()=>window.LiveSession.peers.size===0&&window.CircuitStudio.liveCars.size===0);
  await b.locator('#live-enabled').check();
  await a.waitForFunction(()=>window.LiveSession.peers.size===1);
  stage='background player stays visible, parked, and resumes the same connection';console.log(stage);
  await b.waitForFunction(()=>window.LiveSession.connected);
  // Visibility changes run the real lifecycle handler; isolated contexts above
  // model normal/incognito storage without sharing callsigns or saved settings.
  await b.evaluate(()=>{
    window.__awaySocket=window.LiveSession.ws;window.__awayId=window.LiveSession.id;
    window.__parkedPosition={x:playerCar2.x,y:playerCar2.y};
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await a.waitForFunction(()=>{
    const drivers=window.LiveSession.drivers();
    return drivers.length===1&&drivers[0].pose.away&&drivers[0].pose.paused&&drivers[0].pose.speed===0;
  });
  await a.waitForFunction(()=>[...window.CircuitStudio.liveCars.values()].some(car=>car.label.textContent==='Neon Lynx · away'));
  await a.locator('.live-standings').getByText('Neon Lynx · away',{exact:true}).waitFor();
  // Cross the former three-second pose expiry without waiting for a heartbeat.
  await b.waitForTimeout(3500);
  assert.equal(await a.evaluate(()=>window.LiveSession.drivers().length),1);
  assert.deepEqual(await b.evaluate(()=>({x:playerCar2.x,y:playerCar2.y})),await b.evaluate(()=>window.__parkedPosition));
  assert.equal(await b.evaluate(()=>window.LiveSession.ws===window.__awaySocket&&window.LiveSession.id===window.__awayId),true);
  await b.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await a.waitForFunction(()=>window.LiveSession.drivers().length===1&&!window.LiveSession.drivers()[0].pose.away);
  assert.equal(await b.evaluate(()=>window.LiveSession.ws===window.__awaySocket&&window.LiveSession.id===window.__awayId),true);
  await b.locator('#live-show-drivers').check();
  await b.reload();await b.waitForFunction(()=>!!window.LiveSession?.info);
  assert.equal(await b.evaluate(()=>window.LiveSession.callsign),'Neon Lynx');
  assert.equal(await b.evaluate(()=>window.LiveSession.enabled&&window.LiveSession.showDrivers),true);
  await b.waitForFunction(()=>window.LiveSession.connected&&window.LiveSession.drivers().length===1);
  await b.locator('.live-launch').click();await b.locator('#live-enabled').uncheck();
  await a.waitForFunction(()=>window.LiveSession.peers.size===0);
  await b.reload();await b.waitForFunction(()=>!!window.LiveSession?.info);
  assert.equal(await b.evaluate(()=>window.LiveSession.enabled||!!window.LiveSession.ws||window.LiveSession.showDrivers),false,'Turning multiplayer off survives reload');
  assert.equal(await b.locator('#simSpeedInput').isDisabled(),false);
  await a.locator('[data-live-close]').click();
  await a.locator('[data-action="classic-top"]').click();
  await a.waitForFunction(()=>!window.CircuitStudio.active);
  assert.equal(await a.locator('#graphics-toggle').isVisible(),true);
  await a.reload();await a.waitForFunction(()=>!!window.PlayerAssist?.info&&!!window.CircuitStudio?.info);
  assert.equal(await a.evaluate(()=>window.PlayerAssist.enabled||window.CircuitStudio.enabled),false);
  assert.deepEqual(errors,[]);
  await writeFile(`${out}/result.json`,JSON.stringify({passed:true,checks:['2D default after saved 3D preference','graphics switch','automatic multiplayer without auto-starting training','other drivers hidden by default','independent view controls','multiplayer 1× lock','AI co-driver worker integration','steering/throttle override and release','AI off with held keys','callsigns','legacy saved physics matching','numeric slider round-trip matching','visible room codes','cross-browser WASD','Tilt human cars and labels','generation continuity','AI 1–5','3D hide/show without reconnect','mobile controls visible without scrolling','room isolation','reconnect','background presence and parked car','away labels in standings and 3D','resume without reconnect','saved display choice','saved opt-out']},null,2));
  console.log('Live multiplayer browser checks passed');
}catch(error){
  const diagnostics=[];
  for(const context of browser?.contexts()||[])for(const p of context.pages())diagnostics.push(await p.evaluate(()=>({
    hidden:document.hidden,focus:document.activeElement?.outerHTML,paused:pause,phase,
    player:{x:playerCar2.x,y:playerCar2.y,speed:playerCar2.speed,damaged:playerCar2.damaged,controls:{forward:playerCar2.controls.forward,left:playerCar2.controls.left}},
    live:{status:window.LiveSession.status,connected:window.LiveSession.connected,peers:[...window.LiveSession.peers.values()]}
  })).catch(()=>null));
  await writeFile(`${out}/failure.json`,JSON.stringify({stage,error:String(error.stack),errors,diagnostics},null,2));
  for(const context of browser?.contexts()||[])for(const p of context.pages())await p.screenshot({path:`${out}/failure-${browser.contexts().indexOf(context)}.png`}).catch(()=>{});
  throw error;
}finally{await browser?.close();await mf.dispose();server.kill();}
