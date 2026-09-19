const options = entries => entries.map(([v,t])=>`<option value="${v}">${t}</option>`).join('');
export class StudioUI {
  constructor(studio, host) {
    this.studio=studio;
    this.root=document.createElement('section'); this.root.id='studio-ui';this.root.hidden=true;
    this.root.setAttribute('aria-label','Circuit Studio');
    this.root.innerHTML=`
      <header class="studio-header">
        <div><span class="studio-eyebrow">VECTORVROOM / LIVE LEARNING</span><h2 data-title>Circuit Studio<span>.</span></h2><p>Intelligence finds its line.</p></div>
        <div class="studio-header-actions"><span class="studio-status" data-status>READY</span><button data-action="classic-top">Switch to 2D</button><button data-action="learn">Learn</button><button data-action="panel">Training controls</button><button class="studio-primary" data-action="training">Start training</button></div>
      </header>
      <div class="studio-vitals" aria-label="Training statistics"><span>GENERATION<b data-gen>01</b></span><span>ALIVE<b data-alive>—</b></span><span>LEADER GATES<b data-progress>—</b></span></div>
      <aside class="studio-vision" hidden data-vision-panel><span class="studio-eyebrow">INSIDE THE DRIVER</span><strong data-driver>Live sensor readings</strong><div class="studio-decisions">${['Forward','Left','Right','Reverse'].map((n,i)=>`<span data-decision="${i}">${n}<b>OFF</b></span>`).join('')}</div><p data-vision-note>Cyan: sensor hits · Amber: crash density</p></aside>
      <p class="studio-caption" data-caption>Drag to orbit · Scroll to explore</p>
      <nav class="studio-dock" aria-label="Scene controls">
        <div class="studio-camera-buttons" role="group" aria-label="Camera"><button data-camera="orbit" aria-pressed="true">Orbit</button><button data-camera="chase" aria-pressed="false" aria-label="Chase the AI driver">Chase</button><button data-action="player" aria-pressed="false" aria-label="Chase my car, controlled with WASD">My car</button><button data-camera="overhead" aria-pressed="false">Overhead</button><button data-camera="director" aria-pressed="false">Director</button></div>
        <span class="studio-divider"></span><button data-action="vision" aria-pressed="false">AI vision</button><button data-action="night" aria-pressed="false">Night run</button><button data-action="sound" aria-pressed="false">Sound off</button><button data-action="settings" aria-expanded="false" aria-controls="studio-settings">Options</button>
      </nav>
      <section id="studio-settings" class="studio-settings" hidden aria-label="Scene options">
        <div class="studio-settings-title"><strong>Make it your circuit</strong><button data-action="settings" aria-label="Close scene options">×</button></div>
        <label>Landscape<select data-setting="theme">${options([['circuit','Circuit garden'],['alpine','Alpine forest'],['desert','Desert proving ground']])}</select></label>
        <label>Camera<select data-setting="camera">${options([['orbit','Orbit — explore the circuit'],['chase','Chase — behind the driver'],['overhead','Overhead — the whole population'],['director','Director — automatic cuts'],['trackside','Trackside — watch the corner'],['front','Front — look back at the driver']])}</select></label>
        <label>Follow driver<select data-setting="follow">${options([['ai','AI driver'],['player','My car — WASD']])}</select></label>
        <label>Graphics<select data-setting="quality">${options([['low','Light — battery friendly'],['balanced','Balanced'],['high','High — reflections and more detail']])}</select></label>
        <label class="studio-check"><input type="checkbox" data-setting="ghosts"> Show earlier generations</label>
        <div class="studio-replay-choice"><label>Recorded runs<select data-setting="run"><option value="">Finish a generation to record a run</option></select></label><button data-action="replay" disabled>Watch run</button><p>The furthest driver from a fixed sample of up to 16 cars. Records the first two minutes at 20 Hz.</p></div>
        <div class="studio-settings-footer"><button data-action="classic">Classic 2D</button><button data-action="tour">Guided tour</button><a href="https://github.com/shaal/VrumVector" target="_blank" rel="noopener noreferrer">Source ↗</a></div>
        <small data-backend>Preparing graphics…</small>
      </section>
      <section class="studio-replay" hidden data-replay-panel aria-label="Replay playback">
        <div><strong data-replay-title>Recorded run</strong><button data-action="replay-pause">Pause replay</button><label class="studio-rate-label">Speed<select data-setting="rate">${options([['0.25','¼×'],['0.5','½×'],['1','1×'],['2','2×']])}</select></label><button data-action="live">Back to live</button></div>
        <label class="studio-scrub"><span data-replay-time>0.0 s</span><input type="range" min="0" max="20" step="0.05" value="0" aria-label="Replay time" data-setting="scrub"></label><p>Recorded poses and controls. Training continues independently.</p>
      </section>`;
    host.appendChild(this.root);
    this.launch=document.getElementById('graphics-toggle');
    this.launch.addEventListener('click',()=>studio.enable(true));
    this.notice=document.createElement('p');this.notice.className='studio-notice';this.notice.hidden=true;this.notice.setAttribute('role','status');host.appendChild(this.notice);
    this.root.addEventListener('click',ev=>{
      const btn=ev.target.closest('button');if(!btn)return;
      if(btn.dataset.camera){if(btn.dataset.camera==='chase')studio.setFollowTarget('ai');else studio.setCamera(btn.dataset.camera);return;}
      switch(btn.dataset.action){
        case 'player':studio.setFollowTarget('player');studio.canvas?.focus({preventScroll:true});break;
        case 'sound':studio.setSound(!studio.audio.enabled);break;
        case 'vision':studio.setVision(!studio.vision);break;
        case 'night':studio.setNight(!studio.night);break;
        case 'settings':this.toggleSettings();break;
        case 'classic-top':
        case 'classic':studio.enable(false);break;
        case 'training':window.pauseGame?.();break;
        case 'panel':document.getElementById('panelToggle')?.click();break;
        case 'learn':document.querySelector('.eli15-fab')?.click();break;
        case 'tour':document.querySelector('.eli15-tour-fab')?.click();break;
        case 'replay':studio.startReplay(Number(this.root.querySelector('[data-setting="run"]').value));this.toggleSettings(false);break;
        case 'live':studio.stopReplay();break;
        case 'replay-pause':if(studio.replay)studio.replay.paused=!studio.replay.paused;break;
      }
      this.sync();
    });
    this.root.addEventListener('change',ev=>{
      const el=ev.target;
      if(el.dataset.setting==='theme')studio.setTheme(el.value);
      if(el.dataset.setting==='camera')studio.setCamera(el.value);
      if(el.dataset.setting==='follow')studio.setFollowTarget(el.value);
      if(el.dataset.setting==='quality')studio.setQuality(el.value);
      if(el.dataset.setting==='ghosts'){studio.ghosts=el.checked;studio.save();}
      if(el.dataset.setting==='rate'&&studio.replay)studio.replay.rate=Number(el.value);
      this.sync();
    });
    this.root.addEventListener('input',ev=>{if(ev.target.dataset.setting==='scrub'&&studio.replay)studio.replay.time=Number(ev.target.value);});
    // The app's existing driving shortcuts stay untouched.
    window.addEventListener('keydown',e=>{
      if(!studio.active||e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,select,textarea,[contenteditable="true"]'))return;
      const key=e.key.toLowerCase();
      if(key==='escape'){this.toggleSettings(false);studio.stopReplay();return;}
      if(!['c','f','v','n','0','3'].includes(key))return;
      e.preventDefault();e.stopImmediatePropagation();
      if(key==='c'){const modes=['orbit','chase','overhead','director'];studio.setCamera(modes[(modes.indexOf(studio.cameraMode)+1)%modes.length]);}
      if(key==='f')studio.setCamera(studio.cameraMode==='chase'?'orbit':'chase');
      if(key==='v')studio.setVision(!studio.vision);
      if(key==='n')studio.setNight(!studio.night);
      if(key==='0')studio.setCamera('orbit',true);
      if(key==='3')studio.enable(false);
      this.sync();
    },true);
  }
  toggleSettings(on) {
    const panel=this.root.querySelector('#studio-settings');panel.hidden=on==null?!panel.hidden:!on;
    this.root.querySelector('[data-action="settings"]').setAttribute('aria-expanded',String(!panel.hidden));
  }
  message(text) {this.notice.textContent=text;this.notice.hidden=!text;}
  sync() {
    const s=this.studio;
    this.root.querySelector('[data-title]').textContent=s.night?'Night Run.':'Circuit Studio.';
    const player=!s.replay&&s.followTarget==='player';
    this.root.querySelectorAll('[data-camera]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.camera===s.cameraMode&&!(b.dataset.camera==='chase'&&player))));
    this.root.querySelector('[data-action="player"]').setAttribute('aria-pressed',String(player&&s.cameraMode==='chase'));
    this.root.querySelector('[data-setting="follow"]').value=s.followTarget;
    this.root.querySelector('[data-action="vision"]').textContent=player?'My vision':'AI vision';
    const sound=this.root.querySelector('[data-action="sound"]');sound.textContent=s.audio.enabled?'Sound on':'Sound off';
    sound.disabled=!!s.soundPending;
    sound.setAttribute('aria-pressed',String(s.audio.enabled));sound.title=s.audio.error||'Engine and collision sounds. Starts off each visit.';
    for(const k of ['vision','night'])this.root.querySelector(`[data-action="${k}"]`).setAttribute('aria-pressed',String(s[k]));
    for(const [k,v] of [['camera',s.cameraMode],['theme',s.theme],['quality',s.quality]])this.root.querySelector(`[data-setting="${k}"]`).value=v;
    this.root.querySelector('[data-setting="ghosts"]').checked=s.ghosts;
    this.root.querySelector('[data-vision-panel]').hidden=!s.vision;
    this.root.querySelector('[data-replay-panel]').hidden=!s.replay;
    this.root.classList.toggle('is-replaying',!!s.replay);
    this.root.querySelector('[data-backend]').textContent=s.backend?`${s.backend} · Three.js r186`:'Preparing graphics…';
  }
  runsChanged() {
    const select=this.root.querySelector('[data-setting="run"]');select.replaceChildren();
    this.studio.archive.runs.forEach((r,i)=>{const option=document.createElement('option');option.value=i;option.textContent=`Gen ${r.generation+1} · driver ${r.driverIndex+1} · ${r.duration.toFixed(1)} s`;select.appendChild(option);});
    if(!select.options.length)select.add(new Option('Finish a generation to record a run',''));
    this.root.querySelector('[data-action="replay"]').disabled=!this.studio.archive.runs.length;
  }
  update(info, now) {
    if(now-(this.lastUpdate||0)<150)return;this.lastUpdate=now;
    const s=this.studio, snap=info.snapshot, replay=s.replay;
    this.root.querySelector('[data-status]').textContent=replay?'RECORDED RUN':info.awaitingStart?'READY TO LEARN':info.paused?'PAUSED':'LIVE TRAINING';
    this.root.querySelector('[data-action="training"]').textContent=info.awaitingStart?'Start training':info.paused?'Resume training':'Pause training';
    this.root.querySelector('[data-gen]').textContent=String(info.generation+1).padStart(2,'0');
    this.root.querySelector('[data-alive]').textContent=snap?`${s.alive} / ${snap.N}`:'—';
    this.root.querySelector('[data-progress]').textContent=snap?String(snap.bestCheckpoints):'—';
    let caption=s.cameraMode==='orbit'?'Drag to orbit · Scroll to explore':`${s.cameraMode[0].toUpperCase()+s.cameraMode.slice(1)} camera · C to change`;
    if(s.followingPlayer)caption=`My car · W accelerate · S reverse · A / D steer`;
    if(info.simSpeed>5&&!replay&&!s.followingPlayer)caption=`${info.simSpeed}× training · Overhead view keeps the population readable`;
    if(s.ghosts)caption+=' · Earlier runs shown at the same simulation time';
    this.root.querySelector('[data-caption]').textContent=caption;
    if(s.vision){
      const mask=replay?s.replayPose?.controls:null;
      const ctrl=s.followingPlayer?s.focusControls:mask==null?snap?.bestControls:[mask&1,mask&2,mask&4,mask&8];
      this.root.querySelector('[data-driver]').textContent=s.followingPlayer?'My car · WASD controls':replay?`Recorded driver ${replay.run.driverIndex+1}`:`Champion ${snap?snap.bestIdx+1:'—'} · live decisions`;
      this.root.querySelectorAll('[data-decision]').forEach((el,i)=>{el.classList.toggle('is-active',!!ctrl?.[i]);el.querySelector('b').textContent=ctrl?.[i]?'ON':'OFF';});
      this.root.querySelector('[data-vision-note]').textContent=replay?'Recorded controls · Sensor beams are available in live view.':'Cyan: sensor hits · Amber: crash density';
    }
    if(replay){
      this.root.querySelector('[data-replay-title]').textContent=`Gen ${replay.run.generation+1} / Driver ${replay.run.driverIndex+1}`;
      this.root.querySelector('[data-action="replay-pause"]').textContent=replay.paused?'Play replay':'Pause replay';
      const scrub=this.root.querySelector('[data-setting="scrub"]');scrub.max=replay.run.duration;scrub.value=replay.time;
      this.root.querySelector('[data-replay-time]').textContent=`${replay.time.toFixed(1)} / ${replay.run.duration.toFixed(1)} s`;
    }
  }
}
