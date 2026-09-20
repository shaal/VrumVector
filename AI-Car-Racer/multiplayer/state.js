// Shared, deliberately small wire format. Never accept arbitrary car objects.
export const COLORS = ['#79dec6','#f3bc76','#bca4f5','#f49cab','#8acaf5','#d5e58c'];
export const ACTIVE_TTL = 15000;
// Chrome can batch background timers once a minute. Allow two missed beats,
// while still expiring abandoned sessions if their socket never closes.
export const AWAY_TTL = 150000;
export const presenceTTL = state => state?.away ? AWAY_TTL : ACTIVE_TTL;
export const driverLabel = (name,state) => name+(state?.away?' · away':state?.paused?' · paused':'');
// Range inputs (and older saved physics) supply strings. Equal driving rules
// must produce the same room as the numeric defaults used by a fresh visitor.
// Keep protocol 1's numeric key so existing default clients can still join.
export function roomKey(track, maxSpeed, traction, invincible) {
  return JSON.stringify([1,track,Number(maxSpeed),Number(traction),!!invincible]);
}
// Share only bounded geometry and driving rules, never arbitrary editor/car
// objects. Canonical {x,y} order also matches older saves with extra metadata.
export function validSetup(value) {
  if (!value || typeof value.invincible!=='boolean') return null;
  const point=p=>p&&['x','y'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k])&&Math.abs(p[k])<=20000)?{x:p.x,y:p.y}:null;
  const wall=list=>Array.isArray(list)&&list.length>=3&&list.length<=256?list.map(point):null;
  const inner=wall(value.inner),outer=wall(value.outer);
  if (!inner || !outer || inner.includes(null) || outer.includes(null)) return null;
  if (!Array.isArray(value.gates)||value.gates.length<2||value.gates.length>256) return null;
  const gates=value.gates.map(g=>Array.isArray(g)&&g.length===2?g.map(point):null);
  if(gates.some(g=>!g||g.includes(null)||(g[0].x===g[1].x&&g[0].y===g[1].y)))return null;
  const maxSpeed=Number(value.maxSpeed),traction=Number(value.traction);
  if(!['number','string'].includes(typeof value.maxSpeed)||!['number','string'].includes(typeof value.traction)||
     !Number.isFinite(maxSpeed)||maxSpeed<=0||maxSpeed>100||!Number.isFinite(traction)||traction<0||traction>1)return null;
  return {inner,outer,gates,maxSpeed,traction,invincible:value.invincible};
}
export function setupKey(setup) {
  return roomKey(JSON.stringify([setup.inner,setup.outer,setup.gates]),setup.maxSpeed,setup.traction,setup.invincible);
}
export function cleanCallsign(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu,'').trim().replace(/\s+/g,' ').slice(0,24) : '';
}
export function randomCallsign(random = crypto.getRandomValues.bind(crypto)) {
  const words = ['Comet','Falcon','Otter','Lynx','Fox','Kestrel','Gecko','Panda'];
  const adjectives = ['Neon','Silver','Turbo','Cosmic','Swift','Lunar','Copper','Velvet'];
  const n = random(new Uint32Array(3));
  return `${adjectives[n[0]%8]} ${words[n[1]%8]} ${10+n[2]%90}`;
}
export function validState(s) {
  if (!s || !['x','y','angle','speed'].every(k=>typeof s[k]==='number'&&Number.isFinite(s[k]))) return null;
  if (Math.abs(s.x)>20000 || Math.abs(s.y)>20000 || Math.abs(s.speed)>100 || Math.abs(s.angle)>1e6) return null;
  if (!Number.isInteger(s.laps) || s.laps<0 || s.laps>100000) return null;
  if (s.bestLap!==null && !(typeof s.bestLap==='number'&&Number.isFinite(s.bestLap)&&s.bestLap>=1&&s.bestLap<=3600)) return null;
  if (s.away!==undefined && typeof s.away!=='boolean') return null;
  const away=s.away===true;
  return {x:s.x,y:s.y,angle:s.angle,speed:away?0:s.speed,damaged:!!s.damaged,paused:away||!!s.paused,away,laps:s.laps,bestLap:s.bestLap};
}
export function samplePeer(peer, now) {
  if (!peer.current || now-peer.received>(peer.current.away?AWAY_TTL:3000)) return null;
  const b=peer.current, a=peer.previous;
  if (!a || b.away || a.away || b.damaged!==a.damaged || Math.hypot(b.x-a.x,b.y-a.y)>250) return b;
  const t=Math.max(0,Math.min(1,(now-peer.received)/Math.max(50,peer.interval||100)));
  const turn=Math.atan2(Math.sin(b.angle-a.angle),Math.cos(b.angle-a.angle));
  return {...b,x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle:a.angle+turn*t};
}
function crosses(a,b,gate) {
  const [c,d]=gate, rx=b.x-a.x, ry=b.y-a.y, sx=d.x-c.x, sy=d.y-c.y;
  const den=rx*sy-ry*sx;
  if (Math.abs(den)<1e-8) return false;
  const t=((c.x-a.x)*sy-(c.y-a.y)*sx)/den;
  const u=((c.x-a.x)*ry-(c.y-a.y)*rx)/den;
  return t>0 && t<=1 && u>=0 && u<=1;
}
// Ordered gate crossings, separate from the AI generation clock. Pausing,
// crashing, teleporting and leaving invalidate the current attempt.
export class LapClock {
  constructor(){this.laps=0;this.bestLap=null;this.invalidate();}
  invalidate(){this.previous=null;this.next=0;this.elapsed=0;this.running=false;}
  step(car,gates,dt=1/60){
    if (!car || car.damaged || !Number.isFinite(car.x+car.y) || gates.length<2){this.invalidate();return;}
    const point={x:car.x,y:car.y};
    if (this.running) this.elapsed+=dt;
    if (this.previous && Math.hypot(point.x-this.previous.x,point.y-this.previous.y)>100){this.invalidate();}
    if (this.previous && crosses(this.previous,point,gates[this.next])){
      if (this.next===0){
        if (this.running && this.elapsed>=1){
          this.laps++;this.bestLap=Math.min(this.bestLap??Infinity,this.elapsed);
        }
        this.elapsed=0;this.running=true;
      }
      this.next=(this.next+1)%gates.length;
    }
    this.previous=point;
  }
}
