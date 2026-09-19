import { DurableObject } from 'cloudflare:workers';
import { cleanCallsign, validState, COLORS } from '../AI-Car-Racer/multiplayer/state.js';

const TTL=15000, MAX_PLAYERS=32;
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if (url.pathname==='/health') return Response.json({ok:true,protocol:1});
    const origin=request.headers.get('Origin')||'';
    const allowed=/^https:\/\/([a-z0-9-]+\.)?vectorvroom\.pages\.dev$/.test(origin)
      || origin==='https://vectorvroom.shaal.dev'
      || origin==='https://vv.shaal.dev'
      || (env.ALLOW_LOCAL==='true' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin));
    if (!allowed) return new Response('Origin not allowed',{status:403});
    const match=url.pathname.match(/^\/room\/([a-f0-9]{64})$/);
    if (!match) return new Response('Unknown track',{status:404});
    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response('WebSocket required',{status:426});
    if (!cleanCallsign(url.searchParams.get('name'))) return new Response('Callsign required',{status:400});
    return env.ROOMS.getByName(match[1]).fetch(request);
  }
};

export class LiveRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.sessions=new Map();
    for(const ws of ctx.getWebSockets()){
      const data=ws.deserializeAttachment();
      if(data)this.sessions.set(ws,data);
    }
  }
  player(s){return {id:s.id,name:s.name,color:s.color,state:s.state};}
  send(ws,data){try{ws.send(JSON.stringify(data));}catch{this.remove(ws);}}
  broadcast(data,except){for(const ws of this.sessions.keys())if(ws!==except)this.send(ws,data);}
  remove(ws){
    const s=this.sessions.get(ws);if(!s)return;
    this.sessions.delete(ws);try{ws.close(1000,'Left track');}catch{}
    this.broadcast({type:'leave',id:s.id});
  }
  prune(){for(const [ws,s] of this.sessions)if(Date.now()-s.seen>TTL)this.remove(ws);}
  async fetch(request){
    this.prune();
    if(this.sessions.size>=MAX_PLAYERS)return new Response('Track full (32 drivers)',{status:503});
    const [client,server]=Object.values(new WebSocketPair());
    const s={id:crypto.randomUUID(),name:cleanCallsign(new URL(request.url).searchParams.get('name')),color:COLORS[this.sessions.size%COLORS.length],state:null,seen:Date.now(),seq:-1,accepted:0};
    this.ctx.acceptWebSocket(server);this.sessions.set(server,s);server.serializeAttachment(s);
    this.send(server,{type:'welcome',id:s.id,color:s.color,players:[...this.sessions.values()].filter(p=>p!==s).map(p=>this.player(p))});
    this.broadcast({type:'driver',...this.player(s)},server);
    if(!(await this.ctx.storage.getAlarm()))await this.ctx.storage.setAlarm(Date.now()+TTL);
    return new Response(null,{status:101,webSocket:client});
  }
  webSocketMessage(ws,message){
    const s=this.sessions.get(ws);if(!s)return;
    if(typeof message!=='string'||message.length>2048){ws.close(1009,'Message too large');this.remove(ws);return;}
    let m;try{m=JSON.parse(message);}catch{ws.close(1008,'Invalid message');this.remove(ws);return;}
    const state=validState(m?.state),name=cleanCallsign(m?.name);
    if(m?.type!=='state'||!state||!name||!Number.isSafeInteger(m.seq)||m.seq<=s.seq){ws.close(1008,'Invalid state');this.remove(ws);return;}
    // At most ~15 accepted updates/sec; normal clients send ten.
    if(Date.now()-s.accepted<65)return;
    Object.assign(s,{state,name,seq:m.seq,seen:Date.now(),accepted:Date.now()});
    ws.serializeAttachment(s);this.broadcast({type:'driver',...this.player(s)},ws);
    this.send(ws,{type:'ack'});
  }
  webSocketClose(ws){this.remove(ws);}
  webSocketError(ws){this.remove(ws);}
  async alarm(){
    this.prune();
    if(this.sessions.size)await this.ctx.storage.setAlarm(Date.now()+TTL);
  }
}
