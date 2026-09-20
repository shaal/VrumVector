import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import * as liveState from '../AI-Car-Racer/multiplayer/state.js';
const {cleanCallsign,randomCallsign,validState,samplePeer,LapClock,roomKey,AWAY_TTL,ACTIVE_TTL,presenceTTL,driverLabel}=liveState;

const pose={x:100,y:100,angle:0,speed:2,damaged:false,paused:false,away:false,laps:0,bestLap:null};
const setup={inner:[{x:100,y:100},{x:200,y:100},{x:200,y:200}],outer:[{x:0,y:0},{x:300,y:0},{x:300,y:300}],gates:[[{x:100,y:100},{x:0,y:0}],[{x:200,y:200},{x:300,y:300}]],maxSpeed:15,traction:.5,invincible:false};
let mf;
before(async()=>{
  const bundle=await build({entryPoints:['multiplayer/worker.js'],bundle:true,write:false,format:'esm',external:['cloudflare:workers']});
  mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-17',durableObjects:{ROOMS:{className:'LiveRoom',useSQLite:true}},bindings:{ALLOW_LOCAL:'true'}});
  await mf.ready;
});
after(async()=>{await mf?.dispose();});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){const v=fn();if(v)return v;await delay(20);}throw new Error('Timed out waiting for a room event');}
async function join(name,room='a'.repeat(64)){
  const response=await mf.dispatchFetch(`http://local/${room==='lobby'?'lobby':'room/'+room}?name=${encodeURIComponent(name)}`,{headers:{Upgrade:'websocket',Origin:'http://127.0.0.1:8877'}});
  assert.equal(response.status,101);
  const ws=response.webSocket,messages=[];
  ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));ws.accept();
  const welcome=await until(()=>messages.find(m=>m.type==='welcome'));
  return {ws,messages,welcome,send(state=pose,seq=0,call=name){ws.send(JSON.stringify({type:'state',name:call,state,seq}));}};
}
test('callsigns are bounded plain text and random assignment does not use the training RNG',()=>{
  assert.equal(cleanCallsign(' <b> Fox 🏁 </b> '),'b Fox b');
  assert.equal(cleanCallsign('  Silver   Fox  '),'Silver Fox');
  assert.equal(cleanCallsign('x'.repeat(100)).length,24);
  assert.match(randomCallsign(a=>{a.set([0,1,2]);return a;}),/^Neon Falcon 12$/);
});
test('wire states reject nonfinite coordinates and impossible scores',()=>{
  assert.deepEqual(validState(pose),pose);
  for(const changed of [{x:NaN},{y:Infinity},{angle:1e10},{speed:101},{laps:-1},{bestLap:.5},{bestLap:'12'}])assert.equal(validState({...pose,...changed}),null);
});
test('peer interpolation wraps angles, snaps respawns and expires stale poses',()=>{
  const peer={previous:{...pose,x:0,angle:Math.PI-.1},current:{...pose,x:100,angle:-Math.PI+.1},received:100,interval:100};
  assert.equal(samplePeer(peer,150).x,50);assert.ok(Math.abs(samplePeer(peer,150).angle-Math.PI)<1e-8);
  assert.equal(samplePeer(peer,4000),null);
  assert.equal(samplePeer({...peer,current:{...pose,x:1000}},150).x,1000);
});
test('away cars stay parked through throttled timers, then expire; legacy states still work',()=>{
  const {away,...legacy}=pose;
  assert.deepEqual(validState(legacy),pose);
  assert.equal(validState({...pose,away:'true'}),null);
  const parked=validState({...pose,away:true});
  assert.equal(parked.paused,true);assert.equal(parked.speed,0);
  const peer={previous:{...pose,x:0},current:parked,received:1000,interval:60000};
  assert.equal(samplePeer(peer,1000).x,pose.x,'An away car snaps directly to its parked position');
  assert.deepEqual(samplePeer(peer,121000),parked,'Two delayed minute-long timer batches retain the parked car');
  assert.equal(samplePeer(peer,1001+AWAY_TTL),null);
  assert.equal(samplePeer({...peer,previous:parked,current:{...pose,x:120}},1000).x,120,'Returning drivers do not interpolate over the background interval');
  assert.equal(presenceTTL(parked),AWAY_TTL);assert.equal(presenceTTL(pose),ACTIVE_TTL);
  assert.equal(driverLabel('Fox',parked),'Fox · away');
  assert.equal(driverLabel('Fox',{...pose,paused:true}),'Fox · paused');
  assert.equal(driverLabel('Fox',pose),'Fox');
});

const clientSource=(await readFile(new URL('../AI-Car-Racer/multiplayer/client.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'')
  .replaceAll('import.meta.url',JSON.stringify('http://localhost/multiplayer/client.js'))
  .replace('window.LiveSession=new LiveSession();','globalThis.Session=LiveSession;');
function clientClock(){
  let now=1000,closed=0,cleared=0;
  const document=new EventTarget(),window=new EventTarget(),sent=[],storage=new Map([['vv.callsign','Test Driver']]),speeds=[];
  document.hidden=false;document.getElementById=()=>({classList:{contains:()=>false}});
  window.setSimSpeed=value=>speeds.push(value);
  const context=vm.createContext({...liveState,document,window,crypto:webcrypto,TextEncoder,performance:{now:()=>now},setInterval(){},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},trackKey:()=> 'test track',WebSocket:{OPEN:1}});
  vm.runInContext(clientSource,context);
  context.Session.prototype.createUI=function(){this.root={hidden:false};this.checkbox={};};
  context.Session.prototype.renderUI=function(){};
  const session=new context.Session();
  session.info={road:{innerList:setup.inner,outerList:setup.outer,checkPointList:setup.gates},players:[null,{...pose,controls:{clear(){cleared++;}}}],maxSpeed:15,traction:.5,invincible:false};
  session.setup=setup;session.key=liveState.setupKey(setup);session.enabled=true;session.connected=true;session.id='same-driver';session.lastAck=now;
  const socket={readyState:1,bufferedAmount:0,send(data){sent.push(JSON.parse(data));},close(){closed++;}};
  session.ws=socket;
  return {session,document,window,socket,sent,storage,speeds,newSession:()=>new context.Session(),get closed(){return closed;},get cleared(){return cleared;},
    advance(ms){now+=ms;},visibility(hidden){document.hidden=hidden;document.dispatchEvent(new Event('visibilitychange'));}};
}
test('new visitors join automatically at 1× with drivers hidden, without starting training',()=>{
  const c=clientClock(),s=c.newSession();let joins=0,starts=0;
  c.window.__awaitingStart=true;c.window.pauseGame=()=>starts++;
  s.connect=()=>joins++;
  assert.equal(s.enabled,true);assert.equal(s.showDrivers,false);
  s.frame({...c.session.info,phase:4,paused:true,awaitingStart:true});s.tick();
  assert.equal(joins,1);assert.deepEqual(c.speeds,[1]);assert.equal(starts,0);
  assert.equal(s.clock.running,false);
});
test('visibility changes keep sharing and the same socket; opt-out and explicit choices persist',()=>{
  const c=clientClock(),s=c.session;
  s.receive({id:'rival',name:'Other driver',color:liveState.COLORS[1],state:pose,setup});
  assert.equal(s.peers.size,1);assert.equal(s.drivers().length,0);
  s.drawClassic(new Proxy({},{get(){throw new Error('Hidden drivers must not draw in Classic or Tilt');}}));
  s.tick();assert.equal(c.sent.length,1,'Hidden rivals do not stop your own car being shared');
  s.clock.running=true;s.setShowDrivers(true);
  assert.equal(s.drivers().length,1);assert.equal(s.ws,c.socket);assert.equal(s.clock.running,true);
  assert.equal(c.newSession().showDrivers,true,'An explicit display choice survives reload');
  s.setShowDrivers(false);assert.equal(s.drivers().length,0);assert.equal(c.closed,0);
  s.setEnabled(false);
  const returning=c.newSession();
  assert.equal(returning.enabled,false);assert.equal(returning.showDrivers,false);
  let joins=0;returning.connect=()=>joins++;returning.info=c.session.info;returning.tick();
  assert.equal(joins,0,'A saved opt-out must never open a connection');
  returning.setShowDrivers(true);assert.equal(returning.showDrivers,false,'Showing drivers cannot bypass an opt-out');
});
test('invalid saved multiplayer preferences fall back to connected and hidden',()=>{
  const c=clientClock();
  for(const raw of ['not json','null','{"enabled":"false","showDrivers":"true"}']){
    c.storage.set('vv.multiplayer',raw);const s=c.newSession();
    assert.equal(s.enabled,true);assert.equal(s.showDrivers,false);
  }
});
test('canonical setups match saved key order and numeric strings while rejecting invalid geometry',()=>{
  const reordered={...setup,inner:setup.inner.map(p=>({y:p.y,x:p.x,selected:true})),maxSpeed:'15',traction:'0.50'};
  assert.deepEqual(liveState.validSetup(reordered),setup);
  assert.equal(liveState.setupKey(liveState.validSetup(reordered)),liveState.setupKey(setup));
  for(const changed of [{inner:[]},{outer:Array(257).fill({x:1,y:2})},{gates:[]},{gates:[[{x:0,y:0},{x:0,y:0}],setup.gates[1]]},{inner:[{x:Infinity,y:0},...setup.inner]},{traction:2},{invincible:'false'},{maxSpeed:101}])assert.equal(liveState.validSetup({...setup,...changed}),null);
});
test('different setups remain discoverable; joining and restoring keeps the socket and saved preferences',()=>{
  const c=clientClock(),s=c.session,other={...setup,maxSpeed:14};
  s.setShowDrivers(true);
  s.receive({id:'phone',name:'Phone',color:liveState.COLORS[1],state:pose,setup:other});
  assert.equal(s.peers.size,1);assert.equal(s.drivers().length,0);
  s.receive({id:'phone',name:'Phone',color:liveState.COLORS[1],state:{...pose,x:120}});
  assert.equal(s.peers.get('phone').setup.maxSpeed,14,'Small pose updates retain race metadata');
  const saved=[...c.storage];
  c.window.applyMultiplayerSetup=value=>({...s.info,maxSpeed:value.maxSpeed,traction:value.traction,invincible:value.invincible,road:{innerList:value.inner,outerList:value.outer,checkPointList:value.gates}});
  s.joinDriver('phone');
  assert.equal(s.drivers().length,1);assert.equal(s.ws,c.socket);assert.equal(s.originalSetup.setup.maxSpeed,15);
  assert.equal(c.sent.at(-1).setup.maxSpeed,14);
  s.restoreSetup();assert.equal(s.drivers().length,0);assert.equal(s.setup.maxSpeed,15);assert.equal(s.originalSetup,null);
  assert.equal(s.ws,c.socket);assert.equal(c.closed,0);assert.deepEqual([...c.storage],saved);
});
test('lobby discovers Phone and Brave despite different physics, preserves metadata, and accepts large tracks',async()=>{
  const a=await join('Phone','lobby'),b=await join('Brave','lobby');let c;
  const send=(p,value,seq=0)=>p.ws.send(JSON.stringify({type:'state',name:p===a?'Phone':'Brave',state:pose,seq,setup:value}));
  try{
    send(a,setup);send(b,{...setup,maxSpeed:14});
    const seen=await until(()=>a.messages.find(m=>m.name==='Brave'&&m.setup));
    assert.equal(seen.setup.maxSpeed,14);assert.deepEqual(seen.state,pose);
    await until(()=>b.messages.find(m=>m.name==='Phone'&&m.setup));
    await delay(80);b.send({...pose,x:125},1,'Brave');
    const poseOnly=await until(()=>a.messages.find(m=>m.name==='Brave'&&m.state?.x===125));
    assert.equal(poseOnly.setup,undefined,'Do not resend geometry with every pose');
    c=await join('Late arrival','lobby');
    assert.equal(c.welcome.players.find(p=>p.name==='Brave').setup.maxSpeed,14);
    const large={...setup,inner:Array.from({length:256},(_,i)=>({x:i+.123456789012,y:i+.987654321098})),outer:Array.from({length:256},(_,i)=>({x:i+500.123456789,y:i+500.987654321})),gates:Array.from({length:256},(_,i)=>[{x:i+.123456789,y:i+.987654321},{x:i+500.123456789,y:i+500.987654321}])};
    assert.ok(JSON.stringify(large).length>16384);
    await delay(80);send(b,large,2);
    const largeUpdate=await until(()=>a.messages.find(m=>m.setup?.inner.length===256));
    assert.equal(largeUpdate.setup.gates.length,256);
  }finally{for(const p of [a,b,c])p?.ws.close();}
});
test('lobby requires a valid setup before relaying state',async()=>{
  const a=await join('Invalid setup','lobby'),b=await join('Observer','lobby');
  try{a.send();await until(()=>b.messages.some(m=>m.type==='leave'&&m.id===a.welcome.id));}
  finally{a.ws.close();b.ws.close();}
});
test('switching windows retains the socket through minute-long timer delays and resumes with acknowledgment grace',()=>{
  const c=clientClock(),s=c.session;
  s.tick();assert.equal(c.sent.at(-1).state.away,false);
  s.clock.running=true;c.advance(1);c.visibility(true);
  assert.equal(c.closed,0);assert.equal(s.clock.running,false);assert.equal(c.cleared,1);
  c.advance(100);s.tick();assert.equal(c.sent.at(-1).state.away,true);
  assert.equal(c.sent.at(-1).state.speed,0);assert.equal(c.sent.at(-1).state.paused,true);
  const count=c.sent.length;c.advance(1000);s.tick();assert.equal(c.sent.length,count,'Background tabs send sparse heartbeats');
  for(let i=0;i<2;i++){c.advance(60000);s.tick();assert.equal(s.ws,c.socket);}
  c.advance(100);c.visibility(false);
  assert.equal(s.ws,c.socket);assert.equal(c.closed,0);assert.equal(s.id,'same-driver');
  assert.equal(c.sent.at(-1).state.away,false);assert.equal(c.cleared,2);
  c.advance(8001);s.tick();assert.equal(c.closed,1,'A genuinely dead connection still times out after resume');
});
test('opting out and closing the page still remove background players immediately',()=>{
  for(const action of ['off','close']){
    const c=clientClock();c.visibility(true);
    if(action==='off')c.session.setEnabled(false);else c.window.dispatchEvent(new Event('pagehide'));
    assert.equal(c.closed,1);assert.equal(c.session.ws,null);assert.equal(c.session.connected,false);
  }
});
test('lap clock requires every gate in order; pause and crash invalidate partial laps',()=>{
  const gates=[[{x:0,y:-10},{x:0,y:10}],[{x:10,y:-10},{x:10,y:10}],[{x:5,y:15},{x:15,y:15}],[{x:-10,y:10},{x:-10,y:20}]];
  const lap=new LapClock();
  const drive=(x,y,damaged=false)=>lap.step({x,y,damaged},gates,1);
  const circuit=()=>{drive(12,0);drive(12,18);drive(-12,18);drive(-12,0);drive(2,0);};
  drive(-2,0);drive(2,0);circuit();assert.equal(lap.laps,1);assert.equal(lap.bestLap,5);
  drive(12,0);lap.invalidate();drive(12,18);drive(-12,18);drive(-12,0);drive(2,0);assert.equal(lap.laps,1);
  drive(12,0,true);circuit();assert.equal(lap.laps,1);
});
test('real WebSocket rooms relay live cars and renames, isolate tracks, and remove departures',async()=>{
  const a=await join('Silver Fox'),b=await join('Neon Lynx'),c=await join('Other track','b'.repeat(64));
  try{
    assert.equal(b.welcome.players.length,1);assert.equal(c.welcome.players.length,0);
    a.send();const update=await until(()=>b.messages.find(m=>m.type==='driver'&&m.state));
    assert.equal(update.name,'Silver Fox');assert.deepEqual(update.state,pose);
    await delay(80);a.send({...pose,x:124,bestLap:12.5,laps:1},1,'Comet');
    await until(()=>b.messages.some(m=>m.name==='Comet'&&m.state.x===124&&m.state.bestLap===12.5));
    assert.equal(c.messages.filter(m=>m.type==='driver').length,0);
    a.ws.close();await until(()=>b.messages.some(m=>m.type==='leave'&&m.id===a.welcome.id));
  }finally{for(const p of [a,b,c])if(p.ws.readyState<2)p.ws.close();}
});
test('real WebSockets keep the same driver while away and resume normal poses',async()=>{
  const a=await join('Background driver','e'.repeat(64)),b=await join('Watching driver','e'.repeat(64));
  try{
    a.send({...pose,away:true});
    const parked=await until(()=>b.messages.find(m=>m.type==='driver'&&m.state?.away));
    assert.equal(parked.id,a.welcome.id);assert.equal(parked.state.speed,0);assert.equal(parked.state.paused,true);
    assert.equal(b.messages.some(m=>m.type==='leave'),false);
    await delay(80);a.send({...pose,x:150},1);
    const resumed=await until(()=>b.messages.find(m=>m.state?.x===150));
    assert.equal(resumed.id,a.welcome.id);assert.equal(resumed.state.away,false);assert.equal(resumed.state.speed,2);
    a.ws.close();await until(()=>b.messages.some(m=>m.type==='leave'&&m.id===a.welcome.id));
  }finally{for(const p of [a,b])if(p.ws.readyState<2)p.ws.close();}
});
test('fresh visitors and identical slider or legacy saved values meet in the same real room',async()=>{
  const track='identical track geometry';
  const room=(speed,grip,invincible=false)=>createHash('sha256').update(roomKey(track,speed,grip,invincible)).digest('hex');
  assert.equal(roomKey(track,'15','0.50',false),JSON.stringify([1,track,15,0.5,false]),'Keep compatibility with existing numeric-default clients');
  const fresh=await join('Fresh visitor',room(15,0.5));
  const saved=await join('Saved physics',room('15','0.50'));
  const faster=await join('Different speed',room(14,0.5));
  const grip=await join('Different traction',room(15,0.6));
  const invincible=await join('Different collisions',room(15,0.5,true));
  try{
    assert.equal(saved.welcome.players.length,1);
    for(const other of [faster,grip,invincible])assert.equal(other.welcome.players.length,0);
    fresh.send();
    await until(()=>saved.messages.some(m=>m.type==='driver'&&m.id===fresh.welcome.id&&m.state?.x===pose.x));
    saved.send({...pose,x:240});
    await until(()=>fresh.messages.some(m=>m.type==='driver'&&m.id===saved.welcome.id&&m.state?.x===240));
  }finally{for(const player of [fresh,saved,faster,grip,invincible])player.ws.close();}
});

test('physics sliders store numeric values and reject invalid settings before restarting',async()=>{
  const context=vm.createContext({window:{},maxSpeed:15,traction:0.5,restarts:0,begin(){context.restarts++;}});
  vm.runInContext(await readFile(new URL('../AI-Car-Racer/buttonResponse.js',import.meta.url),'utf8'),context);
  context.setMaxSpeed('15');context.setTraction('0.50');
  assert.equal(context.maxSpeed,15);assert.equal(context.traction,0.5);assert.equal(context.restarts,2);
  for(const value of ['NaN',Infinity,-1]){context.setMaxSpeed(value);context.setTraction(value);}
  assert.equal(context.maxSpeed,15);assert.equal(context.traction,0.5);assert.equal(context.restarts,2);
});
test('server rejects hostile origins and malformed state, and removes the invalid driver',async()=>{
  const denied=await mf.dispatchFetch(`http://local/room/${'c'.repeat(64)}?name=Fox`,{headers:{Upgrade:'websocket',Origin:'https://evil.example'}});
  assert.equal(denied.status,403);
  const a=await join('Bad state','d'.repeat(64)),b=await join('Observer','d'.repeat(64));
  a.send({...pose,x:'injected'});
  await until(()=>b.messages.some(m=>m.type==='leave'&&m.id===a.welcome.id));b.ws.close();
});

test('production domain can join live races while lookalike origins are rejected',async()=>{
  const url=`http://local/room/${'d'.repeat(64)}?name=Production`;
  const response=await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:'https://vv.shaal.dev'}});
  assert.equal(response.status,101);response.webSocket.accept();response.webSocket.close();
  for(const origin of ['https://vv.shaal.dev.evil.example','http://vv.shaal.dev','https://other.shaal.dev']){
    assert.equal((await mf.dispatchFetch(url,{headers:{Upgrade:'websocket',Origin:origin}})).status,403);
  }
});

const controlsSource=await readFile(new URL('../AI-Car-Racer/controls.js',import.meta.url),'utf8');
function drivingControls(){
  const document=new EventTarget(),window=new EventTarget();
  const context=vm.createContext({document,window,AbortController});
  vm.runInContext(controlsSource+'\nglobalThis.controls=new Controls("WASD");',context);
  const key=(type,value,typing=false)=>{
    const event=new Event(type,{cancelable:true});event.key=value;
    if(typing)Object.defineProperty(event,'target',{value:{closest:()=>({})}});
    document.dispatchEvent(event);
  };
  return {controls:context.controls,window,key};
}
test('held steering and throttle override opposing AI commands without losing key state',()=>{
  const {controls:c,key}=drivingControls();
  try{
    c.setAI([1,1,0,0]);key('keydown','d');
    assert.equal(c.right,true);assert.equal(c.left,false);assert.equal(c.forward,true);
    c.setAI([1,1,0,0]);assert.equal(c.right,true);assert.equal(c.left,false);
    key('keydown','s');assert.equal(c.reverse,true);assert.equal(c.forward,false);
    key('keyup','d');assert.equal(c.left,true);assert.equal(c.right,false);assert.equal(c.reverse,true);
    key('keyup','s');assert.equal(c.forward,true);assert.equal(c.reverse,false);
  }finally{c.dispose();}
});
test('turning AI off keeps held keys and immediately releases every other AI command',()=>{
  const {controls:c,key}=drivingControls();
  try{
    c.setAI([1,1,0,0]);key('keydown','d');c.setAI(null);
    assert.equal(c.right,true);assert.equal(c.left,false);assert.equal(c.forward,false);
    key('keyup','d');assert.equal(c.right,false);
    c.setAI([1,0,0,0]);c.setAI(null);assert.equal(c.forward,false);
  }finally{c.dispose();}
});
test('typing, leaving the window, and disposing a car cannot leave a manual override stuck',()=>{
  const {controls:c,key,window}=drivingControls();
  key('keydown','w',true);assert.equal(c.forward,false);
  key('keydown','d');assert.equal(c.right,true);
  window.dispatchEvent(new Event('blur'));assert.equal(c.right,false);
  c.setAI([1,1,0,0]);assert.equal(c.left,true);assert.equal(c.right,false);
  c.dispose();key('keydown','w');assert.equal(c.forward,false);
});
