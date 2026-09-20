import { DurableObject } from 'cloudflare:workers';
import { cleanCallsign, validState, validSetup, COLORS, ACTIVE_TTL, presenceTTL } from '../AI-Car-Racer/multiplayer/state.js';

const TTL=ACTIVE_TTL, MAX_PLAYERS=32;
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if (url.pathname==='/health') return Response.json({ok:true,protocol:2});
    const origin=request.headers.get('Origin')||'';
    const allowed=/^https:\/\/([a-z0-9-]+\.)?vectorvroom\.pages\.dev$/.test(origin)
      || origin==='https://vectorvroom.shaal.dev'
      || origin==='https://vv.shaal.dev'
      || (env.ALLOW_LOCAL==='true' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));
    if (!allowed) return new Response('Origin not allowed',{status:403});
    const match=url.pathname.match(/^\/room\/([a-f0-9]{64})$/);
    const lobby=url.pathname==='/lobby';
    if (!lobby&&!match) return new Response('Unknown track',{status:404});
    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response('WebSocket required',{status:426});
    if (!cleanCallsign(url.searchParams.get('name'))) return new Response('Callsign required',{status:400});
    // Keep legacy rooms alive during rollout. New clients discover everyone
    // in one lobby, then explicitly match track/rules to race together.
    return env.ROOMS.getByName(lobby?'vectorvroom-public-lobby-v2':match[1]).fetch(request);
  }
};

export class LiveRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.sessions=new Map();this.setups=new Map();
    for(const ws of ctx.getWebSockets()){
      const data=ws.deserializeAttachment();
      if(data)this.sessions.set(ws,data);
    }
    // Geometry can exceed the WebSocket attachment limit. Persist it only
    // when it changes; small pose updates stay in hibernation attachments.
    ctx.blockConcurrencyWhile(async()=>{this.setups=await ctx.storage.list({prefix:'setup:'});});
  }
  player(s,withSetup=false){return {id:s.id,name:s.name,color:s.color,state:s.state,...(withSetup&&s.lobby?{setup:this.setups.get('setup:'+s.id)}:{})};}
  send(ws,data){try{ws.send(JSON.stringify(data));}catch{this.remove(ws);}}
  broadcast(data,except){for(const ws of this.sessions.keys())if(ws!==except)this.send(ws,data);}
  remove(ws){
    const s=this.sessions.get(ws);if(!s)return;
    this.sessions.delete(ws);try{ws.close(1000,'Left track');}catch{}
    if(this.setups.delete('setup:'+s.id))this.ctx.waitUntil(this.ctx.storage.delete('setup:'+s.id));
    this.broadcast({type:'leave',id:s.id});
  }
  prune(){for(const [ws,s] of this.sessions)if(Date.now()-s.seen>presenceTTL(s.state))this.remove(ws);}
  async fetch(request){
    this.prune();
    if(this.sessions.size>=MAX_PLAYERS)return new Response('Track full (32 drivers)',{status:503});
    const [client,server]=Object.values(new WebSocketPair());
    const url=new URL(request.url);
    const s={id:crypto.randomUUID(),name:cleanCallsign(url.searchParams.get('name')),lobby:url.pathname==='/lobby',color:COLORS[this.sessions.size%COLORS.length],state:null,seen:Date.now(),seq:-1,accepted:0,setupSent:0};
    this.ctx.acceptWebSocket(server);this.sessions.set(server,s);server.serializeAttachment(s);
    this.send(server,{type:'welcome',id:s.id,color:s.color,players:[...this.sessions.values()].filter(p=>p!==s).map(p=>this.player(p,true))});
    this.broadcast({type:'driver',...this.player(s)},server);
    if(!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(Date.now()+TTL);
    return new Response(null,{status:101,webSocket:client});
  }
  async webSocketMessage(ws,message){
    const s=this.sessions.get(ws);if(!s)return;
    if(typeof message!=='string'||message.length>(s.lobby?65536:2048)){ws.close(1009,'Message too large');this.remove(ws);return;}
    let m;try{m=JSON.parse(message);}catch{ws.close(1008,'Invalid message');this.remove(ws);return;}
    const state=validState(m?.state),name=cleanCallsign(m?.name);
    if(m?.type!=='state'||!state||!name||!Number.isSafeInteger(m.seq)||m.seq<=s.seq){ws.close(1008,'Invalid state');this.remove(ws);return;}
    const setup=m.setup===undefined?this.setups.get('setup:'+s.id):validSetup(m.setup);
    if(s.lobby&&!setup){ws.close(1008,'Valid race setup required');this.remove(ws);return;}
    // At most ~15 accepted updates/sec; normal clients send ten.
    if(Date.now()-s.accepted<65)return;
    Object.assign(s,{state,name,seq:m.seq,seen:Date.now(),accepted:Date.now()});
    if(s.lobby&&m.setup!==undefined){
      this.setups.set('setup:'+s.id,setup);await this.ctx.storage.put('setup:'+s.id,setup);
    }
    const withSetup=s.lobby&&(m.setup!==undefined||Date.now()-s.setupSent>=5000);
    if(withSetup)s.setupSent=Date.now();
    ws.serializeAttachment(s);this.broadcast({type:'driver',...this.player(s,withSetup)},ws);
    this.send(ws,{type:'ack'});
  }
  webSocketClose(ws){this.remove(ws);}
  webSocketError(ws){this.remove(ws);}
  async alarm(){
    this.prune();
    if(this.sessions.size)await this.ctx.storage.setAlarm(Date.now()+TTL);
  }
}
