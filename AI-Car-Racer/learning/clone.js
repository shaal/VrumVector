// Behavioural cloning: train the deployed [10, 16, 4] driving network to copy
// recorded driving. Pure (no DOM, no globals), so the same code runs in the
// browser worker (clone-worker.js) and in Node tests.
//
// The deployed network is hidden = tanh(W1·x − b1) and a hard threshold per
// key: key on when W2·hidden > b2. Training swaps the threshold for
// p = sigmoid(W2·hidden − b2) with binary cross-entropy per key. At run time
// `sum > bias` is exactly `p > 0.5`, so the trained weights drive the real
// network unchanged.
//
// Dataset (what H2 produces from recordings). One row per physics step:
//   inputs  Float32Array(n*10)  row t: the 10 inputs the car computed at the
//                               end of step t (7 rays, speed, lf, lr).
//   keys    Uint8Array(n*4)     row t: forward, left, right, reverse held
//                               during step t (1 held, 0 not).
//   episode Uint32Array(n)      run id. Rows of one run are consecutive
//                               physics steps. Start a new id at any gap
//                               (dropped steps, a crash reset, a new lap file).
//   sameSplitAs Int32Array(n)   optional. Row t goes to the same side of the
//                               train/held-out split as row sameSplitAs[t]
//                               (-1: no link). For mirrored copies, so a block
//                               and its mirror are never split apart.
// Rows are unpaired. The trainer pairs the inputs of row t with the keys of
// row t + k (the key lag). car.update() moves first and senses last, so k = 1
// is the key that acts on that state; a person reacts later. Pairs never
// cross a run boundary or a train/held-out boundary.
import {seededRandom} from '../graphics/state.js';

export const INPUT_COUNT=10,HIDDEN_COUNT=16,KEY_COUNT=4,FLAT_LENGTH=244;
export const KEY_NAMES=Object.freeze(['forward','left','right','reverse']);
// Flat layout (brainCodec.js): per level, biases then weights[j*out + i].
const B1=0,W1=HIDDEN_COUNT,B2=W1+INPUT_COUNT*HIDDEN_COUNT,W2=B2+KEY_COUNT;
export const CLONE_DEFAULTS=Object.freeze({
  seed:'clone-v1',
  // Key lags tried, in physics steps (60 per second). 1 = the next step.
  lags:Object.freeze([1,2,4,6,8,10,12,14,16]),
  blockSteps:120,        // held-out split by 2-second blocks, never by single steps
  heldOutFraction:.2,     // share of rows held out
  minScoredPairs:60,      // held-out pairs needed to compare lags (1 s)
  batchSize:64,learningRate:.01,
  maxEpochs:150,patience:30,
  screenEpochs:10,       // every lag trains this long; the best `finalists` train to the end
  finalists:2,
  rarePower:.5,rareCap:10, // a key's rarer value weighs max(1, min(cap, (common/rare)^power))
});

export class CloneError extends Error{
  constructor(code,message){super(message);this.name='CloneError';this.code=code;}
}

// Checks and normalizes a dataset. Throws CloneError('invalid-data'|'not-enough-data').
export function prepareDataset(dataset){
  const d=dataset||{};
  const length=v=>v&&typeof v.length==='number'?v.length:-1;
  const n=length(d.episode);
  if(n<0||length(d.inputs)!==n*INPUT_COUNT||length(d.keys)!==n*KEY_COUNT)
    throw new CloneError('invalid-data',`Expected inputs of n*${INPUT_COUNT}, keys of n*${KEY_COUNT}, and episode of n values.`);
  if(n===0)throw new CloneError('not-enough-data','The dataset is empty.');
  if(!ArrayBuffer.isView(d.inputs))for(let i=0;i<d.inputs.length;i++)
    if(typeof d.inputs[i]!=='number')throw new CloneError('invalid-data',`Input ${i} is not a number.`);
  // Checked after the Float32 conversion: 1e39 is finite, but not as a Float32.
  let inputs=d.inputs;
  if(!(inputs instanceof Float32Array)){
    try{inputs=Float32Array.from(inputs);}catch{throw new CloneError('invalid-data','Inputs must be numbers.');}
  }
  for(let i=0;i<inputs.length;i++)if(!Number.isFinite(inputs[i]))throw new CloneError('invalid-data',`Input ${i} is not a finite 32-bit number.`);
  const keys=new Uint8Array(n*KEY_COUNT);
  for(let i=0;i<keys.length;i++){
    const v=d.keys[i];
    if(v===1||v===true)keys[i]=1;
    else if(v!==0&&v!==false)throw new CloneError('invalid-data',`Key ${i} is not 0 or 1.`);
  }
  // run[t] counts episode changes up to row t, so equal run numbers mean
  // consecutive steps of one run, even if an id is reused later.
  const run=new Uint32Array(n);
  for(let t=1;t<n;t++)run[t]=run[t-1]+(d.episode[t]===d.episode[t-1]?0:1);
  let link=null;
  if(d.sameSplitAs!=null){
    if(length(d.sameSplitAs)!==n)throw new CloneError('invalid-data','sameSplitAs must have one value per row.');
    link=new Int32Array(n);
    for(let t=0;t<n;t++){
      const to=d.sameSplitAs[t];
      if(!(to===-1||(Number.isInteger(to)&&to>=0&&to<n&&to!==t)))
        throw new CloneError('invalid-data',`sameSplitAs[${t}] must be -1 or the index of another row.`);
      link[t]=to;
    }
    for(let t=0;t<n;t++)if(link[t]>=0&&link[link[t]]!==-1)
      throw new CloneError('invalid-data',`sameSplitAs[${t}] must point to a row that is not linked itself.`);
    // Link whole runs (a mirrored run), so every block is linked or not.
    for(let t=1;t<n;t++)if(run[t]===run[t-1]&&(link[t]<0)!==(link[t-1]<0))
      throw new CloneError('invalid-data',`Row ${t}: a run must be all linked or all unlinked (link whole runs).`);
  }
  return {inputs,keys,run,link,n};
}

function checkOptions(o){
  const positiveInt=v=>Number.isInteger(v)&&v>0;
  if(!positiveInt(o.blockSteps))throw new CloneError('invalid-options','blockSteps must be a positive integer.');
  if(!Array.isArray(o.lags)||!o.lags.length||!o.lags.every(k=>positiveInt(k)&&k<=o.blockSteps))
    throw new CloneError('invalid-options','lags must be positive integers no larger than blockSteps.');
  for(const key of ['batchSize','maxEpochs','patience','screenEpochs','finalists'])
    if(!positiveInt(o[key]))throw new CloneError('invalid-options',`${key} must be a positive integer.`);
  if(!(o.heldOutFraction>0&&o.heldOutFraction<1))throw new CloneError('invalid-options','heldOutFraction must be between 0 and 1.');
  if(!(o.learningRate>0&&o.learningRate<=1))throw new CloneError('invalid-options','learningRate must be above 0 and at most 1.');
  if(!(Number.isFinite(o.rarePower)&&o.rarePower>=0))throw new CloneError('invalid-options','rarePower must be a non-negative number.');
  if(!(Number.isFinite(o.rareCap)&&o.rareCap>=1))throw new CloneError('invalid-options','rareCap must be a number of at least 1.');
  if(!(Number.isInteger(o.minScoredPairs)&&o.minScoredPairs>=1))throw new CloneError('invalid-options','minScoredPairs must be a positive integer.');
}

// Time-block split. Each run is cut into blocks of `blockSteps` consecutive
// rows. A run's last piece joins the block before it when it is shorter than
// half a block (a run shorter than a block is one block). A seeded shuffle
// then holds out whole blocks until `heldOutFraction` of the rows are held
// out: at least one block, and never all. Linked rows (sameSplitAs) follow
// the row they link to; their blocks are not drawn.
export function splitBlocks(data,{blockSteps=CLONE_DEFAULTS.blockSteps,heldOutFraction=CLONE_DEFAULTS.heldOutFraction,seed=CLONE_DEFAULTS.seed}={}){
  const {n,run,link}=data,block=new Uint32Array(n),size=[],free=[];
  let blocks=0;
  for(let t=0;t<n;){
    let end=t;while(end<n&&run[end]===run[t])end++;
    const whole=Math.floor((end-t)/blockSteps),rest=end-t-whole*blockSteps;
    const count=whole?whole+(rest>=blockSteps/2?1:0):1;
    for(let b=0;b<count;b++){size.push(0);free.push(0);}
    for(let i=t;i<end;i++){
      const b=blocks+Math.min(count-1,Math.floor((i-t)/blockSteps));
      block[i]=b;size[b]++;if(!link||link[i]<0)free[b]++;
    }
    blocks+=count;t=end;
  }
  const drawn=[];for(let b=0;b<blocks;b++)if(free[b])drawn.push(b);
  if(drawn.length<2)throw new CloneError('not-enough-data',`Need at least two blocks of ${blockSteps} steps; got ${n} steps.`);
  const random=seededRandom(seed+':split');
  for(let i=drawn.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[drawn[i],drawn[j]]=[drawn[j],drawn[i]];}
  const total=free.reduce((sum,v)=>sum+v,0),heldBlock=new Uint8Array(blocks);
  let heldRows=0,heldOutBlocks=0;
  for(const b of drawn){
    if(heldOutBlocks&&(heldRows>=heldOutFraction*total||heldOutBlocks===drawn.length-1))break;
    heldBlock[b]=1;heldRows+=free[b];heldOutBlocks++;
  }
  const held=new Uint8Array(n);
  for(let t=0;t<n;t++)held[t]=heldBlock[block[t]];
  if(link)for(let t=0;t<n;t++)if(link[t]>=0)held[t]=held[link[t]];
  return {block,held,blocks,heldOutBlocks,heldOutShare:heldRows/total};
}

// Row indices t whose pair (inputs t, keys t + lag) stays inside one run and
// one split. lag <= blockSteps, so a pair touches at most two adjacent blocks.
export function pairRows(data,split,lag){
  const {n,run}=data,{held}=split,train=[],heldOut=[];
  for(let t=0;t+lag<n;t++){
    if(run[t]!==run[t+lag]||held[t]!==held[t+lag])continue;
    (held[t]?heldOut:train).push(t);
  }
  return {train:Uint32Array.from(train),heldOut:Uint32Array.from(heldOut)};
}

// The deployed network, step for step: Level.feedForward with Float32 inputs,
// weights, and hidden outputs, and the `sum > bias` gate. Returns 0/1 per key.
const scratchIn=new Float32Array(INPUT_COUNT),scratchHidden=new Float32Array(HIDDEN_COUNT);
export function predict(flat,x,out=new Uint8Array(KEY_COUNT)){
  for(let j=0;j<INPUT_COUNT;j++)scratchIn[j]=x[j];
  for(let i=0;i<HIDDEN_COUNT;i++){
    let sum=0,k=W1+i;
    for(let j=0;j<INPUT_COUNT;j++){sum+=scratchIn[j]*flat[k];k+=HIDDEN_COUNT;}
    scratchHidden[i]=Math.tanh(sum-flat[B1+i]);
  }
  for(let o=0;o<KEY_COUNT;o++){
    let sum=0,k=W2+o;
    for(let i=0;i<HIDDEN_COUNT;i++){sum+=scratchHidden[i]*flat[k];k+=KEY_COUNT;}
    out[o]=sum>flat[B2+o]?1:0;
  }
  return out;
}

// Per-key precision, recall, and F1, and how often all four keys match.
// F1 is null when a key has no presses and the network never presses it.
export function evaluate(flat,data,rows,lag){
  const weights=flat instanceof Float32Array?flat:Float32Array.from(flat);
  const tp=new Uint32Array(KEY_COUNT),fp=new Uint32Array(KEY_COUNT),fn=new Uint32Array(KEY_COUNT),out=new Uint8Array(KEY_COUNT);
  const x=new Float32Array(INPUT_COUNT);
  let all=0;
  for(const t of rows){
    for(let j=0;j<INPUT_COUNT;j++)x[j]=data.inputs[t*INPUT_COUNT+j];
    predict(weights,x,out);
    let same=true;
    for(let o=0;o<KEY_COUNT;o++){
      const y=data.keys[(t+lag)*KEY_COUNT+o];
      if(out[o]&&y)tp[o]++;else if(out[o])fp[o]++;else if(y)fn[o]++;
      if(out[o]!==y)same=false;
    }
    if(same)all++;
  }
  const ratio=(a,b)=>b?a/b:null;
  const keys=KEY_NAMES.map((key,o)=>({key,f1:ratio(2*tp[o],2*tp[o]+fp[o]+fn[o]),precision:ratio(tp[o],tp[o]+fp[o]),
    recall:ratio(tp[o],tp[o]+fn[o]),support:tp[o]+fn[o],predicted:tp[o]+fp[o]}));
  return {pairs:rows.length,agreement:ratio(all,rows.length),keys};
}

// Per-input mean and spread over training rows. Training runs on standardized
// inputs; fold() moves the scaling into the first layer afterwards. The spread
// floor keeps an input that barely varied from getting a huge folded weight
// (inputs are fractions, so 0.05 is 5% of their range). A column that never
// varies gets zero weight, so the clone ignores what it never saw.
const SPREAD_FLOOR=.05;
function inputScale(data,split){
  const mean=new Float64Array(INPUT_COUNT),spread=new Float64Array(INPUT_COUNT),constant=new Uint8Array(INPUT_COUNT);
  let count=0;
  for(let t=0;t<data.n;t++)if(!split.held[t]){count++;for(let j=0;j<INPUT_COUNT;j++)mean[j]+=data.inputs[t*INPUT_COUNT+j];}
  for(let j=0;j<INPUT_COUNT;j++)mean[j]/=Math.max(1,count);
  for(let t=0;t<data.n;t++)if(!split.held[t])for(let j=0;j<INPUT_COUNT;j++){const d=data.inputs[t*INPUT_COUNT+j]-mean[j];spread[j]+=d*d;}
  for(let j=0;j<INPUT_COUNT;j++){
    spread[j]=Math.sqrt(spread[j]/Math.max(1,count));
    if(!(spread[j]>1e-6)){spread[j]=1;constant[j]=1;}
    else spread[j]=Math.max(spread[j],SPREAD_FLOOR);
  }
  const scaled=new Float64Array(data.n*INPUT_COUNT);
  for(let t=0;t<data.n;t++)for(let j=0;j<INPUT_COUNT;j++){
    const at=t*INPUT_COUNT+j;scaled[at]=constant[j]?0:(data.inputs[at]-mean[j])/spread[j];
  }
  return {mean,spread,constant,scaled};
}

function initialWeights(seed,constant){
  const p=new Float64Array(FLAT_LENGTH),random=seededRandom(seed+':init');
  const a1=Math.sqrt(6/(INPUT_COUNT+HIDDEN_COUNT)),a2=Math.sqrt(6/(HIDDEN_COUNT+KEY_COUNT));
  for(let j=0;j<INPUT_COUNT;j++)for(let i=0;i<HIDDEN_COUNT;i++){const v=(random()*2-1)*a1;p[W1+j*HIDDEN_COUNT+i]=constant[j]?0:v;}
  for(let k=W2;k<FLAT_LENGTH;k++)p[k]=(random()*2-1)*a2;
  return p;
}

// Rare-key weights from the keys of the training rows, shared by every lag so
// that lag losses compare. Forward is held most of the time, so "not forward"
// is its rare value; steering and reverse are rarely held. The rarer value of
// a key weighs max(1, min(cap, (common/rare)^power)); then both values are
// scaled so the mean weight per key over the training rows is 1.
function keyWeights(data,split,{rarePower,rareCap}){
  const pos=new Float64Array(KEY_COUNT),neg=new Float64Array(KEY_COUNT);
  const on=new Float64Array(KEY_COUNT).fill(1),off=new Float64Array(KEY_COUNT).fill(1);
  for(let t=0;t<data.n;t++)if(!split.held[t])for(let o=0;o<KEY_COUNT;o++)data.keys[t*KEY_COUNT+o]?pos[o]++:neg[o]++;
  for(let o=0;o<KEY_COUNT;o++){
    if(!pos[o]||!neg[o])continue;
    const rare=Math.min(pos[o],neg[o]),common=Math.max(pos[o],neg[o]);
    const weight=Math.max(1,Math.min(rareCap,(common/rare)**rarePower));
    if(pos[o]<neg[o])on[o]=weight;else off[o]=weight;
    const mean=(pos[o]*on[o]+neg[o]*off[o])/(pos[o]+neg[o]);
    on[o]/=mean;off[o]/=mean;
  }
  return {on,off,held:Array.from(pos,(p,o)=>p/Math.max(1,p+neg[o]))};
}

// Softplus written to stay finite for any z: log(1 + e^z).
const softplus=z=>z>0?z+Math.log1p(Math.exp(-z)):Math.log1p(Math.exp(z));

// One lag's training run: mini-batch Adam on weighted BCE over its training
// pairs. The loss on the shared held-out rows (`scored`) picks the best epoch
// (early stopping) and compares lags.
class LagTrainer{
  constructor({data,scale,rows,scored,lag,weights,options,init}){
    Object.assign(this,{data,scale,rows,scored,lag,weights,options});
    this.p=Float64Array.from(init);this.m=new Float64Array(FLAT_LENGTH);this.v=new Float64Array(FLAT_LENGTH);
    this.grad=new Float64Array(FLAT_LENGTH);this.order=Uint32Array.from(rows.train);
    this.random=seededRandom(options.seed+':order');this.steps=0;
    this.hidden=new Float64Array(HIDDEN_COUNT);this.dHidden=new Float64Array(HIDDEN_COUNT);this.z=new Float64Array(KEY_COUNT);
    this.epochs=0;this.bestEpoch=0;this.bestLoss=this.loss(scored);this.best=Float64Array.from(this.p);
  }
  get done(){return this.epochs>=this.options.maxEpochs||this.epochs-this.bestEpoch>=this.options.patience;}
  forward(t){
    const p=this.p,x=this.scale.scaled,base=t*INPUT_COUNT,h=this.hidden,z=this.z;
    for(let i=0;i<HIDDEN_COUNT;i++){
      let sum=-p[B1+i];
      for(let j=0;j<INPUT_COUNT;j++)sum+=x[base+j]*p[W1+j*HIDDEN_COUNT+i];
      h[i]=Math.tanh(sum);
    }
    for(let o=0;o<KEY_COUNT;o++){
      let sum=-p[B2+o];
      for(let i=0;i<HIDDEN_COUNT;i++)sum+=h[i]*p[W2+i*KEY_COUNT+o];
      z[o]=sum;
    }
    return z;
  }
  loss(rows){
    if(!rows.length)return Infinity;
    const {keys}=this.data,{on,off}=this.weights;let total=0;
    for(const t of rows){
      const z=this.forward(t),at=(t+this.lag)*KEY_COUNT;
      for(let o=0;o<KEY_COUNT;o++)total+=keys[at+o]?on[o]*softplus(-z[o]):off[o]*softplus(z[o]);
    }
    return total/rows.length;
  }
  epoch(){
    const {order,random,grad,p,m,v,hidden:h,dHidden:dh}=this,{batchSize,learningRate}=this.options;
    const {keys}=this.data,{on,off}=this.weights,x=this.scale.scaled;
    for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1)),s=order[i];order[i]=order[j];order[j]=s;}
    for(let start=0;start<order.length;start+=batchSize){
      const end=Math.min(order.length,start+batchSize);
      grad.fill(0);
      for(let b=start;b<end;b++){
        const t=order[b],z=this.forward(t),base=t*INPUT_COUNT,at=(t+this.lag)*KEY_COUNT;
        dh.fill(0);
        for(let o=0;o<KEY_COUNT;o++){
          const y=keys[at+o],g=(y?on[o]:off[o])*(1/(1+Math.exp(-z[o]))-y);
          grad[B2+o]-=g;
          for(let i=0;i<HIDDEN_COUNT;i++){grad[W2+i*KEY_COUNT+o]+=h[i]*g;dh[i]+=p[W2+i*KEY_COUNT+o]*g;}
        }
        for(let i=0;i<HIDDEN_COUNT;i++){
          const da=dh[i]*(1-h[i]*h[i]);
          grad[B1+i]-=da;
          for(let j=0;j<INPUT_COUNT;j++)grad[W1+j*HIDDEN_COUNT+i]+=x[base+j]*da;
        }
      }
      // Adam on the batch mean gradient.
      const scale=1/(end-start),step=++this.steps;
      const c1=1-.9**step,c2=1-.999**step;
      for(let k=0;k<FLAT_LENGTH;k++){
        const g=grad[k]*scale;
        m[k]=.9*m[k]+.1*g;v[k]=.999*v[k]+.001*g*g;
        p[k]-=learningRate*(m[k]/c1)/(Math.sqrt(v[k]/c2)+1e-8);
      }
    }
    // Columns that never varied keep exactly zero weight (their gradient is 0).
    this.epochs++;
    const loss=this.loss(this.scored);
    if(loss<this.bestLoss-1e-9){this.bestLoss=loss;this.bestEpoch=this.epochs;this.best.set(p);}
    return loss;
  }
}

// Undo the input standardization inside the first layer:
//   tanh(sum_j W (x_j − mean_j)/spread_j − b) = tanh(sum_j (W/spread_j) x_j − (b + sum_j W mean_j/spread_j)).
function fold(p,scale){
  const flat=new Float32Array(FLAT_LENGTH);
  for(let i=0;i<HIDDEN_COUNT;i++){
    let bias=p[B1+i];
    for(let j=0;j<INPUT_COUNT;j++){
      const w=scale.constant[j]?0:p[W1+j*HIDDEN_COUNT+i]/scale.spread[j];
      flat[W1+j*HIDDEN_COUNT+i]=w;bias+=w*scale.mean[j];
    }
    flat[B1+i]=bias;
  }
  for(let k=B2;k<FLAT_LENGTH;k++)flat[k]=p[k];
  return flat;
}

// Trains a clone. Returns {weights: Float32Array(244) in the flat layout, report}.
// Lag choice: every lag trains `screenEpochs` epochs from the same start and
// shuffles; the `finalists` lags with the lowest held-out loss train on to the
// early stop; the lowest held-out loss wins (ties go to the shorter lag).
// report.heldOut scores the chosen lag on all of its held-out pairs.
export function trainClone(dataset,options={}){
  const started=typeof performance!=='undefined'?performance.now():Date.now();
  const {onProgress,...rest}=options||{},o={...CLONE_DEFAULTS};
  for(const [key,value] of Object.entries(rest))if(value!==undefined)o[key]=value;
  if(Array.isArray(o.lags))o.lags=[...new Set(o.lags)].sort((a,b)=>a-b);
  checkOptions(o);
  const data=prepareDataset(dataset),split=splitBlocks(data,o),scale=inputScale(data,split),init=initialWeights(o.seed,scale.constant);
  // Every lag is scored on the same held-out input rows, with the same key
  // weights: the rows whose pair stays in one run and one split even at the
  // longest lag. (The keys they are scored against still shift with the lag.)
  // Otherwise a longer lag would skip the last input rows of each run. Lags
  // too long for the data are dropped until enough rows remain.
  const lags=o.lags.slice(),skipped=[];let common=null;
  while(lags.length){
    common=pairRows(data,split,lags.at(-1));
    if(common.train.length>=o.minScoredPairs&&common.heldOut.length>=o.minScoredPairs)break;
    skipped.unshift(lags.pop());
  }
  if(!lags.length)throw new CloneError('not-enough-data',`Need at least ${o.minScoredPairs} training and ${o.minScoredPairs} held-out pairs; record more driving.`);
  const weights=keyWeights(data,split,o);
  const trainers=lags.map(lag=>new LagTrainer({data,scale,rows:pairRows(data,split,lag),scored:common.heldOut,lag,weights,options:o,init}));
  const report=progress=>onProgress?.(progress);
  for(const trainer of trainers){
    while(trainer.epochs<o.screenEpochs&&!trainer.done){const loss=trainer.epoch();report({phase:'screen',lag:trainer.lag,epoch:trainer.epochs,loss});}
    trainer.screenLoss=trainer.bestLoss;
  }
  const byLoss=(a,b)=>a.bestLoss-b.bestLoss||a.lag-b.lag;
  const finalists=trainers.slice().sort(byLoss).slice(0,o.finalists);
  for(const trainer of finalists){
    while(!trainer.done){const loss=trainer.epoch();report({phase:'train',lag:trainer.lag,epoch:trainer.epochs,loss});}
  }
  const chosen=finalists.slice().sort(byLoss)[0];
  const flat=fold(chosen.best,scale);
  if(!Number.isFinite(chosen.bestLoss)||!flat.every(Number.isFinite))
    throw new CloneError('diverged','Training diverged; try a lower learning rate.');
  let maxAbs=0;for(const w of flat)maxAbs=Math.max(maxAbs,Math.abs(w));
  const ended=typeof performance!=='undefined'?performance.now():Date.now();
  return {weights:flat,report:{
    lag:chosen.lag,epochs:chosen.epochs,bestEpoch:chosen.bestEpoch,heldOutLoss:chosen.bestLoss,scoredPairs:common.heldOut.length,
    // The same blocks chose the epoch and the lag, so this is slightly optimistic.
    heldOut:evaluate(flat,data,chosen.rows.heldOut,chosen.lag),
    train:(({pairs,agreement})=>({pairs,agreement}))(evaluate(flat,data,chosen.rows.train,chosen.lag)),
    lags:trainers.map(t=>({lag:t.lag,screenLoss:t.screenLoss,finalLoss:finalists.includes(t)?t.bestLoss:null,epochs:t.epochs})),
    skippedLags:skipped,
    keyBalance:Object.fromEntries(KEY_NAMES.map((key,i)=>[key,weights.held[i]])),
    split:{steps:data.n,runs:data.run[data.n-1]+1,blocks:split.blocks,heldOutBlocks:split.heldOutBlocks,heldOutShare:split.heldOutShare,blockSteps:o.blockSteps},
    maxAbsWeight:maxAbs,seed:o.seed,ms:Math.round(ended-started),
  }};
}

// Runs trainClone in a module worker so training never blocks rendering.
// Resolves {weights, report}. Rejects with CloneError (the worker's reason, or
// 'worker-failed'), or with an AbortError when `signal` aborts. A worker that
// dies without an error event is not detected.
let nextJob=0;
export function trainCloneInWorker(dataset,options){
  const {signal,onProgress,spawn=()=>new Worker(new URL('./clone-worker.js',import.meta.url),{type:'module'}),...rest}=options||{};
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new DOMException('Cloning cancelled','AbortError'));return;}
    const id=++nextJob;let worker=null,settled=false;
    const finish=(settle,value)=>{
      if(settled)return;settled=true;
      signal?.removeEventListener?.('abort',abort);
      try{worker?.terminate();}catch{}
      settle(value);
    };
    const abort=()=>finish(reject,new DOMException('Cloning cancelled','AbortError'));
    try{
      worker=spawn();
      signal?.addEventListener('abort',abort,{once:true});
      worker.onmessage=({data:m})=>{
        if(settled||m?.id!==id)return;
        if(m.type==='progress'){
          // A failing progress callback must not stop the result from arriving.
          try{onProgress?.(m);}catch(error){console.error('Cloning progress callback failed',error);}
        }
        else if(m.type==='result')finish(resolve,{weights:m.weights,report:m.report});
        else if(m.type==='error')finish(reject,new CloneError(m.code,m.message));
      };
      worker.onerror=event=>{event?.preventDefault?.();finish(reject,new CloneError('worker-failed',event?.message||'The cloning worker failed.'));};
      worker.onmessageerror=()=>finish(reject,new CloneError('worker-failed','The cloning worker sent an unreadable message.'));
      worker.postMessage({type:'train',id,dataset:{inputs:dataset?.inputs,keys:dataset?.keys,episode:dataset?.episode,sameSplitAs:dataset?.sameSplitAs},options:rest});
    }catch(error){
      finish(reject,error instanceof CloneError?error:new CloneError('worker-failed',String(error?.message||error)));
    }
  });
}
