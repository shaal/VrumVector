import {cleanCallsign,randomCallsign,validState,samplePeer,LapClock,COLORS} from './state.js';
import {trackKey} from '../graphics/state.js';

class LiveSession {
  constructor(){
    this.enabled=false;this.connected=false;this.peers=new Map();this.clock=new LapClock();this.seq=0;this.epoch=0;
    try{this.callsign=cleanCallsign(localStorage.getItem('vv.callsign'));}catch{}
    if(!this.callsign)this.callsign=randomCallsign();
    this.setCallsign(this.callsign);this.createUI();this.status='Off · drive privately';
    this.timer=setInterval(()=>this.tick(),100);
    document.addEventListener('visibilitychange',()=>{
      this.clearControls();this.clock.invalidate();
      if(document.hidden){this.disconnect();this.status='Away · return to rejoin';}
      else this.retryAt=0;
      this.renderUI();
    });
    window.addEventListener('pagehide',()=>this.disconnect());
    window.addEventListener('online',()=>{this.retryAt=0;});
  }
  createUI(){
    this.root=document.createElement('section');this.root.id='live-session';this.root.hidden=true;
    this.root.setAttribute('aria-label','Multiplayer');
    this.root.innerHTML=`
      <button class="live-launch" aria-expanded="false" aria-controls="live-panel">Multiplayer · off</button>
      <section id="live-panel" hidden>
        <div class="live-heading"><div><span>THE LIVE GRID</span><h3>Find your rivals.</h3></div><button data-live-close aria-label="Close multiplayer">×</button></div>
        <form data-live-name><label for="live-callsign">Your callsign</label><div class="live-name-row"><input id="live-callsign" maxlength="24" autocomplete="off" spellcheck="false" required><button type="submit">Save</button></div></form>
        <label class="live-switch"><input type="checkbox" id="live-enabled"> Show live drivers <span>off by default</span></label>
        <p class="live-status" role="status" aria-live="polite"></p>
        <p class="live-note">Join to share your WASD car with drivers on the same track and vehicle settings. Hidden tabs leave the grid.</p>
        <div class="live-standings" hidden><div class="live-table-heading"><strong>Best laps</strong><span>seconds</span></div><ol></ol><p class="live-lap-hint"></p></div>
        <p class="live-note">Drive at 1× alongside your local AI. Cross the start line, then every gate in order. Live cars pass through each other.</p>
        <button data-live-chase>Chase my car · WASD</button>
      </section>`;
    document.getElementById('canvasDiv').append(this.root);
    this.panel=this.root.querySelector('#live-panel');this.launch=this.root.querySelector('.live-launch');
    this.input=this.root.querySelector('#live-callsign');this.input.value=this.callsign;
    this.checkbox=this.root.querySelector('#live-enabled');this.statusNode=this.root.querySelector('.live-status');
    const toggle=on=>{this.panel.hidden=!on;this.launch.setAttribute('aria-expanded',String(on));};
    this.launch.onclick=()=>toggle(this.panel.hidden);
    this.root.querySelector('[data-live-close]').onclick=()=>{toggle(false);this.launch.focus();};
    this.root.querySelector('[data-live-name]').onsubmit=event=>{
      event.preventDefault();const name=cleanCallsign(this.input.value);
      if(!name){this.input.setCustomValidity('Choose a callsign with letters or numbers.');this.input.reportValidity();return;}
      this.setCallsign(name);this.input.value=this.callsign;this.clearControls();this.renderUI();
    };
    this.input.oninput=()=>this.input.setCustomValidity('');
    this.input.onfocus=()=>this.clearControls();
    this.checkbox.onchange=()=>this.setEnabled(this.checkbox.checked);
    this.root.querySelector('[data-live-chase]').onclick=()=>{
      window.CircuitStudio?.enable(true);window.CircuitStudio?.setFollowTarget('player');toggle(false);
      window.CircuitStudio?.canvas?.focus({preventScroll:true});
    };
    this.root.addEventListener('keydown',e=>{if(e.key==='Escape'){toggle(false);this.launch.focus();}});
  }
  setCallsign(name){this.callsign=cleanCallsign(name)||randomCallsign();try{localStorage.setItem('vv.callsign',this.callsign);}catch{}}
  setEnabled(on){
    this.enabled=!!on;this.checkbox.checked=this.enabled;this.retryAt=0;this.failures=0;
    this.clock=new LapClock();this.localAI=null;
    if(!on){this.disconnect();this.status='Off · drive privately';}
    else {this.status='Connecting…';if(window.__awaitingStart)window.pauseGame?.();}
    this.renderUI();
  }
  clearControls(){
    for(const car of this.info?.players||[])if(car?.controls)for(const k of ['forward','reverse','left','right'])car.controls[k]=false;
  }
  frame(info){
    this.info=info;this.root.hidden=info.phase!==4||document.getElementById('canvasDiv').classList.contains('ab-on');
    if(this.root.hidden&&this.ws){this.disconnect();this.clock.invalidate();}
    if(info.paused||info.awaitingStart)this.clock.invalidate();
    if(this.enabled && info.snapshot?.bestLapTimes && Array.isArray(info.snapshot.bestLapTimes)){
      for(const lap of info.snapshot.bestLapTimes)if(Number.isFinite(lap)&&lap>0)this.localAI=Math.min(this.localAI??Infinity,lap);
    }
  }
  step(car,gates){if(this.enabled&&!document.hidden)this.clock.step(car,gates);}
  resetRace(){this.clock=new LapClock();this.localAI=null;}
  disconnect(){
    this.epoch++;const ws=this.ws;this.ws=null;this.connected=false;this.peers.clear();
    if(ws)try{ws.close(1000,'Left track');}catch{}
  }
  async connect(key){
    const epoch=++this.epoch;this.connecting=true;
    try{
      if(!this.endpoint){
        const response=await fetch(new URL('./config.json',import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(7000)});
        const config=await response.json();
        if(!config.endpoint)throw new Error('Live service is not configured yet.');
        const endpoint=new URL(config.endpoint);
        const local=location.hostname==='localhost'||location.hostname==='127.0.0.1';
        if(endpoint.protocol!=='https:'&&!(local&&endpoint.protocol==='http:'))throw new Error('A secure live service is required.');
        this.endpoint=endpoint.origin;
      }
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      if(epoch!==this.epoch||!this.enabled||document.hidden||this.root.hidden)return;
      const room=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
      const url=new URL(`/room/${room}`,this.endpoint);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('name',this.callsign);
      const ws=new WebSocket(url);this.ws=ws;this.lastAck=performance.now();this.status='Connecting to the grid…';
      ws.onmessage=event=>{
        if(this.ws!==ws)return;
        let m;try{m=JSON.parse(event.data);}catch{return;}
        this.lastAck=performance.now();
        if(m.type==='welcome'){
          this.id=m.id;this.color=m.color;this.connected=true;this.failures=0;
          for(const p of m.players||[])this.receive(p);
        }else if(m.type==='driver')this.receive(m);
        else if(m.type==='leave')this.peers.delete(m.id);
        this.renderUI();
      };
      ws.onclose=()=>{if(this.ws!==ws)return;this.disconnect();this.retry();};
      ws.onerror=()=>{if(this.ws===ws)this.status='Live service unavailable · retrying';};
    }catch(error){if(epoch===this.epoch){this.status=error.message;this.retry();}}
    finally{this.connecting=false;this.renderUI();}
  }
  retry(){this.failures=(this.failures||0)+1;this.retryAt=performance.now()+Math.min(15000,1000*2**Math.min(4,this.failures));if(this.endpoint)this.status='Connection lost · reconnecting…';}
  receive(p){
    if(typeof p.id!=='string'||p.id===this.id||!COLORS.includes(p.color))return;
    const old=this.peers.get(p.id),now=performance.now();
    const current=validState(p.state);
    this.peers.set(p.id,{id:p.id,name:cleanCallsign(p.name)||'Driver',color:p.color,current,previous:old?.current,received:now,interval:old?now-old.received:100});
  }
  tick(){
    const info=this.info;
    if(!this.enabled||!info||this.root.hidden||document.hidden)return;
    const key=JSON.stringify([1,trackKey(info.road),info.maxSpeed,info.traction,!!info.invincible]);
    if(key!==this.key){this.disconnect();this.key=key;this.resetRace();this.retryAt=0;}
    const now=performance.now();
    if(this.ws&&now-this.lastAck>8000){this.disconnect();this.retry();}
    if(!this.ws&&!this.connecting&&now>=(this.retryAt||0))this.connect(key);
    const car=info.players[1];
    if(this.connected&&car&&this.ws?.readyState===WebSocket.OPEN){
      const state=validState({x:car.x,y:car.y,angle:car.angle,speed:car.speed,damaged:car.damaged,paused:info.paused||info.awaitingStart,laps:this.clock.laps,bestLap:this.clock.bestLap});
      if(state&&this.ws.bufferedAmount<4096)this.ws.send(JSON.stringify({type:'state',seq:this.seq++,name:this.callsign,state}));
    }
    for(const [id,p] of this.peers)if(now-p.received>15000)this.peers.delete(id);
    this.renderUI();
  }
  drivers(now=performance.now()){return [...this.peers.values()].map(p=>({...p,pose:samplePeer(p,now)})).filter(p=>p.pose);}
  renderUI(){
    if(!this.root)return;
    const count=this.peers.size+1;
    this.launch.textContent=this.enabled?`Multiplayer · ${this.connected?count+' live':'connecting'}`:'Multiplayer · off';
    this.statusNode.textContent=this.connected?(count===1?'You’re on the grid · waiting for rivals':`${count} drivers on this track`):this.status;
    const standings=this.root.querySelector('.live-standings');standings.hidden=!this.connected;
    if(this.panel.hidden||!this.connected)return;
    const rows=[{name:this.callsign+' (you)',color:this.color,bestLap:this.clock.bestLap,laps:this.clock.laps},
      ...this.drivers().map(p=>({name:p.name+(p.pose.paused?' · paused':''),color:p.color,...p.pose})),
      {name:'AI leader (local)',color:'#f3bc76',bestLap:this.localAI}];
    rows.sort((a,b)=>(a.bestLap??Infinity)-(b.bestLap??Infinity));
    const list=this.root.querySelector('ol');list.replaceChildren();
    for(const r of rows){const li=document.createElement('li'),name=document.createElement('span'),time=document.createElement('b');name.textContent=r.name;name.style.borderColor=r.color;time.textContent=r.bestLap?r.bestLap.toFixed(2):'—';li.append(name,time);list.append(li);}
    this.root.querySelector('.live-lap-hint').textContent=this.clock.running?`Lap ${this.clock.laps+1} · ${this.clock.elapsed.toFixed(1)} s · next gate ${this.clock.next+1}`:'Cross the start line to begin a timed lap.';
  }
  drawClassic(ctx){
    if(!this.enabled)return;
    for(const p of this.drivers()){
      const pose=p.pose;ctx.save();ctx.translate(pose.x,pose.y);ctx.rotate(-pose.angle);
      ctx.globalAlpha=pose.damaged?.4:.9;ctx.fillStyle=p.color;ctx.fillRect(-15,-25,30,50);ctx.fillStyle='#16302b';ctx.fillRect(-11,-12,22,12);ctx.restore();
      ctx.save();ctx.font='bold 20px system-ui';ctx.textAlign='center';ctx.lineWidth=5;ctx.strokeStyle='#142622';ctx.fillStyle='#fff';ctx.strokeText(p.name,pose.x,pose.y-42);ctx.fillText(p.name,pose.x,pose.y-42);ctx.restore();
    }
  }
}
window.LiveSession=new LiveSession();
