// Shared, deliberately small wire format. Never accept arbitrary car objects.
export const COLORS = ['#79dec6','#f3bc76','#bca4f5','#f49cab','#8acaf5','#d5e58c'];
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
  return {x:s.x,y:s.y,angle:s.angle,speed:s.speed,damaged:!!s.damaged,paused:!!s.paused,laps:s.laps,bestLap:s.bestLap};
}
export function samplePeer(peer, now) {
  if (!peer.current || now-peer.received>3000) return null;
  const b=peer.current, a=peer.previous;
  if (!a || b.damaged!==a.damaged || Math.hypot(b.x-a.x,b.y-a.y)>250) return b;
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
