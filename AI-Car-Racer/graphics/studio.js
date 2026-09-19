import * as T from '../../vendor/three-0.186.0/three.js';
import { StudioUI } from './ui.js';
import { StudioAudio } from './audio.js';
import { buildWorld, createCar, createRain, disposeTree } from './world.js';
import { SnapshotBuffer, ReplayArchive, sampleRun, trackKey, worldX, worldZ, SCALE, clamp, finitePose } from './state.js';

const CAMERAS=['orbit','chase','overhead','director','trackside','front'];
const QUALITY={low:{dpr:1,shadow:512,cars:300,bloom:false},balanced:{dpr:1.25,shadow:1024,cars:800,bloom:true},high:{dpr:1.75,shadow:2048,cars:1600,bloom:true}};
class CircuitStudio {
  constructor(){
    this.host=document.getElementById('canvasDiv');
    const query=new URLSearchParams(location.search);
    let saved={};try{saved=JSON.parse(localStorage.getItem('vv.circuitStudio')||'{}');}catch{}
    this.enabled=query.get('graphics')==='classic'?false:query.has('graphics')?true:saved.enabled!==false;
    this.cameraMode=CAMERAS.includes(query.get('camera'))?query.get('camera'):CAMERAS.includes(saved.camera)?saved.camera:'orbit';
    this.theme=['circuit','alpine','desert'].includes(saved.theme)?saved.theme:'circuit';
    this.quality=QUALITY[query.get('quality')]?query.get('quality'):QUALITY[saved.quality]?saved.quality:innerWidth<600?'low':'balanced';
    this.night=query.get('scene')==='night'||!!saved.night;
    this.vision=query.get('vision')==='1'||!!saved.vision;
    this.ghosts=!!saved.ghosts;
    this.followTarget=saved.followTarget==='player'?'player':'ai';
    this.audio=new StudioAudio();
    this.forceWebGL=query.get('backend')==='webgl';
    this.reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{this.reducedMotion=e.matches;});
    this.buffer=new SnapshotBuffer();this.archive=new ReplayArchive();this.alive=0;
    this.active=false;this.ready=false;this.failed=false;this.loading=false;
    this.run=-1;this.trail=[];this.heat=new Float32Array(160*90);
    this.ui=new StudioUI(this,this.host);this.ui.sync();
    this.dummy=new T.Object3D();this.color=new T.Color();
    this.desiredEye=new T.Vector3();this.desiredLook=new T.Vector3();this.smoothLook=new T.Vector3();
    this.abort=new AbortController();
    document.addEventListener('visibilitychange',()=>{this.lastTime=performance.now();if(document.hidden)this.audio.silence();});
    window.addEventListener('pagehide',event=>{if(!event.persisted)this.dispose();});
  }
  save(){try{localStorage.setItem('vv.circuitStudio',JSON.stringify({enabled:this.enabled,camera:this.cameraMode,followTarget:this.followTarget,theme:this.theme,quality:this.quality,night:this.night,vision:this.vision,ghosts:this.ghosts}));}catch{}}
  enable(on){this.enabled=on;this.save();this.ui.message('');if(on&&this.failed){this.failed=false;this.ready=false;this.loading=false;}if(!on)this.stopReplay();}
  async init(){
    if(this.loading||this.ready||this.failed)return;this.loading=true;
    try{
      // Avoid entering Three's WebGL backend when this browser has no GPU
      // context at all (remote desktops and disabled hardware acceleration).
      const gpuAvailable=!this.forceWebGL&&navigator.gpu&&await navigator.gpu.requestAdapter();
      if(!gpuAvailable){
        const probe=document.createElement('canvas').getContext('webgl2');
        if(!probe)throw new Error('WebGPU and WebGL 2 are unavailable.');
        probe.getExtension('WEBGL_lose_context')?.loseContext();
      }
      this.canvas=document.createElement('canvas');this.canvas.id='studio-canvas';this.canvas.hidden=true;
      this.canvas.tabIndex=0;this.canvas.setAttribute('aria-label','3D race circuit. Drag to orbit; use the scene controls to change camera.');
      this.host.prepend(this.canvas);
      this.renderer=new T.WebGPURenderer({canvas:this.canvas,antialias:true,forceWebGL:this.forceWebGL,powerPreference:'high-performance'});
      this.renderer.onDeviceLost=info=>this.fail(new Error(`The graphics device was reset: ${info.message||info.reason||'unknown reason'}`));
      await this.renderer.init();
      if(this.disposed)return;
      this.backend=this.renderer.backend.isWebGPUBackend?'WebGPU':'WebGL 2';
      this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.04;
      this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFShadowMap;
      this.scene=new T.Scene();this.scene.background=new T.Color(0xe1dbcd);this.scene.fog=new T.Fog(0xe1dbcd,145,420);
      this.camera=new T.PerspectiveCamera(42,1,.1,700);
      this.camera.position.set(70,75,88);
      this.controls=new T.OrbitControls(this.camera,this.canvas);
      this.controls.enableDamping=!this.reducedMotion;this.controls.dampingFactor=.075;
      this.controls.minDistance=8;this.controls.maxDistance=310;this.controls.maxPolarAngle=Math.PI*.475;
      this.controls.target.set(0,0,0);this.controls.update();
      this.ambient=new T.HemisphereLight(0xe7f0e9,0x74735b,2.4);this.scene.add(this.ambient);
      this.sun=new T.DirectionalLight(0xffead0,3.1);this.sun.position.set(-44,74,32);this.sun.castShadow=true;
      Object.assign(this.sun.shadow.camera,{left:-75,right:75,top:65,bottom:-65,near:1,far:180});
      this.sun.shadow.normalBias=.08;this.sun.shadow.bias=-.0001;this.scene.add(this.sun);
      this.rim=new T.DirectionalLight(0xb6dce7,.7);this.rim.position.set(35,25,-30);this.scene.add(this.rim);
      this.hero=createCar();this.scene.add(this.hero);
      this.liveCars=new Map();
      this.liveLabels=document.createElement('div');this.liveLabels.className='live-driver-labels';this.host.append(this.liveLabels);
      this.players=[createCar(0xc55146),createCar(0x539bbb)];this.players.forEach(c=>{c.visible=false;this.scene.add(c);});
      this.ghostCars=[createCar(0x82e4c5,true),createCar(0xedb67a,true)];this.ghostCars.forEach(c=>{c.visible=false;this.scene.add(c);});
      this.pack=new T.InstancedMesh(new T.BoxGeometry(.94,.30,1.62),new T.MeshStandardMaterial({color:0xffffff,roughness:.55,metalness:.15}),1600);
      this.pack.setColorAt(0,new T.Color(0xffffff));
      this.pack.instanceMatrix.setUsage(T.DynamicDrawUsage);this.pack.frustumCulled=false;this.pack.count=0;this.pack.castShadow=true;this.scene.add(this.pack);
      this.packWindows=new T.InstancedMesh(new T.BoxGeometry(.62,.20,.65),new T.MeshStandardMaterial({color:0x1c383a,roughness:.3,metalness:.35}),1600);
      this.packWindows.instanceMatrix.setUsage(T.DynamicDrawUsage);this.packWindows.frustumCulled=false;this.packWindows.count=0;this.scene.add(this.packWindows);
      this.sensors=new T.InstancedMesh(new T.BoxGeometry(.05,.035,1),new T.MeshBasicMaterial({color:0x79ffe0,toneMapped:false}),32);
      this.sensors.instanceMatrix.setUsage(T.DynamicDrawUsage);this.sensors.frustumCulled=false;this.sensors.count=0;this.scene.add(this.sensors);
      this.sensorHits=new T.InstancedMesh(new T.SphereGeometry(.14,8,6),new T.MeshBasicMaterial({color:0xc5ffee,toneMapped:false}),32);
      this.sensorHits.frustumCulled=false;this.sensorHits.count=0;this.scene.add(this.sensorHits);
      this.trailMesh=new T.InstancedMesh(new T.BoxGeometry(.11,.035,1),new T.MeshBasicMaterial({color:0x73bda7,transparent:true,opacity:.65,depthWrite:false}),160);
      this.trailMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);this.trailMesh.frustumCulled=false;this.trailMesh.count=0;this.scene.add(this.trailMesh);
      this.rain=createRain();this.scene.add(this.rain);
      this.headlight=new T.SpotLight(0xd2fff2,0,26,Math.PI*.22,.8,2);this.scene.add(this.headlight,this.headlight.target);
      const pass=T.pass(this.scene,this.camera);
      this.bloom=T.bloom(pass.getTextureNode('output'),.17,.45,1.5);
      this.pipeline=new T.RenderPipeline(this.renderer);this.pipeline.outputNode=pass.add(this.bloom);
      this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.host);
      this.ready=true;this.loading=false;this.applyQuality();this.resize();this.resetCamera=true;this.ui.sync();
    }catch(error){this.fail(error);}
  }
  fail(error){
    this.lastError=String(error?.stack||error);
    console.warn('[Circuit Studio]',error);
    this.failed=true;this.loading=false;this.ready=false;this.setActive(false);
    this.ui.message('Circuit Studio could not start on this device. You can keep training in Classic 2D, or reopen Studio to retry.');
    this.releaseRenderer();
  }
  releaseRenderer(){
    this.liveLabels?.remove();this.liveCars?.clear();
    this.resizeObserver?.disconnect();this.controls?.dispose();
    this.reflection?.dispose();this.reflection=null;
    this.pipeline?.dispose();this.bloom?.dispose();
    if(this.world){this.world.heatTexture.dispose();this.world=null;}
    if(this.scene)disposeTree(this.scene);
    const renderer=this.renderer;this.renderer=null;
    if(renderer){try{Promise.resolve(renderer.dispose()).catch(()=>{});}catch{}}
    this.canvas?.remove();this.scene=null;
  }
  dispose(){this.disposed=true;this.audio.dispose();this.releaseRenderer();}
  setActive(active){
    if(this.active===active)return;this.active=active;
    this.host.classList.toggle('studio-active',active);document.body.classList.toggle('studio-enabled',active);
    this.ui.root.hidden=!active;if(this.canvas)this.canvas.hidden=!active;
    if(this.liveLabels)this.liveLabels.hidden=!active;
    if(!active){if(this.controls)this.controls.enabled=false;this.audio.silence();}
    this.lastTime=performance.now();this.resize();
  }
  resize(){
    if(!this.renderer||!this.camera)return;
    const {width,height}=this.host.getBoundingClientRect();if(width<2||height<2)return;
    this.renderer.setSize(Math.floor(width),Math.floor(height),false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();
    if(this.cameraMode==='orbit'&&(!this.wasSized||this.lastAspect&&Math.abs(this.lastAspect-this.camera.aspect)>.5))this.resetCamera=true;
    this.lastAspect=this.camera.aspect;this.wasSized=true;
  }
  applyQuality(){
    if(!this.ready)return;const q=QUALITY[this.quality];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,q.dpr));
    // ShadowNode owns this render target and resizes it from mapSize. Disposing
    // the target here leaves its cached node bindings pointing at freed textures.
    this.sun.shadow.mapSize.set(q.shadow,q.shadow);this.sun.shadow.needsUpdate=true;
    this.renderer.shadowMap.enabled=true;this.pack.castShadow=this.quality!=='low';
    this.resize();this.updateReflection();
  }
  setQuality(value){if(!QUALITY[value])return;this.quality=value;this.applyQuality();this.save();this.ui.sync();}
  setTheme(value){if(!['circuit','alpine','desert'].includes(value))return;this.theme=value;this.worldKey=null;this.save();this.ui.sync();}
  setNight(on){this.night=on;this.applyLighting();this.updateReflection();this.save();this.ui.sync();}
  setVision(on){this.vision=on;this.trail=[];if(this.world)this.world.vision.value=+on;this.save();this.ui.sync();}
  setFollowTarget(target){
    if(!['ai','player'].includes(target))return;
    this.stopReplay();this.followTarget=target;this.trail=[];this.setCamera('chase',true);
  }
  async setSound(on){
    if(this.soundPending)return;
    this.soundPending=true;this.ui.sync();
    try{await this.audio.setEnabled(on);}finally{this.soundPending=false;this.ui.sync();}
  }
  setCamera(mode,reset=false){if(!CAMERAS.includes(mode))return;this.cameraMode=mode;this.resetCamera=reset||mode==='orbit';this.cameraModeStarted=performance.now();this.save();this.ui.sync();}
  applyLighting(){
    if(!this.ready||!this.world)return;
    this.world.setNight(this.night);
    const color=this.night?0x122b38:this.world.theme.sky;
    this.scene.background.setHex(color);this.scene.fog.color.setHex(color);
    this.ambient.intensity=this.night?.7:2.4;
    this.sun.color.setHex(this.night?0x9ecbdc:0xffead0);this.sun.intensity=this.night?.8:3.1;
    this.rim.intensity=this.night?1.2:.7;
    this.renderer.toneMappingExposure=this.night?1.2:1.04;
    this.bloom.strength.value=this.night?.25:.10;
  }
  updateReflection(){
    if(!this.ready||!this.world)return;
    this.reflection?.dispose();this.reflection?.target.removeFromParent();this.reflection=null;
    const uv=T.vec2(T.positionWorld.x.div(112).add(.5),T.positionWorld.z.div(-63).add(.5));
    const heat=T.texture(this.world.heatTexture,uv).rgb.mul(this.world.vision).mul(1.8);
    this.world.roadMat.emissiveNode=heat;
    if(this.night&&this.quality==='high'){
      this.reflection=T.reflector({resolutionScale:.25});this.reflection.target.rotateX(-Math.PI/2);
      this.reflection.target.position.y=.015;this.scene.add(this.reflection.target);
      this.world.roadMat.emissiveNode=heat.add(this.reflection.mul(.25));
    }
    this.world.roadMat.needsUpdate=true;
  }
  rebuildWorld(info){
    this.reflection?.dispose();this.reflection?.target.removeFromParent();this.reflection=null;
    if(this.world){disposeTree(this.world.root);this.world.heatTexture.dispose();}
    this.world=buildWorld(info.road,this.theme,this.quality);this.scene.add(this.world.root);
    this.world.vision.value=+this.vision;this.worldKey=trackKey(info.road)+'/'+this.theme;
    const key=trackKey(info.road);
    if(key!==this.archive.key){this.archive.setTrack(key);this.stopReplay();this.ui.runsChanged();this.heat.fill(0);this.trail=[];this.buffer.reset();this.lastSnapshot=null;this.run=-1;}
    this.applyLighting();this.updateReflection();this.resetCamera=true;
  }
  onGenerationEnd(data,generation){
    if(data.presentationRun&&this.archive.add({...data.presentationRun,generation})){this.ui.runsChanged();}
  }
  startReplay(index){
    const run=this.archive.runs[index];if(!run)return;
    this.replay={run,time:0,rate:1,paused:false};this.trail=[];this.setCamera('chase');
    this.ui.root.querySelector('[data-setting="rate"]').value='1';this.ui.sync();
  }
  stopReplay(){if(this.replay){this.replay=null;this.trail=[];this.resetCamera=true;this.ui.sync();}}
  frame(info){
    if(this.disposed)return false;this.info=info;
    const eligible=info.phase===4&&!this.host.classList.contains('ab-on');
    this.ui.notice.hidden=!eligible||!this.failed;
    this.ui.launch.hidden=!eligible||this.active;this.ui.launch.textContent=this.loading?'Preparing Circuit Studio…':'Open Circuit Studio';
    if(!eligible||!this.enabled||this.failed){this.setActive(false);return false;}
    if(!this.ready){this.init();return false;}
    try{
      const key=trackKey(info.road)+'/'+this.theme;
      if(key!==this.worldKey||!this.world)this.rebuildWorld(info);
      this.setActive(true);this.ui.launch.hidden=true;
      if(document.hidden)return true;
      const now=performance.now(),dt=clamp((now-(this.lastTime||now))/1000,0,.05);this.lastTime=now;
      if(info.runSerial!==this.run){
        this.run=info.runSerial;this.buffer.reset();this.lastSnapshot=null;this.focusIndex=-1;this.trail=[];
        this.resetCamera=this.resetCamera||this.cameraMode!=='orbit';
        for(let i=0;i<this.heat.length;i++)this.heat[i]*=.55;
      }
      if(info.snapshot&&this.buffer.push(info.snapshot,this.run,now))this.observeSnapshot(info.snapshot,now);
      if(this.replay&&!this.replay.paused){this.replay.time=Math.min(this.replay.run.duration,this.replay.time+dt*this.replay.rate);if(this.replay.time===this.replay.run.duration)this.replay.paused=true;}
      this.updateCars(info,now,dt);
      this.updateCamera(info,now,dt);
      this.updateLiveDrivers(now,dt);
      this.audio.update({pose:this.focusPose,controls:this.focusControls,maxSpeed:this.followingPlayer?info.players[1].maxSpeed:info.snapshot?.bestMaxSpeed,
        key:this.replay?`replay/${this.replay.run.generation}/${this.replay.run.driverIndex}`:`${this.run}/${this.followingPlayer?'player':this.focusIndex}`,
        paused:info.awaitingStart||(this.replay?this.replay.paused:info.paused)});
      this.scene.fog.near=Math.max(145,this.camera.position.length()-40);
      this.scene.fog.far=this.scene.fog.near+275;
      this.rain.visible=this.night&&!this.reducedMotion&&this.quality!=='low';
      this.world.vision.value=+this.vision;
      if(now-(this.heatUpdated||0)>200){this.updateHeat();this.heatUpdated=now;}
      if(QUALITY[this.quality].bloom)this.pipeline.render();else this.renderer.render(this.scene,this.camera);
      this.ui.update(info,now);return true;
    }catch(error){this.fail(error);return false;}
  }
  observeSnapshot(snap,now){
    this.alive=0;const prev=this.lastSnapshot;
    for(let i=0;i<snap.N;i++){
      const o=i*5;
      if(!snap.positions[o+3])this.alive++;
      else if(!prev||prev.N!==snap.N||!prev.positions[o+3]){
        const x=clamp(Math.floor(snap.positions[o]/20),0,159),y=clamp(Math.floor(snap.positions[o+1]/20),0,89);
        this.heat[y*160+x]=Math.min(100,this.heat[y*160+x]+1);
      }
    }
    const dead=this.focusIndex<0||this.focusIndex>=snap.N||!!snap.positions[this.focusIndex*5+3];
    if(this.vision||dead||now-(this.focusSince||0)>8000){
      if(this.focusIndex!==snap.bestIdx){this.trail=[];this.focusSince=now;}
      this.focusIndex=snap.bestIdx;
    }
    this.lastSnapshot=snap;
  }
  updateLiveDrivers(now,dt){
    const drivers=this.replay?[]:window.LiveSession?.drivers(now)||[];
    const ids=new Set(drivers.map(p=>p.id));
    for(const [id,item] of this.liveCars){
      if(!ids.has(id)){disposeTree(item.car);item.label.remove();this.liveCars.delete(id);}
    }
    this.camera.updateMatrixWorld();
    const point=new T.Vector3(),width=this.host.clientWidth,height=this.host.clientHeight;
    for(const driver of drivers){
      let item=this.liveCars.get(driver.id);
      if(!item){
        const car=createCar(new T.Color(driver.color).getHex());this.scene.add(car);
        const label=document.createElement('span');label.className='live-driver-label';this.liveLabels.append(label);
        item={car,label};this.liveCars.set(driver.id,item);
      }
      this.placeCar(item.car,driver.pose,dt);
      item.label.textContent=driver.name+(driver.pose.paused?' · paused':'');item.label.style.borderColor=driver.color;
      point.copy(item.car.position);point.y+=1.9;point.project(this.camera);
      item.label.hidden=point.z< -1||point.z>1||Math.abs(point.x)>1||Math.abs(point.y)>1;
      item.label.style.transform=`translate(${(point.x+1)*width/2}px,${(1-point.y)*height/2}px) translate(-50%,-100%)`;
    }
  }
  updateHeat(){
    const ctx=this.world.heatCanvas.getContext('2d');ctx.clearRect(0,0,160,90);
    ctx.globalCompositeOperation='lighter';
    for(let i=0;i<this.heat.length;i++){
      const value=this.heat[i];if(value<.05)continue;
      const x=i%160,y=Math.floor(i/160),a=Math.min(.6,Math.log1p(value)*.13);
      const gradient=ctx.createRadialGradient(x,y,0,x,y,3.8);gradient.addColorStop(0,`rgba(240,109,33,${a})`);gradient.addColorStop(1,'rgba(120,25,5,0)');
      ctx.fillStyle=gradient;ctx.fillRect(x-4,y-4,8,8);
    }
    this.world.heatTexture.needsUpdate=true;
  }
  placeCar(car,pose,dt,controls){
    car.position.set(worldX(pose.x),.025,worldZ(pose.y));car.rotation.y=pose.angle;
    car.visible=true;
    const steer=controls?((+!!controls[1])-(+!!controls[2]))*.25:0;
    for(const wheel of car.userData.wheels){
      if(wheel.front)wheel.pivot.rotation.y=steer;
      wheel.tire.rotation.x-=(pose.speed||0)*SCALE*60*dt/.23;
      wheel.hub.rotation.x=wheel.tire.rotation.x;
    }
  }
  fitOrbit(){
    this.controls.target.set(0,0,0);
    const point=new T.Vector3();let scale=1;
    // Fit the diorama itself in both portrait and landscape, with space for
    // the camera dock. A square-root aspect heuristic clips narrow screens.
    for(let attempt=0;attempt<28;attempt++){
      this.camera.position.set(65*scale,70*scale,86*scale);
      this.camera.lookAt(0,0,0);this.camera.updateMatrixWorld();
      let fits=true;
      for(const x of [-61,61])for(const z of [-36,36]){
        point.set(x,0,z).project(this.camera);
        if(Math.abs(point.x)>.88||point.y<-.74||point.y>.6)fits=false;
      }
      if(fits)break;scale*=1.08;
    }
    this.controls.maxDistance=Math.max(310,this.camera.position.length()*1.5);
    this.camera.far=Math.max(700,this.controls.maxDistance+200);this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  segment(mesh,index,a,b,width=.05,height=.3){
    const d=this.dummy,ax=worldX(a.x),az=worldZ(a.y),bx=worldX(b.x),bz=worldZ(b.y);
    d.position.set((ax+bx)/2,height,(az+bz)/2);d.rotation.set(0,Math.atan2(bx-ax,bz-az),0);
    d.scale.set(width/.05,1,Math.max(.001,Math.hypot(bx-ax,bz-az)));d.updateMatrix();mesh.setMatrixAt(index,d.matrix);
  }
  updateCars(info,now,dt){
    const snap=info.snapshot;
    let pose=this.replay?sampleRun(this.replay.run,this.replay.time):this.buffer.pose(this.focusIndex,now,!this.vision&&!this.reducedMotion);
    this.replayPose=this.replay?pose:null;
    if(!pose)pose={x:info.startInfo.x,y:info.startInfo.y,angle:info.startInfo.heading||0,speed:0};
    if(!this.replay&&this.focusIndex===snap?.bestIdx)pose.speed=snap.bestSpeed;
    this.followingPlayer=!this.replay&&this.followTarget==='player'&&finitePose(info.players[1]);
    this.focusPose=this.followingPlayer?info.players[1]:pose;
    const controls=this.replay?[pose.controls&1,pose.controls&2,pose.controls&4,pose.controls&8]:this.focusIndex===snap?.bestIdx?snap.bestControls:null;
    const player=info.players[1];
    this.focusControls=this.followingPlayer?[player.controls.forward,player.controls.left,player.controls.right,player.controls.reverse]:controls;
    this.placeCar(this.hero,pose,dt,controls);
    let count=0;
    if(snap&&!this.replay){
      const step=Math.max(1,Math.ceil(snap.N/QUALITY[this.quality].cars));
      for(let i=0;i<snap.N&&count<1600;i+=step){
        if(i===this.focusIndex)continue;
        const p=this.buffer.pose(i,now,!this.reducedMotion);if(!p||p.damaged)continue;
        const d=this.dummy;d.position.set(worldX(p.x),.32,worldZ(p.y));d.rotation.set(0,p.angle,0);d.scale.set(1,1,1);d.updateMatrix();this.pack.setMatrixAt(count,d.matrix);
        const fit=clamp(p.progress/Math.max(1,snap.bestCheckpoints+snap.bestLaps*(info.road.checkPointList.length||1)),0,1);
        this.color.setHSL(.08+fit*.32,.35,.42+fit*.15);this.pack.setColorAt(count,this.color);
        d.position.y=.55;d.updateMatrix();this.packWindows.setMatrixAt(count,d.matrix);count++;
      }
    }
    this.pack.count=this.packWindows.count=count;this.pack.instanceMatrix.needsUpdate=true;this.packWindows.instanceMatrix.needsUpdate=true;
    if(this.pack.instanceColor)this.pack.instanceColor.needsUpdate=true;
    this.players.forEach((car,i)=>{const p=info.players[i];car.visible=finitePose(p)&&!this.replay&&(Math.abs(p.speed)>.01||(i===1&&this.followingPlayer));if(car.visible)this.placeCar(car,p,dt,[p.controls.forward,p.controls.left,p.controls.right,p.controls.reverse]);});
    this.ghostCars.forEach((car,i)=>{
      const run=this.archive.runs.filter(r=>r!==this.replay?.run)[i];
      const time=this.replay?this.replay.time:(snap?.frameCount||0)/60;
      const p=this.ghosts&&run&&time<=run.duration?sampleRun(run,time):null;
      car.visible=!!p;if(p)this.placeCar(car,p,dt,null);
    });
    this.sensors.count=this.sensorHits.count=0;
    if(this.vision&&!this.replay&&(this.followingPlayer?player.sensor?.rays:snap?.bestRays)){
      const R=this.followingPlayer?player.sensor.rays:snap.bestRays,H=this.followingPlayer?player.sensor.readings:snap.bestReadings;
      const n=Math.min(32,this.followingPlayer?R.length:R.length/4);
      for(let i=0;i<n;i++){
        const hit=this.followingPlayer?!!H?.[i]:H&&H[i*3+2]>=0;
        const a=this.followingPlayer?R[i][0]:{x:R[i*4],y:R[i*4+1]};
        const b=this.followingPlayer?(hit?H[i]:R[i][1]):{x:hit?H[i*3]:R[i*4+2],y:hit?H[i*3+1]:R[i*4+3]};
        this.segment(this.sensors,i,a,b,.055,.30);
        const d=this.dummy;d.position.set(worldX(b.x),.3,worldZ(b.y));d.rotation.set(0,0,0);d.scale.setScalar(hit?1:.5);d.updateMatrix();this.sensorHits.setMatrixAt(i,d.matrix);
      }
      this.sensors.count=this.sensorHits.count=n;this.sensors.instanceMatrix.needsUpdate=true;this.sensorHits.instanceMatrix.needsUpdate=true;
    }
    pose=this.focusPose;
    if(!info.paused||this.replay){
      const last=this.trail.at(-1),dist=last?Math.hypot(pose.x-last.x,pose.y-last.y):0;
      if(dist>150)this.trail=[];
      if(!last||dist>6){this.trail.push({x:pose.x,y:pose.y});if(this.trail.length>160)this.trail.shift();}
    }
    this.trailMesh.count=0;
    if(this.vision||this.ghosts){for(let i=1;i<this.trail.length;i++)this.segment(this.trailMesh,i-1,this.trail[i-1],this.trail[i],.05,.06);this.trailMesh.count=Math.max(0,this.trail.length-1);this.trailMesh.instanceMatrix.needsUpdate=true;}
    this.headlight.intensity=this.night?90:0;
    this.headlight.position.set(worldX(pose.x),.65,worldZ(pose.y));
    this.headlight.target.position.set(worldX(pose.x)-Math.sin(pose.angle)*10,.1,worldZ(pose.y)-Math.cos(pose.angle)*10);
  }
  updateCamera(info,now,dt){
    let mode=this.cameraMode;
    if(info.simSpeed>5&&!this.replay&&!this.followingPlayer)mode='overhead';
    if(mode==='director')mode=this.reducedMotion?'overhead':['orbit','chase','front','trackside'][Math.floor((now-(this.cameraModeStarted||0))/6500)%4];
    this.controls.enabled=mode==='orbit'&&this.cameraMode==='orbit';
    const eye=this.desiredEye,look=this.desiredLook,p=this.focusPose;
    const x=worldX(p.x),z=worldZ(p.y),a=p.angle,fx=-Math.sin(a),fz=-Math.cos(a);
    // A non-finite source pose must never poison smoothing permanently. Lerp
    // with t=1 still keeps NaN, so resets copy the desired position outright.
    const reset=this.resetCamera||!Number.isFinite(this.camera.position.lengthSq())||!Number.isFinite(this.smoothLook.lengthSq());
    if(reset){
      if(mode==='orbit'&&this.cameraMode==='orbit')this.fitOrbit();
      this.smoothLook.set(0,0,0);this.resetCamera=false;
    }
    if(mode==='orbit'&&this.cameraMode==='orbit'){this.controls.enableDamping=!this.reducedMotion;this.controls.update();return;}
    this.controls.enabled=false;
    if(mode==='orbit'){
      const scale=Math.max(1,Math.sqrt(1.65/this.camera.aspect)),theta=.6+(now/1000)*.025;
      eye.set(Math.sin(theta)*110*scale,77*scale,Math.cos(theta)*110*scale);look.set(0,0,0);
    }else if(mode==='overhead'){
      const h=Math.max(78/2,124/(2*this.camera.aspect))/Math.tan(T.MathUtils.degToRad(this.camera.fov/2));eye.set(0,h,.02);look.set(0,0,0);
    }else if(mode==='chase'){
      eye.set(x-fx*8.5,4.8,z-fz*8.5);look.set(x+fx*5,.4,z+fz*5);
    }else if(mode==='front'){
      eye.set(x+fx*9,3.0,z+fz*9);look.set(x-fx*1.5,.45,z-fz*1.5);
    }else{
      if(reset||!this.tracksideEye||now-(this.tracksideSince||0)>7000){
        this.tracksideEye=new T.Vector3(x+fz*13+fx*16,3.8,z-fx*13+fz*16);this.tracksideSince=now;
      }
      eye.copy(this.tracksideEye);look.set(x,.4,z);
    }
    if(reset||this.reducedMotion){this.camera.position.copy(eye);this.smoothLook.copy(look);}
    else{const smooth=1-Math.exp(-dt*4);this.camera.position.lerp(eye,smooth);this.smoothLook.lerp(look,smooth);}
    this.camera.lookAt(this.smoothLook);
  }
}

window.CircuitStudio=new CircuitStudio();
