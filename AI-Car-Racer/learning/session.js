import {LearningCoach,buildPopulation,cleanContext,contextKey,validBrain} from './policy.js';
import {trackKey} from '../graphics/state.js';

function geometryKey(road){
  const text=trackKey(road);let a=2166136261,b=5381;
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b,33)^c;}
  return `${(a>>>0).toString(16)}-${(b>>>0).toString(16)}-${text.length}`;
}
class DriverLearning {
  constructor(){
    this.profile='balanced';this.adaptive=false;this.coach=new LearningCoach();this.consolidations=0;
    try{const saved=JSON.parse(localStorage.getItem('vv.driverLearning')||'null');if(saved){this.profile=DriverProfiles.get(saved.profile).id;this.adaptive=saved.adaptive===true;}}catch{}
  }
  restoreChampion(){
    if(this.forceSaved)return;
    try{
      const saved=JSON.parse(localStorage.getItem('vv.driverChampions')||'[]').find(c=>c.key===this.coach.key);
      if(saved&&validBrain(saved.vector)&&Number.isFinite(saved.fitness))this.coach.incumbent={...saved,vector:new Float32Array(saved.vector)};
    }catch{}
  }
  persistChampion(){
    const champion=this.coach.incumbent;if(!champion)return;
    try{
      const all=JSON.parse(localStorage.getItem('vv.driverChampions')||'[]').filter(c=>c.key!==this.coach.key);
      all.unshift({...champion,key:this.coach.key,vector:Array.from(champion.vector)});
      // This is a small startup cache. The full vector archive is retained.
      localStorage.setItem('vv.driverChampions',JSON.stringify(all.slice(0,20)));
    }catch{}
  }
  useSaved(context){
    this.profile=DriverProfiles.get(context?.profile).id;this.save();this.forceSaved=true;
    this.coach.key='';this.coach.reset();
  }
  save(){try{localStorage.setItem('vv.driverLearning',JSON.stringify({profile:this.profile,adaptive:this.adaptive}));}catch{}}
  resetMemories(){
    this.coach.reset();this.coach.key='';this.seeds=[];this.forceSaved=false;
    this.batch=null;this.lastPlan=null;
    try{localStorage.removeItem('vv.driverChampions');}catch{}
    this.render();
  }
  setProfile(id){
    const profile=DriverProfiles.get(id);if(profile.id===this.profile)return;
    this.consolidate();this.profile=profile.id;this.save();this.coach.key='';this.coach.reset();
    this.batch=null;this.seeds=[];this.lastPlan=null;
    window.PlayerAssist?.release();window.restartDriverLearning?.();this.render();
  }
  prepare({road,maxSpeed,traction,seconds}){
    const context=cleanContext({profile:this.profile,track:geometryKey(road),maxSpeed,traction,seconds});
    if(this.context&&contextKey(context)!==contextKey(this.context))this.consolidate();
    const changed=this.coach.key!==contextKey(context);
    this.context=context;this.coach.setContext(context);if(changed)this.restoreChampion();
    window.__rvBridge?.setLearningContext?.(context);
    return context;
  }
  build(N,seeds,prior,baseMutation,conservative){
    const p=DriverProfiles.get(this.profile);
    this.lastPlan=this.coach.plan(baseMutation,this.adaptive,p.exploration);
    const pool=seeds?.length&&!this.forceSaved?seeds:validBrain(prior)?[{vector:prior,id:null}]:[];
    if(this.forceSaved){this.coach.incumbent=null;this.forceSaved=false;}
    this.batch=buildPopulation({N,seeds:pool,incumbent:this.coach.incumbent,plan:this.lastPlan,conservative});
    this.seeds=pool;this.render();return this.batch;
  }
  record(result,vector,id){
    // A track/profile change must never accept a late result from the old run.
    if(result.learningContext&&contextKey(result.learningContext)!==this.coach.key)return;
    if(this.coach.record(result,vector,id))this.persistChampion();
    if(this.coach.rounds%8===0)this.consolidate();
    this.render();
  }
  consolidate(){
    const bridge=window.__rvBridge;
    if(!bridge||window.rvDisabled)return false;
    try{
      if(!bridge.info().sona?.trajectorySteps)return false;
      bridge.endPhase4Trajectory(this.coach.incumbent?.fitness||0);
      bridge.beginPhase4Trajectory(window.currentTrackVec||null);this.consolidations++;
      bridge.persist?.().catch(error=>console.warn('[learning] saving reviewed memories failed',error));
      this.render();return true;
    }catch(error){console.warn('[learning] consolidation failed',error);return false;}
  }
  render(){
    if(!this.root)return;
    const p=DriverProfiles.get(this.profile),last=this.coach.history.at(-1),plan=this.lastPlan;
    this.root.querySelector('[data-learning-title]').textContent=`Driver profile · ${p.name}`;
    this.root.querySelector('#driver-profile').value=p.id;
    this.root.querySelector('[data-profile-description]').textContent=p.description;
    this.root.querySelector('#adaptive-learning').checked=this.adaptive;
    const labels={manual:'Fixed exploration',steady:'Exploring and preserving the best driver',refine:'Progress found · refining the best driver',explore:'Progress stalled · trying more variation',breakthrough:'Plateau · introducing more fresh drivers'};
    this.root.querySelector('[data-learning-status]').textContent=last?(labels[plan?.stage]||labels.steady):this.coach.incumbent?'Saved champion ready. Start training to keep improving.':'Start training to build a learning history.';
    this.root.querySelector('[data-learning-best]').textContent=this.coach.incumbent?String(this.coach.incumbent.fitness):'—';
    this.root.querySelector('[data-learning-survival]').textContent=last?`${Math.round(last.survival*100)}%`:'—';
    this.root.querySelector('[data-learning-mutation]').textContent=plan?`${Math.round(plan.mutation*100)}%`:'—';
    const source=this.batch?.counts;
    this.root.querySelector('[data-learning-sources]').textContent=source?`${source.archive_recall} from memory · ${source.localStorage_prior} from saved drivers · ${source.random_init} fresh`:'Memory selects useful starting points for this style and track.';
    const chart=this.root.querySelector('[data-learning-chart]');chart.replaceChildren();
    const history=this.coach.history.slice(-20),max=Math.max(1,...history.map(r=>r.fitness));
    for(const row of history){const bar=document.createElement('span');bar.style.height=`${Math.max(5,row.fitness/max*100)}%`;bar.title=`Generation ${row.generation}: ${row.fitness} gates · ${Math.round(row.survival*100)}% survived`;bar.classList.toggle('improved',row.improved);chart.append(bar);}
    chart.setAttribute('aria-label',history.length?`Checkpoint progress over ${history.length} generations. Latest ${last.fitness}, best ${this.coach.incumbent.fitness}.`:'No completed generations yet');
    const memories=this.root.querySelector('[data-learning-memories]');memories.replaceChildren();
    for(const seed of (this.seeds||[]).slice(0,3)){const item=document.createElement('li');item.textContent=`${seed.matchLabel||'Saved driver'} · ${Number(seed.meta?.fitness||0).toFixed(0)} gates`;memories.append(item);}
    const sona=window.__rvBridge?.info?.().sona;
    const review=this.consolidations?`${this.consolidations} memory reviews · ${sona?.patterns??0} learned patterns.`:'Memories are reviewed every 8 generations.';
    this.root.querySelector('[data-learning-consolidation]').textContent=review+(sona?.savedExamples?` ${sona.savedExamples} successful circuit examples saved${sona.replayedExamples?`; ${sona.replayedExamples} relearned after reload`:''}.`:'');
  }
}
export const learning=window.DriverLearning=new DriverLearning();
// Both arms of the A/B comparison can use the same genetic policy.
learning.createCoach=()=>new LearningCoach();learning.buildPopulation=buildPopulation;

export function attachLearningControls(host){
  const root=document.createElement('details');root.id='driver-learning';
  root.innerHTML=`<summary data-learning-title>Driver profile · Balanced</summary>
    <section class="learning-panel" aria-label="Driver profiles and learning">
      <div class="learning-panel-heading"><strong>Find your driving style</strong><button type="button" data-learning-close aria-label="Close driver profiles">×</button></div>
      <label for="driver-profile">Driving style</label><select id="driver-profile">${Object.values(DriverProfiles.profiles).map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}</select>
      <p data-profile-description></p><p class="learning-note">Applies to AI rivals and your AI co-driver. Manual WASD input always takes priority. Changing style starts a new AI generation.</p>
      <label class="learning-check"><input type="checkbox" id="adaptive-learning"> Adaptive exploration</label>
      <p class="learning-note">Protect the best driver. Try more variation when progress stalls.</p>
      <p data-learning-status role="status"></p>
      <div class="learning-stats"><span>BEST GATES<b data-learning-best>—</b></span><span>SURVIVED<b data-learning-survival>—</b></span><span>MUTATION<b data-learning-mutation>—</b></span></div>
      <div class="learning-chart" data-learning-chart role="img"></div>
      <p data-learning-sources></p><ol data-learning-memories></ol>
      <button type="button" data-learning-review>Review learned memories</button><p class="learning-note" data-learning-consolidation></p>
    </section>`;
  host.append(root);learning.root=root;
  root.querySelector('select').onchange=event=>learning.setProfile(event.target.value);
  root.querySelector('#adaptive-learning').onchange=event=>{learning.adaptive=event.target.checked;learning.save();learning.render();};
  root.querySelector('[data-learning-close]').onclick=()=>{root.open=false;root.querySelector('summary').focus();};
  root.querySelector('[data-learning-review]').onclick=()=>{const done=learning.consolidate();if(!done)root.querySelector('[data-learning-consolidation]').textContent='Complete a generation with Vector Memory on to review new memories.';};
  root.addEventListener('toggle',()=>{
    if(root.open){const panel=document.getElementById('live-panel');if(panel&&!panel.hidden)panel.querySelector('[data-live-close]').click();learning.render();}
  });
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){root.open=false;root.querySelector('summary').focus();}});
  learning.render();return root;
}
