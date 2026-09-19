// Pure learning policy: usable in the game, deterministic tests, and real
// physics benchmarks without a DOM, WASM store, or graphics renderer.
export const FLAT_LENGTH=244;
export const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,Number(n)||0));
export const validBrain=vector=>vector?.length===FLAT_LENGTH&&Array.from(vector).every(Number.isFinite);
export const qualityFromFitness=fitness=>Number.isFinite(fitness)?Math.max(0,Math.tanh(fitness/20)):0;
export function cleanContext(value={}) {
  const allowed=['balanced','calm','careful','wild','reckless'];
  return {version:1,profile:allowed.includes(value.profile)?value.profile:'balanced',
    track:String(value.track||'').slice(0,180),maxSpeed:clamp(value.maxSpeed||15,1,100),
    traction:clamp(value.traction??.5,0,1),seconds:clamp(value.seconds||20,1,600)};
}
export function contextKey(value) {const c=cleanContext(value);return JSON.stringify([c.version,c.profile,c.track,c.maxSpeed,c.traction,c.seconds]);}
export function matchContext(meta,context) {
  if(!context)return {factor:1,exact:false,label:'Archive memory'};
  const q=cleanContext(context),m=meta?.learningContext?cleanContext(meta.learningContext):null;
  if(!m)return {factor:q.profile==='balanced'?.9:.6,exact:false,label:'Legacy memory · style unverified'};
  const profile=m.profile===q.profile,track=!!q.track&&m.track===q.track;
  const physics=m.maxSpeed===q.maxSpeed&&m.traction===q.traction;
  const duration=m.seconds===q.seconds;
  return {factor:(profile?1:.45)*(physics?1:.75)*(duration?1:.85),exact:profile&&track&&physics&&duration,
    label:profile?(track&&physics&&duration?'Same style, track, and conditions':'Same style · transfer candidate'):`${m.profile} style · transfer candidate`};
}
export function selectDiverse(candidates,k=10) {
  const selected=[],limit=Math.max(1,Math.min(50,k|0));
  const pool=candidates.filter(c=>validBrain(c.vector)&&Number.isFinite(c.score)).slice().sort((a,b)=>b.score-a.score).slice(0,Math.max(40,limit*8));
  while(pool.length&&selected.length<limit){
    let best=0,bestScore=-Infinity;
    for(let j=0;j<pool.length;j++){
      let similarity=0;
      for(const chosen of selected){
        let dot=0,aa=0,bb=0;
        for(let i=0;i<FLAT_LENGTH;i++){const a=pool[j].vector[i],b=chosen.vector[i];dot+=a*b;aa+=a*a;bb+=b*b;}
        if(aa&&bb)similarity=Math.max(similarity,dot/Math.sqrt(aa*bb));
        else if(!aa&&!bb)similarity=1;
      }
      const score=pool[j].score*(1-.12*Math.max(0,similarity));
      if(score>bestScore){bestScore=score;best=j;}
    }
    const item=pool.splice(best,1)[0];
    // Exact copies cannot offer a second genetic starting point.
    if(!selected.some(s=>s.vector.every((v,i)=>v===item.vector[i])))selected.push(item);
  }
  return selected;
}
export class LearningCoach {
  constructor(){this.key='';this.reset();}
  reset(){this.incumbent=null;this.stagnant=0;this.rounds=0;this.history=[];this.lastImproved=false;}
  setContext(context){const key=contextKey(context);if(key!==this.key){this.reset();this.key=key;}this.context=cleanContext(context);}
  record(result,vector,id=null){
    if(!validBrain(vector)||!Number.isFinite(result.fitness))return false;
    const progress=Math.max(0,result.fitness),style=clamp(result.styleScore,0,1);
    const improved=!this.incumbent||progress>this.incumbent.fitness||
      (progress===this.incumbent.fitness&&style>this.incumbent.styleScore+1e-5);
    if(improved)this.incumbent={vector:new Float32Array(vector),fitness:progress,styleScore:style,id,meta:{fitness:progress,learningContext:this.context}};
    this.stagnant=improved?0:this.stagnant+1;this.rounds++;this.lastImproved=improved;
    this.history.push({generation:result.generation??this.rounds,fitness:progress,best:this.incumbent.fitness,
      survival:clamp(result.popStillAlive/Math.max(1,result.popN),0,1),speed:clamp(result.driving?.averageSpeed,0,1),improved});
    if(this.history.length>40)this.history.shift();
    return improved;
  }
  plan(baseMutation=.22,adaptive=true,exploration=1){
    const stage=!adaptive?'manual':this.stagnant>=10?'breakthrough':this.stagnant>=5?'explore':this.lastImproved&&this.rounds>1?'refine':'steady';
    const scale=!adaptive?1:stage==='breakthrough'?1.7:stage==='explore'?1.25:stage==='refine'?.8:1;
    const mutation=clamp(baseMutation*scale*exploration,.01,.8);
    return {stage,mutation,novel:stage==='breakthrough'?.35:stage==='explore'?.2:.1,stagnant:this.stagnant,round:this.rounds};
  }
}
export function buildPopulation({N,seeds=[],incumbent=null,plan,random=Math.random,conservative=.65}) {
  N=Math.max(1,Math.min(2000,N|0));
  const pool=seeds.filter(s=>validBrain(s.vector));
  const protectedSeed=incumbent&&validBrain(incumbent.vector)?incumbent:pool[0]||null;
  const flat=new Float32Array(N*FLAT_LENGTH),parents=new Array(N).fill(null),kinds=new Array(N);
  const counts={archive_recall:0,localStorage_prior:0,random_init:0,protected_elite:0};
  const mutation=clamp(plan?.mutation??.22,.01,1),novel=clamp(plan?.novel??.1,0,.8);
  const nNovel=protectedSeed&&N>1?(N===2?(plan?.stagnant>=5&&plan.round%5===0?1:0):Math.min(N-1,Math.max(1,Math.floor(N*novel)))):N;
  function fillRandom(offset){
    for(let j=0;j<FLAT_LENGTH;j++)flat[offset+j]=random()*2-1;
    const push=.5*clamp(conservative,0,1);
    for(let j=0;j<7;j++)for(let i=0;i<16;i++)flat[offset+16+j*16+i]=clamp(flat[offset+16+j*16+i]+push,-1,1);
    for(let j=0;j<16;j++){flat[offset+180+j*4]=clamp(flat[offset+180+j*4]-push,-1,1);flat[offset+183+j*4]=clamp(flat[offset+183+j*4]+push,-1,1);}
  }
  for(let i=0;i<N;i++){
    const offset=i*FLAT_LENGTH,single=!!protectedSeed&&N===1;
    const elite=!!protectedSeed&&i===0&&(!single||(!incumbent&&plan?.round===0));
    const fresh=!protectedSeed||(!single&&i>=N-nNovel)||(single&&plan?.stagnant>=5&&plan.round%5===0);
    // Always mutate the champion as well as recalling other memories. This
    // matters for N=2, where the only challenger must refine the incumbent.
    const source=elite||single||i%2===1?protectedSeed:pool.length?pool[Math.floor((i-2)/2)%pool.length]:protectedSeed;
    if(fresh){fillRandom(offset);counts.random_init++;kinds[i]='random';continue;}
    const amount=elite?0:clamp(mutation*(i%2?.5:1.8),.005,1);
    for(let j=0;j<FLAT_LENGTH;j++)flat[offset+j]=source.vector[j]*(1-amount)+(random()*2-1)*amount;
    parents[i]=source.id||null;kinds[i]=elite?'elite':'mutation';
    if(source.id)counts.archive_recall++;else counts.localStorage_prior++;
    if(elite)counts.protected_elite++;
  }
  return {flat,parents,kinds,counts};
}
export function offspringFeedback(outcome,parentFitness){
  if(!outcome||!Number.isFinite(outcome.meanFitness)||!(outcome.count>0)||!Number.isFinite(parentFitness))return null;
  return clamp((outcome.meanFitness-parentFitness)/Math.max(1,Math.abs(parentFitness)),-1,1);
}
