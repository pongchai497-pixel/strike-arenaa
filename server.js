const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, 'public');
const server = http.createServer((req,res)=>{
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if(urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath.replace(/^\/+/, ''));
  if(!filePath.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found');}
    const ext=path.extname(filePath);
    const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'}[ext]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-cache'});res.end(data);
  });
});
const wss = new WebSocket.Server({server});
const rooms = new Map();
const rand=(min,max)=>min+Math.random()*(max-min);
const makeRoomCode=()=>Math.random().toString(36).slice(2,6).toUpperCase();
function createRoom(code){const room={code,players:new Map(),zombies:new Map(),loot:new Map(),barricades:new Map(),wave:1,kills:0,nextId:1,spawnAt:Date.now()+1500,lastState:0};rooms.set(code,room);for(let i=0;i<6;i++)spawnZombie(room);for(let i=0;i<12;i++)spawnLoot(room);return room}
function id(room,prefix){return prefix+(room.nextId++).toString(36)}
function spawnZombie(r){const edge=Math.floor(Math.random()*4);let x,z;if(edge===0){x=rand(-25,25);z=-37}else if(edge===1){x=rand(-25,25);z=37}else if(edge===2){x=-28;z=rand(-34,34)}else{x=28;z=rand(-34,34)}const zid=id(r,'z');r.zombies.set(zid,{id:zid,x,z,hp:2+Math.floor(r.wave/3),speed:1.15+Math.min(r.wave*.06,1.5),attack:0,angle:0})}
function spawnLoot(r,x=rand(-22,22),z=rand(-35,35),kind=Math.random()<.72?'scrap':'ammo'){const lid=id(r,'l');r.loot.set(lid,{id:lid,x,z,kind})}
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function broadcast(r,obj){const data=JSON.stringify(obj);for(const p of r.players.values())if(p.ws.readyState===WebSocket.OPEN)p.ws.send(data)}
function publicState(r){return {type:'state',wave:r.wave,kills:r.kills,players:[...r.players.values()].map(({ws,...p})=>p).reduce((o,p)=>(o[p.id]=p,o),{}),zombies:[...r.zombies.values()],loot:[...r.loot.values()],barricades:[...r.barricades.values()]}}
function nearestLoot(r,p){let best=null,dmin=2.8;for(const l of r.loot.values()){const d=Math.hypot(l.x-p.x,l.z-p.z);if(d<dmin){dmin=d;best=l}}return best}
function handle(ws,m){let p=ws.player;if(m.type==='join'){
 let code=(m.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);if(!code){code=makeRoomCode();while(rooms.has(code))code=makeRoomCode()}
 let r=rooms.get(code)||createRoom(code);if(r.players.size>=8){send(ws,{type:'error',message:'ห้องเต็มแล้ว (สูงสุด 8 คน)'});return}
 p={id:crypto.randomUUID(),name:String(m.name||'Survivor').slice(0,18),x:rand(-2,2),z:6,hp:100,scrap:0,kills:0,weapon:1,ammo:{1:30,2:8,3:40},reserve:{1:90,2:32,3:120},inventory:{ammo:90,med:0},angle:0,color:[0x55baf0,0xffbf59,0x9ee36b,0xe18cf0,0xf17c70][r.players.size%5],accent:0x263d48,ws,room:r};ws.player=p;ws.room=r;r.players.set(p.id,p);send(ws,{type:'welcome',id:p.id,room:r.code});broadcast(r,{type:'notice',text:p.name+' เข้าร่วมทีมแล้ว'});return
 }
 if(!p||!p.room)return;const r=p.room;
 if(m.type==='input'){const x=Number(m.x)||0,z=Number(m.z)||0,len=Math.hypot(x,z)||1;p.x=Math.max(-30,Math.min(30,p.x+x/len*5*.05));p.z=Math.max(-55,Math.min(55,p.z+z/len*5*.05));if(x||z)p.angle=Math.atan2(-x,-z);p.aimX=Number(m.aimX)||0;p.aimZ=Number(m.aimZ)||-1}
 else if(m.type==='shoot'){
  const weapon=Number(m.weapon)||1,stats={1:{damage:1,mag:30},2:{damage:2,mag:8},3:{damage:1,mag:40}}[weapon]||{damage:1,mag:30};
  if(!p.ammo[weapon])return;p.ammo[weapon]--;p.weapon=weapon;
  let ax=Number(m.aimX)||0,az=Number(m.aimZ)||-1,l=Math.hypot(ax,az)||1;ax/=l;az/=l;p.angle=Math.atan2(-ax,-az);
  let candidates=[...r.zombies.values()].map(z=>({z,proj:(z.x-p.x)*ax+(z.z-p.z)*az,perp:Math.abs((z.x-p.x)*az-(z.z-p.z)*ax)})).filter(a=>a.proj>0&&a.proj<28&&a.perp<1.3).sort((a,b)=>a.proj-b.proj);
  let hits=weapon===2?candidates.slice(0,3):candidates.slice(0,1);
  for(const h of hits){h.z.hp-=stats.damage;if(h.z.hp<=0){r.zombies.delete(h.z.id);p.kills++;r.kills++;p.scrap+=1;if(Math.random()<.72)spawnLoot(r,h.z.x,h.z.z,Math.random()<.78?'scrap':'ammo');if(r.kills%8===0){r.wave++;broadcast(r,{type:'notice',text:'Wave '+r.wave+' กำลังมา!'});}}}
 }else if(m.type==='interact'){
  const l=nearestLoot(r,p);if(!l){send(ws,{type:'notice',text:'เดินเข้าใกล้ไอเทมก่อน'});return}
  r.loot.delete(l.id);if(l.kind==='scrap'){p.scrap+=3;send(ws,{type:'notice',text:'+3 เศษเหล็ก'})}else{for(const w of [1,2,3])p.reserve[w]+=10;send(ws,{type:'notice',text:'เก็บกระสุน +10 ต่อปืน'})}
 }else if(m.type==='reload'){const w=Number(m.weapon)||p.weapon,mag={1:30,2:8,3:40}[w]||30,need=mag-p.ammo[w],take=Math.min(need,p.reserve[w]);p.ammo[w]+=take;p.reserve[w]-=take}
 else if(m.type==='weapon'){if([1,2,3].includes(Number(m.weapon)))p.weapon=Number(m.weapon)}
 else if(m.type==='craft'){
  if(m.item==='ammo'&&p.scrap>=5){p.scrap-=5;p.reserve[p.weapon]+=20;send(ws,{type:'notice',text:'สร้างกระสุน +20'})}
  else if(m.item==='med'&&p.scrap>=8){p.scrap-=8;p.hp=Math.min(100,p.hp+35);send(ws,{type:'notice',text:'ใช้ชุดยา ฟื้นฟู 35 HP'})}
  else if(m.item==='barricade'&&p.scrap>=10){p.scrap-=10;const bid=id(r,'b');r.barricades.set(bid,{id:bid,x:p.x+2,z:p.z-1,hp:100});send(ws,{type:'notice',text:'สร้างเครื่องกีดขวางแล้ว'})}
  else send(ws,{type:'notice',text:'เศษเหล็กไม่พอ หรือไอเทมไม่ถูกต้อง'})
 }
}
wss.on('connection',ws=>{
 ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m&&typeof m.type==='string')handle(ws,m)}catch(e){send(ws,{type:'error',message:'ข้อมูลที่ส่งไม่ถูกต้อง'})}});
 ws.on('close',()=>{const p=ws.player;if(!p||!p.room)return;const r=p.room;r.players.delete(p.id);broadcast(r,{type:'notice',text:p.name+' ออกจากห้องแล้ว'});if(!r.players.size){rooms.delete(r.code)}});
});
setInterval(()=>{
 const now=Date.now();
 for(const r of rooms.values()){
  // server-authoritative zombie movement and melee
  for(const z of r.zombies.values()){
   let target=null,dist=Infinity;for(const p of r.players.values()){if(p.hp<=0)continue;const d=Math.hypot(p.x-z.x,p.z-z.z);if(d<dist){dist=d;target=p}}
   if(target){if(dist>1.25){const dx=target.x-z.x,dz=target.z-z.z,l=Math.hypot(dx,dz)||1;z.x+=dx/l*z.speed*.05;z.z+=dz/l*z.speed*.05;z.angle=Math.atan2(-dx,-dz)}else{z.attack-=.05;if(z.attack<=0){target.hp=Math.max(0,target.hp-8-r.wave*.25);z.attack=.85}}}
  }
  const alive=[...r.zombies.values()].length;if(now>=r.spawnAt&&alive<Math.min(5+r.wave*2,24)){spawnZombie(r);r.spawnAt=now+Math.max(600,1900-r.wave*70)}
  if(r.loot.size<18&&Math.random()<.025)spawnLoot(r);
  if(now-r.lastState>50){broadcast(r,publicState(r));r.lastState=now}
 }
},50);
server.listen(PORT,'0.0.0.0',()=>console.log(`Wasteland Co-op running on http://localhost:${PORT}`));
