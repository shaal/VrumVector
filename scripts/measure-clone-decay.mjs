// Weight decay for "Use my driving" clones (H4). For each track and teacher
// seed: evolve a teacher, record its driving, train clones with each decay,
// and report held-out agreement, closed-loop progress (spawn and 12 new
// starts, 30 s each), weight size, and how often the genetic run's mutation
// changes the keys (tests/helpers/mutation.mjs). Deterministic: the same
// seeds give the same numbers. Results: docs/validation/human-demonstration.md (H4).
//
//   node scripts/measure-clone-decay.mjs [--decays 0,0.001] [--teachers b,a,c,d,e,f,g] [--out file.json]
import {writeFile} from 'node:fs/promises';
import {evolveTeacher,drive,record} from '../tests/helpers/teacher.mjs';
import {mutationEffect,weightSize} from '../tests/helpers/mutation.mjs';
import {trainClone} from '../AI-Car-Racer/learning/clone.js';
import {seededRandom} from '../AI-Car-Racer/graphics/state.js';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const decays=arg('--decays','0,0.001').split(',').map(Number),teachers=arg('--teachers','b,a,c,d,e,f,g').split(','),out=arg('--out',null);
const sum=list=>list.reduce((a,b)=>a+b,0),mean=list=>sum(list)/list.length;
const rows=[];
for(const track of ['Rectangle','Triangle'])for(const name of teachers){
  // H3's test settings (tests/cloning.test.mjs).
  const t=evolveTeacher({track,seed:'wd-teacher-'+name,generations:24,population:24,seconds:15});
  const {dataset}=record(t.sim,t.vector,{episodes:40,rows:18000,seconds:15,seed:'clone-record-'+track});
  const random=seededRandom('clone-loop-'+track),starts=[t.sim.spawn];
  for(let i=0;i<12;i++){const s=t.sim.spawn;starts.push({x:s.x+(random()*2-1)*12,y:s.y+(random()*2-1)*12,angle:s.angle+(random()*2-1)*.12});}
  const loop=net=>sum(starts.map(start=>drive(t.sim,net,{seconds:30,start}).progress));
  const teacher={progress:loop(t.vector),size:weightSize(t.vector),mutation:mutationEffect(t.vector,dataset.inputs,{every:7})};
  for(const weightDecay of decays){
    const {weights,report}=trainClone(dataset,{weightDecay});
    const row={track,teacher:name,weightDecay,agreement:report.heldOut.agreement,progress:loop(weights),teacherProgress:teacher.progress,
      size:weightSize(weights),mutation:mutationEffect(weights,dataset.inputs,{every:7}),teacherSize:teacher.size,teacherMutation:teacher.mutation};
    rows.push(row);console.log(JSON.stringify(row));
  }
}
const fixed=v=>v.toFixed(2);
for(const track of ['Rectangle','Triangle'])for(const weightDecay of decays){
  const r=rows.filter(x=>x.track===track&&x.weightDecay===weightDecay);
  console.log(`${track} decay ${weightDecay} (n=${r.length}): agreement ${fixed(mean(r.map(x=>x.agreement)))}, progress/teacher ${fixed(mean(r.map(x=>x.progress/x.teacherProgress)))}, `+
    `RMS hidden ${fixed(mean(r.map(x=>x.size.hidden)))} output ${fixed(mean(r.map(x=>x.size.output)))}, max ${fixed(mean(r.map(x=>x.size.max)))}, `+
    `keys changed ${fixed(mean(r.map(x=>x.mutation.all)))} (light ${fixed(mean(r.map(x=>x.mutation.light)))}, heavy ${fixed(mean(r.map(x=>x.mutation.heavy)))}); `+
    `teachers: RMS ${fixed(mean(r.map(x=>x.teacherSize.hidden)))}/${fixed(mean(r.map(x=>x.teacherSize.output)))}, keys changed ${fixed(mean(r.map(x=>x.teacherMutation.all)))}`);
}
if(out)await writeFile(out,JSON.stringify(rows,null,2));
