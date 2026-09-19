import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

const out='test-results/learning';await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8887','--bind','127.0.0.1'],{stdio:'ignore'});
const origin='http://127.0.0.1:8887';let browser,page,stage='boot';const errors=[];
const ready=async()=>{
  await page.waitForFunction(()=>window.DriverLearning&&window.PlayerAssist?.info&&window.CircuitStudio?.info);
  await page.waitForFunction(()=>window.__rvBridge?.info?.().ready,{},{timeout:60000});
};
const mark=value=>{stage=value;console.log(stage);};
try{
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  page=await browser.newPage({viewport:{width:1120,height:800}});page.setDefaultTimeout(30000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(`${origin}/AI-Car-Racer/`);await ready();
  mark('profile choice before starting');
  assert.equal(await page.evaluate(()=>window.CircuitStudio.enabled||window.PlayerAssist.enabled),false);
  assert.equal(await page.evaluate(()=>window.DriverLearning.adaptive),false,'Adaptive exploration is an explicit experiment');
  await page.locator('#driver-learning summary').click();
  await page.getByLabel('Adaptive exploration',{exact:true}).check();
  await page.getByLabel('Driving style',{exact:true}).selectOption('careful');
  assert.equal(await page.evaluate(()=>window.__awaitingStart),true);
  assert.equal(await page.getByLabel('Driving style',{exact:true}).inputValue(),'careful');
  await page.screenshot({path:`${out}/profiles-classic-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  const panel=await page.locator('.learning-panel').boundingBox();
  assert.ok(panel.x>=0&&panel.x+panel.width<=390&&panel.y+panel.height<=844);
  await page.screenshot({path:`${out}/profiles-classic-mobile.png`});
  await page.setViewportSize({width:1120,height:800});
  await page.getByRole('button',{name:'Close driver profiles',exact:true}).click();
  await page.evaluate(()=>{setN(16);setSeconds(6);setSimSpeed(5);});
  await page.locator('#ai-drive-toggle').click();
  await page.waitForFunction(()=>window.DriverLearning.coach.rounds>=3&&playerCar2.aiDriving);
  assert.equal(await page.evaluate(()=>latestSnapshot.driverProfile),'careful');
  const trained=await page.evaluate(()=>({history:window.DriverLearning.coach.history,context:window.DriverLearning.context,
    archive:window.__rvBridge.exportSnapshot().brains.map(b=>b.meta),feedback:window.__rvBridge.info().learning.feedback}));
  assert.ok(trained.history.length>=3);assert.equal(trained.context.profile,'careful');
  assert.ok(trained.archive.some(meta=>meta.learningContext?.profile==='careful'));
  assert.ok(trained.feedback.length>0,'Mutated descendants must provide real seed feedback');
  mark('profile-assisted car still obeys manual input');
  await page.evaluate(()=>{setSeconds(60);setSimSpeed(1);begin(true);});
  await page.waitForFunction(()=>playerCar2.aiDriving&&window.PlayerAssist.brain);
  await page.evaluate(()=>{
    const p=window.PlayerAssist;p.nextRequest=Infinity;
    for(const level of p.brain.levels){level.weights.fill(0);level.biases.fill(0);}
    p.brain.levels.at(-1).biases.set([-1,-1,1,1]);
    playerCar2.damaged=false;playerCar2.x=startInfo.x;playerCar2.y=startInfo.y;playerCar2.speed=0;
  });
  await page.waitForFunction(()=>playerCar2.controls.left);
  await page.keyboard.down('d');try{await page.waitForFunction(()=>playerCar2.controls.right&&!playerCar2.controls.left);}finally{await page.keyboard.up('d');}
  await page.waitForFunction(()=>playerCar2.controls.left&&!playerCar2.controls.right);
  await page.locator('#ai-drive-toggle').click();
  assert.equal(await page.evaluate(()=>playerCar2.aiDriving),false);
  mark('profile switching and persistent context');
  await page.locator('#driver-learning summary').click();
  await page.getByLabel('Driving style',{exact:true}).selectOption('wild');
  await page.getByLabel('Adaptive exploration',{exact:true}).uncheck();
  await page.evaluate(()=>{setSeconds(2);setSimSpeed(5);begin(true);});
  await page.waitForFunction(()=>window.DriverLearning.coach.rounds>=3&&latestSnapshot?.driverProfile==='wild');
  assert.equal(await page.evaluate(()=>window.DriverLearning.context.profile),'wild');
  await page.evaluate(()=>{if(!pause)pauseGame();});
  await page.screenshot({path:`${out}/learning-progress.png`});
  const cached=await page.evaluate(()=>JSON.parse(localStorage.getItem('vv.driverChampions')));
  assert.ok(cached.some(c=>c.meta.learningContext.profile==='careful'));
  assert.ok(cached.some(c=>c.meta.learningContext.profile==='wild'));
  mark('successful SONA circuit examples survive reload');
  await page.evaluate(async()=>{
    const b=window.__rvBridge,vector=new Float32Array(512);vector[0]=1;
    b.beginPhase4Trajectory(vector);b.addPhase4Step(vector,null,20);b.endPhase4Trajectory(20);
    if(!b.info().sona.savedExamples)throw Error('Circuit example was not saved');
    await b.persist();
  });
  await page.reload();await ready();
  await page.waitForFunction(()=>window.__rvBridge.info().sona.replayedExamples>=1);
  assert.equal(await page.evaluate(()=>window.DriverLearning.profile),'wild');
  assert.equal(await page.evaluate(()=>window.DriverLearning.adaptive),false);
  assert.equal(await page.evaluate(()=>window.PlayerAssist.enabled||window.CircuitStudio.enabled),false);
  await page.evaluate(()=>window.DriverLearning.prepare({road,maxSpeed,traction,seconds:2}));
  assert.ok(await page.evaluate(()=>!!window.DriverLearning.coach.incumbent));
  mark('real genetic baseline learns without vector retrieval');
  await page.evaluate(()=>{setN(12);setSeconds(2);setSimSpeed(5);window.__abSetEnabled(true);pauseGame();});
  await page.waitForFunction(()=>window.__abGetState().learningRounds>=2,{},{timeout:60000});
  const baseline=await page.evaluate(()=>window.__abGetState());
  assert.ok(baseline.mutatedCars>0);assert.ok(baseline.learningBest>=0);
  await page.evaluate(()=>{window.__abSetEnabled(false);if(!pause)pauseGame();});

  mark('context-aware WASM retrieval, feedback, and archive round trip');
  const retrieval=await page.evaluate(async()=>{
    const b=window.__rvBridge,basis=new Float32Array(512);basis[0]=1;
    const context={version:1,profile:'careful',track:'fixture-track',maxSpeed:15,traction:.5,seconds:20};
    const a=new Float32Array(244).fill(.2),w=Float32Array.from(a,(v,i)=>i%2?-v:v);
    b.hydrateFromFixture({tracks:[{id:'track',vec:Array.from(basis),meta:{}}],brains:[
      {id:'careful-seed',vec:Array.from(a),meta:{fitness:4,trackId:'track',learningContext:context,parentIds:[]}},
      {id:'wild-seed',vec:Array.from(w),meta:{fitness:4,trackId:'track',learningContext:{...context,profile:'wild'},parentIds:[]}}
    ],observations:[]});
    b.setRerankerMode('ema');b.setBypassLora(true);b.setUseDynamics(false);b.setConsistencyMode('eventual');
    b.setLearningContext(context);const first=b.recommendSeeds(basis,2).map(s=>s.id);
    b.setLearningContext({...context,profile:'wild'});const second=b.recommendSeeds(basis,2).map(s=>s.id);
    b.setConsistencyMode('fresh');b.setLearningContext(context);
    b.observeOffspring([{id:'careful-seed',meanFitness:8,count:3},{id:'wild-seed',meanFitness:1,count:3}],context);
    const feedback=b.info().learning.feedback;
    const snapshot=b.exportSnapshot();b.importSnapshot(snapshot);
    const saved=b.exportSnapshot();
    b.setFederationEnabled(true);const federated=b.recommendSeeds(basis,2).map(s=>s.id);b.setFederationEnabled(false);
    const wire=await import('/AI-Car-Racer/crosstab/wire.js');
    const decoded=wire.fromWire(wire.toWire(a,4,basis,{learning:{context,styleScore:.5}}));
    // The same genome can be tested with another profile. Content dedup must
    // preserve both evaluations and must never create a self-parent edge.
    const duplicate=b.archiveBrain(window.__rvUnflatten(a),5,basis,1,['careful-seed'],undefined,undefined,
      {context:{...context,profile:'wild'},styleScore:.2});
    b.setLearningContext(context);const carefulAgain=b.recommendSeeds(basis,2).find(s=>s.id===duplicate);
    b.setLearningContext({...context,profile:'wild'});const wildAgain=b.recommendSeeds(basis,2).find(s=>s.id===duplicate);
    const merged=b.exportSnapshot().brains.find(s=>s.id===duplicate).meta;
    b.importSnapshot(b.exportSnapshot());b.setLearningContext(context);
    const imported=b.recommendSeeds(basis,2).find(s=>s.id===duplicate);
    return {first,second,feedback,federated,context:decoded.meta.learning.context,
      retainedBaseline:saved.observations.some(o=>Number.isFinite(o.baseline)),metas:saved.brains.map(s=>s.meta.learningContext),
      dedup:{id:duplicate,careful:carefulAgain?.meta.fitness,wild:wildAgain?.meta.fitness,restored:imported?.meta.fitness,evaluations:merged.evaluations?.length,selfParent:merged.parentIds.includes(duplicate)}};
  });
  assert.equal(retrieval.first[0],'careful-seed');assert.equal(retrieval.second[0],'wild-seed');
  assert.equal(retrieval.federated[0],'careful-seed');
  assert.equal(retrieval.feedback.find(f=>f.id==='careful-seed').feedback,1);
  assert.equal(retrieval.feedback.find(f=>f.id==='wild-seed').feedback,null,'First transfer establishes its own baseline');
  assert.equal(retrieval.context.profile,'careful');assert.equal(retrieval.retainedBaseline,true);
  assert.ok(retrieval.metas.every(m=>m?.track==='fixture-track'));
  assert.deepEqual(retrieval.dedup,{id:'careful-seed',careful:4,wild:5,restored:4,evaluations:2,selfParent:false});
  mark('learning controls in 3D');
  await page.evaluate(()=>{window.CircuitStudio.setQuality('low');window.CircuitStudio.forceWebGL=true;});
  await page.locator('#graphics-toggle').click({timeout:90000});await page.waitForFunction(()=>window.CircuitStudio.active,{},{timeout:90000});
  await page.locator('#driver-learning summary').click();
  await page.screenshot({path:`${out}/profiles-3d-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`${out}/profiles-3d-mobile.png`});
  const mobile=await page.locator('.learning-panel').boundingBox();assert.ok(mobile.x>=0&&mobile.x+mobile.width<=390&&mobile.y+mobile.height<=844);
  assert.deepEqual(errors,[]);
  await writeFile(`${out}/result.json`,JSON.stringify({passed:true,retrieval,baseline,checks:['profiles','real worker learning','manual override','persistent champion','SONA circuit example replay','genetic baseline','context-aware WASM retrieval','offspring credit','archive round trip','cross-tab context','2D/3D/mobile learning UI']},null,2));
  console.log('Driver profiles and learning browser checks passed');
}catch(error){
  await writeFile(`${out}/failure.json`,JSON.stringify({stage,error:String(error.stack),errors},null,2));
  await page?.screenshot({path:`${out}/failure.png`}).catch(()=>{});throw error;
}finally{await browser?.close();server.kill();}
