import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {cleanCallsign,randomCallsign,validState,samplePeer,LapClock} from '../AI-Car-Racer/multiplayer/state.js';

const pose={x:100,y:100,angle:0,speed:2,damaged:false,paused:false,laps:0,bestLap:null};
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
  const response=await mf.dispatchFetch(`http://local/room/${room}?name=${encodeURIComponent(name)}`,{headers:{Upgrade:'websocket',Origin:'http://127.0.0.1:8877'}});
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
