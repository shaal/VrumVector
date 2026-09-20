import {cleanCallsign,randomCallsign,validState,samplePeer,LapClock,COLORS,roomKey,AWAY_TTL,presenceTTL,driverLabel} from './state.js';
import {trackKey} from '../graphics/state.js';

class LiveSession {
  constructor(){
    let saved={};try{saved=JSON.parse(localStorage.getItem('vv.multiplayer')||'{}')||{};}catch{}
    this.enabled=saved.enabled!==false;this.showDrivers=this.enabled&&saved.showDrivers===true;
    this.connected=false;this.peers=new Map();this.clock=new LapClock();this.seq=0;this.epoch=0;
    try{this.callsign=cleanCallsign(localStorage.getItem('vv.callsign'));}catch{}
    if(!this.callsign)this.callsign=randomCallsign();
    this.setCallsign(this.callsign);this.createUI();this.status=this.enabled?'Connecting…':'Off · your car is not shared';this.renderUI();
    this.timer=setInterval(()=>this.tick(),100);
    document.addEventListener('visibilitychange',()=>{
      this.clearControls();this.clock.invalidate();
      // Switching windows parks the car; it must not remove it from a rival's
      // grid. Give a returning tab time to receive its queued acknowledgments.
      if(!document.hidden){this.retryAt=0;this.resumedAt=performance.now();}
      this.nextSend=0;this.tick();
      this.renderUI();
    });
    window.addEventListener('pagehide',()=>this.disconnect());
    window.addEventListener('online',()=>{this.retryAt=0;});
  }
  createUI(){
    this.root=document.createElement('section');this.root.id='live-session';this.root.hidden=true;
    this.root.setAttribute('aria-label','Multiplayer');
    this.root.innerHTML=`
      <button class="live-launch" aria-expanded="false" aria-controls="live-panel"><span class="live-launch-title">Multiplayer</span><small class="live-launch-detail"></small></button>
      <section id="live-panel" hidden>
        <div class="live-heading"><h3>Multiplayer</h3><button data-live-close aria-label="Close multiplayer">×</button></div>
        <div class="live-setting">
          <label class="live-switch" for="live-enabled"><span>Multiplayer</span><span data-live-enabled-state class="live-switch-state" aria-hidden="true"></span><input type="checkbox" id="live-enabled" aria-describedby="live-sharing-help"></label>
          <p id="live-sharing-help" class="live-note"></p>
        </div>
        <div class="live-setting">
          <label class="live-switch" for="live-show-drivers"><span>Show other drivers</span><span data-live-visibility-state class="live-switch-state" aria-hidden="true"></span><input type="checkbox" id="live-show-drivers" aria-describedby="live-visibility-help"></label>
          <p id="live-visibility-help" class="live-note"></p>
        </div>
        <p class="live-status" role="status" aria-live="polite"></p>
        <form data-live-name><label for="live-callsign">Your callsign</label><div class="live-name-row"><input id="live-callsign" maxlength="24" autocomplete="off" spellcheck="false" required><button type="submit">Save</button></div></form>
        <div class="live-standings" hidden><div class="live-table-heading"><strong>Best laps</strong><span>seconds</span></div><ol></ol><p class="live-lap-hint"></p></div>
        <details class="live-help"><summary>Room & racing details</summary>
          <p class="live-room live-note" hidden></p>
          <p class="live-note">Friends need matching room codes. Use the same track, max speed, traction and invincibility settings.</p>
          <p class="live-note">Multiplayer runs at 1×. Switching windows parks your car and marks you away. Live cars pass through each other; AI cars train locally.</p>
          <p class="live-note">For a timed lap, cross the start line and every gate in order.</p>
        </details>
        <button data-live-chase>Chase my car · WASD</button>
      </section>`;
    document.getElementById('canvasDiv').append(this.root);
    this.panel=this.root.querySelector('#live-panel');this.launch=this.root.querySelector('.live-launch');
    this.launchTitle=this.root.querySelector('.live-launch-title');this.launchDetail=this.root.querySelector('.live-launch-detail');
    this.input=this.root.querySelector('#live-callsign');this.input.value=this.callsign;
    this.checkbox=this.root.querySelector('#live-enabled');this.statusNode=this.root.querySelector('.live-status');this.roomNode=this.root.querySelector('.live-room');
    this.visibilityCheckbox=this.root.querySelector('#live-show-drivers');
    const toggle=on=>{this.panel.hidden=!on;this.launch.setAttribute('aria-expanded',String(on));if(on){const profiles=document.getElementById('driver-learning');if(profiles)profiles.open=false;}};
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
    this.visibilityCheckbox.onchange=()=>this.setShowDrivers(this.visibilityCheckbox.checked);
    this.root.querySelector('[data-live-chase]').onclick=()=>{
      window.CircuitStudio?.enable(true);window.CircuitStudio?.setFollowTarget('player');toggle(false);
      window.CircuitStudio?.canvas?.focus({preventScroll:true});
    };
    this.root.addEventListener('keydown',e=>{if(e.key==='Escape'){toggle(false);this.launch.focus();}});
  }
  setCallsign(name){this.callsign=cleanCallsign(name)||randomCallsign();try{localStorage.setItem('vv.callsign',this.callsign);}catch{}}
  savePreferences(){try{localStorage.setItem('vv.multiplayer',JSON.stringify({enabled:this.enabled,showDrivers:this.showDrivers}));}catch{}}
  setShowDrivers(on){this.showDrivers=this.enabled&&!!on;this.savePreferences();this.renderUI();}
  setEnabled(on){
    this.enabled=!!on;if(!this.enabled)this.showDrivers=false;
    this.savePreferences();this.retryAt=0;this.failures=0;this.unavailable=false;
    this.clock=new LapClock();this.localAI=null;
    window.setSimSpeed?.(1);
    if(!on){this.disconnect();this.status='Off · your car is not shared';}
    else {this.status='Connecting…';this.tick();}
    this.renderUI();
  }
  clearControls(){
    for(const car of this.info?.players||[])car?.controls?.clear?.();
  }
  frame(info){
    const firstFrame=!this.info;
    this.info=info;this.root.hidden=info.phase!==4||document.getElementById('canvasDiv').classList.contains('ab-on');
    // Auto-join at real time without dismissing the Start Training overlay.
    // Wait until the instance is assigned to window before locking the selector.
    if(firstFrame&&this.enabled)window.setSimSpeed?.(1);
    if(this.root.hidden&&this.ws){this.disconnect();this.clock.invalidate();}
    if(info.paused||info.awaitingStart)this.clock.invalidate();
    if(this.enabled && info.snapshot?.bestLapTimes && Array.isArray(info.snapshot.bestLapTimes)){
      for(const lap of info.snapshot.bestLapTimes)if(Number.isFinite(lap)&&lap>0)this.localAI=Math.min(this.localAI??Infinity,lap);
    }
  }
  step(car,gates){if(this.enabled&&!document.hidden)this.clock.step(car,gates);}
  resetRace(){this.clock=new LapClock();this.localAI=null;}
  disconnect(){
    this.epoch++;const ws=this.ws;this.ws=null;this.connected=false;this.room='';this.peers.clear();
    if(ws)try{ws.close(1000,'Left track');}catch{}
  }
  async connect(key){
    const epoch=++this.epoch;this.connecting=true;
    try{
      if(!this.endpoint){
        const response=await fetch(new URL('./config.json',import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(7000)});
        const config=await response.json();
        if(!config.endpoint){this.unavailable=true;throw new Error('Live racing is not available on this deployment yet.');}
        const endpoint=new URL(config.endpoint);
        const local=location.hostname==='localhost'||location.hostname==='127.0.0.1';
        if(endpoint.protocol!=='https:'&&!(local&&endpoint.protocol==='http:'))throw new Error('A secure live service is required.');
        this.endpoint=endpoint.origin;
      }
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      if(epoch!==this.epoch||!this.enabled||this.root.hidden)return;
      const room=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
      this.room=room.slice(0,8).toUpperCase();
      const url=new URL(`/room/${room}`,this.endpoint);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('name',this.callsign);
      const ws=new WebSocket(url);this.ws=ws;this.lastAck=performance.now();this.resumedAt=0;this.lastSent=-Infinity;this.nextSend=0;this.status='Connecting to the grid…';
      ws.onmessage=event=>{
        if(this.ws!==ws)return;
        let m;try{m=JSON.parse(event.data);}catch{return;}
        this.lastAck=performance.now();
        if(m.type==='welcome'){
          this.id=m.id;this.color=m.color;this.connected=true;this.failures=0;
          for(const p of m.players||[])this.receive(p);
        }else if(m.type==='driver')this.receive(m);
        else if(m.type==='leave')this.peers.delete(m.id);
        if(m.type==='welcome'||m.type==='leave')this.renderUI();
      };
      ws.onclose=()=>{if(this.ws!==ws)return;this.disconnect();this.retry();};
      ws.onerror=()=>{if(this.ws===ws)this.status='Live service unavailable · retrying';};
    }catch(error){if(epoch===this.epoch){this.status=error.message;this.retry();}}
    finally{this.connecting=false;this.renderUI();}
  }
  retry(){if(this.unavailable){this.retryAt=Infinity;return;}this.failures=(this.failures||0)+1;this.retryAt=performance.now()+Math.min(15000,1000*2**Math.min(4,this.failures));if(this.endpoint)this.status='Connection lost · reconnecting…';}
  receive(p){
    if(typeof p.id!=='string'||p.id===this.id||!COLORS.includes(p.color))return;
    const old=this.peers.get(p.id),now=performance.now();
    const current=validState(p.state);
    this.peers.set(p.id,{id:p.id,name:cleanCallsign(p.name)||'Driver',color:p.color,current,previous:old?.current,received:now,interval:old?now-old.received:100});
  }
  tick(){
    const info=this.info;
    if(!this.enabled||!info||this.root.hidden)return;
    const key=roomKey(trackKey(info.road),info.maxSpeed,info.traction,info.invincible);
    if(key!==this.key){this.disconnect();this.key=key;this.resetRace();this.retryAt=0;}
    const now=performance.now();
    if(this.ws&&now-Math.max(this.lastAck,this.resumedAt||0)>(document.hidden?AWAY_TTL:8000)){this.disconnect();this.retry();}
    if(!this.ws&&!this.connecting&&now>=(this.retryAt||0))this.connect(key);
    const car=info.players[1];
    if(this.connected&&car&&this.ws?.readyState===WebSocket.OPEN&&now>=(this.nextSend||0)&&now-(this.lastSent??-Infinity)>=100){
      const state=validState({x:car.x,y:car.y,angle:car.angle,speed:car.speed,damaged:car.damaged,paused:info.paused||info.awaitingStart,away:document.hidden,laps:this.clock.laps,bestLap:this.clock.bestLap});
      if(state&&this.ws.bufferedAmount<4096){
        this.ws.send(JSON.stringify({type:'state',seq:this.seq++,name:this.callsign,state}));
        this.lastSent=now;this.nextSend=now+(document.hidden?10000:100);
      }
    }
    for(const [id,p] of this.peers)if(now-p.received>presenceTTL(p.current))this.peers.delete(id);
    this.renderUI();
  }
  drivers(now=performance.now()){
    if(!this.enabled||!this.showDrivers)return [];
    return [...this.peers.values()].map(p=>({...p,pose:samplePeer(p,now)})).filter(p=>p.pose);
  }
  renderUI(){
    if(!this.root)return;
    const count=this.peers.size;
    const label=this.enabled?`Multiplayer · ${this.connected?'on':this.unavailable?'unavailable':'connecting'}`:'Multiplayer · off';
    const detail=!this.enabled?'Your car is not shared':this.showDrivers?'Other drivers shown':'Other drivers hidden';
    const status=this.connected?(document.hidden?'Connected · your car is parked while away':count===0?'Connected · waiting for other drivers':`${count} other driver${count===1?'':'s'} on this track`):this.status;
    if(this.launchTitle.textContent!==label)this.launchTitle.textContent=label;
    if(this.launchDetail.textContent!==detail)this.launchDetail.textContent=detail;
    this.checkbox.checked=this.enabled;this.visibilityCheckbox.checked=this.showDrivers;this.visibilityCheckbox.disabled=!this.enabled;
    this.root.querySelector('[data-live-enabled-state]').textContent=this.enabled?'On':'Off';
    this.root.querySelector('[data-live-visibility-state]').textContent=this.showDrivers?'On':'Off';
    this.root.querySelector('#live-sharing-help').textContent=this.enabled?'Others can see your car, even when you hide theirs.':'Your car is not shared. Play privately.';
    this.root.querySelector('#live-visibility-help').textContent=!this.enabled?'Turn on multiplayer to see other drivers.':this.showDrivers?'Their cars, callsigns and lap times are visible.':'Their cars, callsigns and lap times are hidden.';
    if(this.statusNode.textContent!==status)this.statusNode.textContent=status;
    this.roomNode.hidden=!this.enabled||!this.room;
    const roomText=this.room&&this.info?`Room ${this.room} · speed ${Number(this.info.maxSpeed)} · traction ${Number(this.info.traction)} · invincibility ${this.info.invincible?'on':'off'}`:'';
    if(this.roomNode.textContent!==roomText)this.roomNode.textContent=roomText;
    const standings=this.root.querySelector('.live-standings');standings.hidden=!this.connected||!this.showDrivers;
    if(this.panel.hidden||standings.hidden)return;
    const rows=[{name:this.callsign+' (you)',color:this.color,bestLap:this.clock.bestLap,laps:this.clock.laps},
      ...this.drivers().map(p=>({name:driverLabel(p.name,p.pose),color:p.color,...p.pose})),
      {name:'AI leader (local)',color:'#f3bc76',bestLap:this.localAI}];
    rows.sort((a,b)=>(a.bestLap??Infinity)-(b.bestLap??Infinity));
    const list=this.root.querySelector('ol');list.replaceChildren();
    for(const r of rows){const li=document.createElement('li'),name=document.createElement('span'),time=document.createElement('b');name.textContent=r.name;name.style.borderColor=r.color;time.textContent=r.bestLap?r.bestLap.toFixed(2):'—';li.append(name,time);list.append(li);}
    this.root.querySelector('.live-lap-hint').textContent=this.clock.running?`Lap ${this.clock.laps+1} · ${this.clock.elapsed.toFixed(1)} s · next gate ${this.clock.next+1}`:'Cross the start line to begin a timed lap.';
  }
  drawClassic(ctx){
    if(!this.enabled)return;
    for(const p of this.drivers()){
      const label=driverLabel(p.name,p.pose);
      if(window.DemoPresentation?.state.view3d){
        window.DemoPresentation.drawDriver(ctx,p.pose,p.color,label);continue;
      }
      const pose=p.pose;ctx.save();ctx.translate(pose.x,pose.y);ctx.rotate(-pose.angle);
      ctx.globalAlpha=pose.damaged?.4:.9;ctx.fillStyle=p.color;ctx.fillRect(-15,-25,30,50);ctx.fillStyle='#16302b';ctx.fillRect(-11,-12,22,12);ctx.restore();
      ctx.save();ctx.font='bold 20px system-ui';ctx.textAlign='center';ctx.lineWidth=5;ctx.strokeStyle='#142622';ctx.fillStyle='#fff';ctx.strokeText(label,pose.x,pose.y-42);ctx.fillText(label,pose.x,pose.y-42);ctx.restore();
    }
  }
}
window.LiveSession=new LiveSession();
