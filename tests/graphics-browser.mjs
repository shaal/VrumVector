import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const out='test-results/graphics';
await mkdir(out,{recursive:true});
const server=spawn('python3',['-m','http.server','8877','--bind','127.0.0.1'],{stdio:'ignore'});
const origin='http://127.0.0.1:8877';
const report=[];
async function ready(page){
  await page.waitForFunction(()=>window.CircuitStudio?.active||window.CircuitStudio?.failed,{},{timeout:90000});
  assert.equal(await page.evaluate(()=>window.CircuitStudio.active),true,await page.locator('.studio-notice').textContent());
}
async function settle(page){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForTimeout(600);
}
async function exercise(backend){
  // Chromium's software adapters exercise actual shader compilation in CI.
  // These are test-only flags; the application requests normal browser APIs.
  const browser=await chromium.launch({headless:true,channel:'chromium',args:[
    '--use-angle=swiftshader','--enable-unsafe-swiftshader','--enable-unsafe-webgpu',
    '--disable-gpu-watchdog',
    ...(backend==='auto'?['--enable-features=Vulkan','--use-vulkan=swiftshader','--disable-vulkan-surface']:[]),
  ]});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();page.setDefaultTimeout(45000);
  const errors=[],warnings=[];
  page.on('pageerror',e=>errors.push(e.stack||e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|WebGL|WebGPU|WGSL|shader|validation|Circuit Studio/i.test(m.text()))errors.push(m.text());});
  page.on('console',m=>{if(m.type()==='warning')warnings.push(m.text());});
  let stage='initial scene';
  const watchdog=setTimeout(()=>{console.error(`${backend}: stalled at ${stage}`);browser.close().catch(()=>{});},360000);
  // Keep browser checks independent of analytics and font service uptime.
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  try{
    await page.goto(`${origin}/AI-Car-Racer/?rv=0&graphics=studio&backend=${backend}`);
    await ready(page);await settle(page);
    const selected=await page.evaluate(()=>window.CircuitStudio.backend);
    if(backend==='webgl')assert.equal(selected,'WebGL 2');
    console.log(`${backend}: renderer selected ${selected}`);
    await page.screenshot({path:`${out}/${backend}-day.png`});

    // Keep interaction tests responsive on CPU-only CI. The balanced pipeline
    // was rendered above; high quality (including reflections) is checked below.
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-setting="quality"]').selectOption('low');
    await page.locator('[data-action="settings"]').first().click();

    // Run the real worker with a small, short training cohort.
    stage='worker and cameras';console.log(`${backend}: ${stage}`);
    await page.evaluate(()=>{
      setN(48);setSeconds(3);setSimSpeed(1);
      simWorker.addEventListener('message',event=>{if(event.data.type==='genEnd')window.__testLastGenEnd=event.data;});
    });
    await page.locator('#startOverlayBtn').click();
    await page.waitForFunction(()=>window.CircuitStudio.archive.runs.length>0,{},{timeout:60000});
    await page.waitForFunction(()=>window.CircuitStudio.info.snapshot?.N===48);
    await page.locator('[data-camera="chase"]').click();await settle(page);
    await page.screenshot({path:`${out}/${backend}-chase.png`});
    await page.locator('[data-action="vision"]').click();await settle(page);
    assert.equal(await page.locator('[data-vision-panel]').isVisible(),true);
    // Generation-zero snapshots have no ray data yet. Wait for actual sensor
    // output instead of asserting during an arbitrary restart boundary.
    await page.waitForFunction(()=>window.CircuitStudio.sensors.count>0);
    await page.screenshot({path:`${out}/${backend}-vision.png`});

    stage='night and reflections';console.log(`${backend}: ${stage}`);
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-setting="quality"]').selectOption('high');
    await page.locator('[data-setting="theme"]').selectOption('alpine');
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-action="night"]').click();await settle(page);
    await ready(page);
    assert.equal(await page.evaluate(()=>!!window.CircuitStudio.reflection),true);
    await page.screenshot({path:`${out}/${backend}-night.png`});

    // Playback is separate from the live worker and uses recorded poses.
    stage='recorded playback';console.log(`${backend}: ${stage}`);
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-setting="quality"]').selectOption('low');
    await page.locator('[data-setting="ghosts"]').check();
    await page.locator('[data-action="replay"]').click();
    await page.locator('[data-action="replay-pause"]').click();
    await page.locator('[data-setting="rate"]').selectOption('0.25');
    const serial=await page.evaluate(()=>window.CircuitStudio.info.runSerial);
    const seek=await page.evaluate(()=>Math.min(.5,Math.floor(window.CircuitStudio.replay.run.duration/.1)*.05));
    await page.locator('[data-setting="scrub"]').fill(String(seek));
    assert.ok(Math.abs(await page.evaluate(()=>window.CircuitStudio.replay.time)-seek)<.001);
    await page.waitForFunction(before=>window.CircuitStudio.info.runSerial>before,serial,{timeout:60000});
    await page.screenshot({path:`${out}/${backend}-replay.png`});
    await page.locator('[data-action="live"]').click();
    assert.equal(await page.evaluate(()=>!!window.CircuitStudio.replay),false);

    stage='classic and mobile';console.log(`${backend}: ${stage}`);
    await page.locator('[data-action="training"]').click();
    await page.waitForFunction(()=>window.CircuitStudio.info.paused);
    // Re-deliver an actual worker result to reproduce a generation completion
    // that was already queued when Pause was clicked. It must remain paused.
    await page.evaluate(()=>simWorker.dispatchEvent(new MessageEvent('message',{data:window.__testLastGenEnd})));
    await page.waitForFunction(()=>window.CircuitStudio.info.paused);
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-action="classic"]').click();
    await page.waitForFunction(()=>!window.CircuitStudio.active);
    assert.equal(await page.locator('#myCanvas').isVisible(),true);
    await page.locator('.studio-launch').click();await ready(page);
    await page.keyboard.press('Escape');
    await page.locator('[data-action="night"]').click();
    await page.locator('[data-camera="orbit"]').click();
    await page.setViewportSize({width:390,height:844});await settle(page);
    await page.screenshot({path:`${out}/${backend}-mobile.png`});
    const bounds=await page.locator('.studio-dock').boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391&&bounds.y+bounds.height<=845,'Mobile controls fit the viewport');
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-setting="quality"]').selectOption('low');await settle(page);
    await ready(page);
    await page.keyboard.press('Escape');
    // The existing editor owns Canvas 2D and must become interactive again.
    await page.evaluate(()=>customizeTrack());
    await page.waitForFunction(()=>!window.CircuitStudio.active);
    assert.equal(await page.locator('#myCanvas').isVisible(),true);
    assert.deepEqual(errors,[],'No uncaught JavaScript or shader errors');
    report.push({requested:backend,selected,result:'pass',checks:'day, worker, chase, vision, night, reflections, replay, independent training, classic, mobile, editor'});
  }catch(error){
    await page.screenshot({path:`${out}/${backend}-failure.png`,timeout:10000}).catch(()=>{});
    const state=await page.evaluate(()=>{const s=window.CircuitStudio;return {active:s?.active,failed:s?.failed,lastError:s?.lastError,backend:s?.backend,frame:s?.info?.snapshot?.frameCount,rays:s?.info?.snapshot?.bestRays?.length,sensors:s?.sensors?.count};}).catch(()=>null);
    await writeFile(`${out}/${backend}-errors.txt`,JSON.stringify({stage,error:String(error),errors,warnings,state,body:await page.locator('body').innerText().catch(()=>'' )},null,2));
    throw error;
  }finally{clearTimeout(watchdog);await browser.close();}
}
async function fallback(){
  const browser=await chromium.launch({headless:true,args:['--disable-gpu','--disable-software-rasterizer']});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`${origin}/AI-Car-Racer/?rv=0&graphics=studio&backend=webgl`);
    await page.waitForFunction(()=>window.CircuitStudio?.failed);
    assert.equal(await page.locator('#myCanvas').isVisible(),true);
    await page.evaluate(()=>{setN(24);setSeconds(3);});
    await page.locator('#startOverlayBtn').click();
    await page.waitForFunction(()=>window.CircuitStudio.info.snapshot?.frameCount>0);
    assert.deepEqual(errors,[]);
    report.push({requested:'no GPU',selected:'Classic 2D',result:'pass'});
  }finally{await browser.close();}
}
try{
  for(let i=0;i<50;i++){try{await fetch(origin);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  const failures=[];
  const backends=process.env.STUDIO_TEST_BACKEND?[process.env.STUDIO_TEST_BACKEND]:['webgl','auto'];
  for(const backend of backends){try{await exercise(backend);}catch(error){console.error(error);failures.push(error);}}
  try{await fallback();}catch(error){console.error(error);failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Browser graphics verification failed');
}finally{
  server.kill();
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
