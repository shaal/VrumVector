import * as T from '../../vendor/three-0.186.0/three.js';
import { SCALE, worldX, worldZ, cleanLoop, pointInLoop, distanceToLoop, seededRandom } from './state.js';

export const THEMES = {
  circuit: { ground: 0xc8c0a7, foliage: [0x67765c, 0x8a946f, 0x526751], rock: 0xaaa58e, sky: 0xe1dbcd },
  alpine: { ground: 0x899788, foliage: [0x294d43, 0x446859, 0x63816b], rock: 0x818d8c, sky: 0xc9dadd },
  desert: { ground: 0xd8b38b, foliage: [0x688070, 0x7c8971, 0x586a55], rock: 0xb87c56, sky: 0xe9d5bd },
};
const standard = (color, extra = {}) => new T.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
const box = (w, h, d) => new T.BoxGeometry(w, h, d);
function mesh(root, geometry, material, x=0, y=0, z=0) {
  const m = new T.Mesh(geometry, material);
  m.position.set(x,y,z); m.castShadow = true; m.receiveShadow = true;
  root.add(m); return m;
}
function instances(root, geometry, material, transforms) {
  const m = new T.InstancedMesh(geometry, material, Math.max(1,transforms.length));
  const d = new T.Object3D();
  transforms.forEach((v,i) => {
    d.position.set(v.x,v.y,v.z); d.rotation.set(v.rx||0,v.ry||0,v.rz||0);
    d.scale.set(v.sx||1,v.sy||1,v.sz||1); d.updateMatrix(); m.setMatrixAt(i,d.matrix);
  });
  m.count=transforms.length; m.castShadow=true; m.receiveShadow=true;
  root.add(m); return m;
}
export function createRoadGeometry(outer, inner) {
  const shape = new T.Shape(outer.map(p=>new T.Vector2(worldX(p.x),-worldZ(p.y))));
  shape.holes.push(new T.Path(inner.map(p=>new T.Vector2(worldX(p.x),-worldZ(p.y)))));
  const g = new T.ShapeGeometry(shape);
  g.rotateX(-Math.PI/2);
  return g;
}
function labelTexture(text, subtext='VECTORVROOM / CIRCUIT STUDIO') {
  const c=document.createElement('canvas'); c.width=1024; c.height=256;
  const x=c.getContext('2d'); x.fillStyle='#242c2b'; x.fillRect(0,0,1024,256);
  x.fillStyle='#f1ede0'; x.font='500 60px system-ui'; x.fillText(text,48,122);
  x.fillStyle='#b5c4b4'; x.font='24px monospace'; x.fillText(subtext,48,185);
  const t=new T.CanvasTexture(c); t.colorSpace=T.SRGBColorSpace; return t;
}

export function buildWorld(road, themeName, quality) {
  const inner=cleanLoop(road.innerList), outer=cleanLoop(road.outerList);
  if(inner.length<3 || outer.length<3) throw new Error('Finish both track boundaries to open Circuit Studio.');
  const theme=THEMES[themeName]||THEMES.circuit;
  const root=new T.Group(); root.name='Circuit';
  const key=JSON.stringify([inner,outer]); const rng=seededRandom(key);
  const inRoad=(x,y)=>pointInLoop(x,y,outer)&&!pointInLoop(x,y,inner);
  const wet=T.uniform(0), vision=T.uniform(0);
  const heatCanvas=document.createElement('canvas'); heatCanvas.width=160; heatCanvas.height=90;
  const heatTexture=new T.CanvasTexture(heatCanvas);
  const slab=standard(0x293331,{roughness:0.65});
  mesh(root,new T.RoundedBoxGeometry(121,2.3,72,3,1.1),slab,0,-1.3,0);
  const terrain=standard(theme.ground);
  mesh(root,new T.RoundedBoxGeometry(120,.5,71,2,.7),terrain,0,-.3,0);
  const roadMat=new T.MeshStandardNodeMaterial({color:0x353e40,roughness:.96,metalness:.06});
  const noise=T.mx_noise_float(T.positionWorld.mul(9));
  const puddle=T.mx_noise_float(T.positionWorld.mul(.24)).smoothstep(.1,.6);
  roadMat.colorNode=T.mix(T.vec3(.15,.18,.19),T.vec3(.095,.13,.15),wet).mul(noise.mul(.13).add(.94));
  roadMat.roughnessNode=T.mix(T.float(.95),puddle.mul(.24).add(.17),wet);
  roadMat.emissiveNode=T.texture(heatTexture,T.vec2(T.positionWorld.x.div(112).add(.5),T.positionWorld.z.div(-63).add(.5))).rgb.mul(vision).mul(1.8);
  const asphalt=mesh(root,createRoadGeometry(outer,inner),roadMat,0,.008,0);
  asphalt.castShadow=false;
  const barriers=[], whiteCurbs=[], redCurbs=[], lamps=[];
  for(const loop of [outer,inner]) {
    for(let i=0;i<loop.length;i++) {
      const a=loop[i],b=loop[(i+1)%loop.length],dx=b.x-a.x,dy=b.y-a.y;
      const len=Math.hypot(dx,dy), yaw=Math.atan2(dx,dy), count=Math.max(1,Math.ceil(len/25));
      if(len<.1)continue;
      // Barrier centre is exactly on the collision boundary.
      barriers.push({x:worldX((a.x+b.x)/2),y:.32,z:worldZ((a.y+b.y)/2),ry:yaw,sz:len*SCALE});
      const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,nx=-dy/len,ny=dx/len;
      const side=inRoad(mx+nx*12,my+ny*12)?1:-1;
      for(let j=0;j<count;j++){
        const t=(j+.5)/count;
        const v={x:worldX(a.x+dx*t+nx*side*10),y:.04,z:worldZ(a.y+dy*t+ny*side*10),ry:yaw,sz:len/count*SCALE*.97};
        (j%2?whiteCurbs:redCurbs).push(v);
      }
      if(loop===outer && len>80){
        const n=Math.max(1,Math.floor(len/460));
        for(let j=0;j<n;j++){
          const t=(j+.5)/n;
          lamps.push({x:worldX(a.x+dx*t-nx*side*34),z:worldZ(a.y+dy*t-ny*side*34),y:0});
        }
      }
    }
  }
  instances(root,box(.18,.62,1),standard(0xe5dfca),barriers);
  instances(root,box(.5,.08,1),standard(0xe7e3d8),whiteCurbs);
  instances(root,box(.5,.085,1),standard(0xb4563c),redCurbs);
  const trunks=[], foliage=[[],[],[]],rocks=[];
  for(let i=0;i<(quality==='low'?135:310);i++) {
    const x=40+rng()*3120,y=35+rng()*1730;
    if(inRoad(x,y)||Math.min(distanceToLoop(x,y,outer),distanceToLoop(x,y,inner))<48)continue;
    const s=.55+rng()*1.15;
    const pos={x:worldX(x),z:worldZ(y)};
    if(rng()<.21){rocks.push({...pos,y:.35,sx:s*1.3,sy:s*.8,sz:s,ry:rng()*6});continue;}
    trunks.push({...pos,y:s*.9,sx:s,sy:s,sz:s});
    for(let j=0;j<3;j++)foliage[j].push({...pos,y:s*(1.25+j*.65),sx:s*(1-j*.21),sy:s*(1-j*.13),sz:s*(1-j*.21),ry:rng()*6});
  }
  instances(root,new T.CylinderGeometry(.10,.16,1.8,5),standard(0x766553),trunks);
  foliage.forEach((f,i)=>instances(root,themeName==='desert'?new T.IcosahedronGeometry(.72,0):new T.ConeGeometry(1.05,2.1,themeName==='alpine'?7:5),standard(theme.foliage[i]),f));
  instances(root,new T.DodecahedronGeometry(.8,0),standard(theme.rock),rocks);
  // Simple circuit furniture, all placed away from the drivable corridor.
  for(let i=0;i<8;i++) {
    const x=250+rng()*2700,y=200+rng()*1400;
    if(inRoad(x,y)||Math.min(distanceToLoop(x,y,outer),distanceToLoop(x,y,inner))<115)continue;
    const stand=new T.Group(); stand.position.set(worldX(x),0,worldZ(y));root.add(stand);
    mesh(stand,box(4,.35,1.4),standard(0xb2b5ac),0,.25,0);
    mesh(stand,box(4,.3,1),standard(0xd8d4bd),0,.65,.35);
    mesh(stand,box(4,.3,.65),standard(0xb56c50),0,.95,.7);
    mesh(stand,box(4.6,.16,2),standard(0x465953),0,2.4,.25);
    for(const px of [-1.85,1.85])mesh(stand,box(.1,2.4,.1),slab,px,1.2,.85);
  }
  const lampMat=new T.MeshStandardMaterial({color:0xffe3b4,emissive:0xffc87b,emissiveIntensity:.25});
  instances(root,new T.CylinderGeometry(.06,.1,4.2,6),slab,lamps.map(v=>({...v,y:2.1})));
  instances(root,box(.9,.16,.38),lampMat,lamps.map(v=>({...v,y:4.25})));
  const markerMat=new T.MeshStandardMaterial({color:0x94d6c9,emissive:0x68cbb5,emissiveIntensity:.1});
  instances(root,box(.11,.5,.14),markerMat,lamps.map(v=>({...v,y:.28})));
  const nightLights=[];
  for(let i=0;i<Math.min(6,lamps.length);i++){
    const p=lamps[Math.floor(i*lamps.length/Math.min(6,lamps.length))];
    const light=new T.PointLight(0xffcf87,0,22,2);light.position.set(p.x,3.95,p.z);root.add(light);nightLights.push(light);
  }
  const cp=road.checkPointList?.[0];
  if(cp?.length===2){
    const a=cp[0],b=cp[1],len=Math.hypot(b.x-a.x,b.y-a.y)*SCALE;
    const start=new T.Group();start.position.set(worldX((a.x+b.x)/2),.025,worldZ((a.y+b.y)/2));start.rotation.y=Math.atan2(b.x-a.x,b.y-a.y);root.add(start);
    const sq=.42, n=Math.ceil(len/sq), black=standard(0x343a38), white=standard(0xf2efdd);
    for(let j=0;j<n;j++)for(let k=0;k<2;k++)mesh(start,box(sq,.008,Math.min(sq,len/n)),(j+k)%2?black:white,(k-.5)*sq,0,(j+.5)*len/n-len/2);
  }
  const name=labelTexture('LEARNING, IN MOTION.');
  mesh(root,box(21,.035,5.25),new T.MeshStandardMaterial({map:name,roughness:.7}),-43,-.025,32);
  const skirt=mesh(root,new T.PlaneGeometry(1000,1000),standard(theme.sky),0,-3.2,0);skirt.rotation.x=-Math.PI/2;skirt.castShadow=false;
  return {root, theme, roadMat, asphalt, wet, vision, heatCanvas, heatTexture, lampMat,markerMat,nightLights,inner,outer,
    setNight(on){wet.value=+on;lampMat.emissiveIntensity=on?4:.15;markerMat.emissiveIntensity=on?2:.1;nightLights.forEach(l=>l.intensity=on?110:0);},
  };
}

export function createCar(color=0xf1eee0, ghost=false) {
  const root=new T.Group();
  const body=ghost?new T.MeshBasicMaterial({color,transparent:true,opacity:.28,depthWrite:false}):new T.MeshPhysicalMaterial({color,metalness:.18,roughness:.25,clearcoat:1,clearcoatRoughness:.22});
  const carbon=ghost?body:standard(0x263a3c,{roughness:.3,metalness:.45});
  const accent=ghost?body:standard(0xd47d55,{metalness:.22,roughness:.3});
  mesh(root,new T.RoundedBoxGeometry(.86,.32,1.65,2,.09),body,0,.34,0);
  mesh(root,new T.RoundedBoxGeometry(.53,.25,.63,2,.10),carbon,0,.59,.12);
  mesh(root,new T.RoundedBoxGeometry(.34,.045,.68,1,.02),accent,0,.515,-.43);
  mesh(root,box(1.0,.08,.2),carbon,0,.19,-.76);
  mesh(root,box(1.05,.075,.2),body,0,.55,.74);
  for(const x of [-.34,.34])mesh(root,box(.055,.25,.055),carbon,x,.39,.73);
  const wheels=[];
  for(const x of [-.48,.48])for(const z of [-.52,.53]){
    const pivot=new T.Group();pivot.position.set(x,.23,z);root.add(pivot);
    const tire=mesh(pivot,new T.CylinderGeometry(.23,.23,.19,12),ghost?body:standard(0x1a2224),0,0,0);tire.rotation.z=Math.PI/2;
    const hub=mesh(pivot,new T.CylinderGeometry(.13,.13,.20,10),ghost?body:standard(0x87948e,{metalness:.5}),0,0,0);hub.rotation.z=Math.PI/2;
    wheels.push({pivot,tire,hub,front:z<0});
  }
  if(!ghost){
    const light=new T.MeshStandardMaterial({color:0xc2f6e6,emissive:0x7de8cc,emissiveIntensity:2.0});
    for(const x of [-.28,.28])mesh(root,box(.18,.055,.025),light,x,.39,-.837);
    mesh(root,box(.58,.035,.03),new T.MeshStandardMaterial({color:0xd2503d,emissive:0xff3d1a,emissiveIntensity:.8}),0,.40,.827);
  }
  if(ghost)root.traverse(o=>{o.castShadow=false;o.receiveShadow=false;});
  root.userData.wheels=wheels;return root;
}

export function createRain() {
  const geometry=new T.BoxGeometry(.018,.52,.018),n=1100;
  const phases=new Float32Array(n),rng=seededRandom('circuit-rain');
  const mat=new T.MeshBasicNodeMaterial({color:0xb2d8df,transparent:true,opacity:.38,depthWrite:false});
  mat.positionNode=T.positionLocal.add(T.vec3(0,T.fract(T.attribute('rainPhase').sub(T.time.mul(.72))).mul(16),0));
  geometry.setAttribute('rainPhase',new T.InstancedBufferAttribute(phases,1));
  const rain=new T.InstancedMesh(geometry,mat,n),d=new T.Object3D();
  for(let i=0;i<n;i++){phases[i]=rng();d.position.set((rng()-.5)*114,.1,(rng()-.5)*66);d.updateMatrix();rain.setMatrixAt(i,d.matrix);}
  rain.frustumCulled=false;rain.castShadow=false;rain.visible=false;return rain;
}

export function disposeTree(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of [].concat(o.material||[])){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});
  geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
  root.removeFromParent();
}
