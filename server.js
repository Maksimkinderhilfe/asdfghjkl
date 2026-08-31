const express=require('express');
const path=require('path');
const crypto=require('crypto');
const fs=require('fs');

const app=express();
const PORT=Number.parseInt(process.env.PORT,10)||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'';
const SPOTIFY_CLIENT_ID=process.env.SPOTIFY_CLIENT_ID||'';
const SPOTIFY_CLIENT_SECRET=process.env.SPOTIFY_CLIENT_SECRET||'';
const SPOTIFY_REDIRECT_URI=process.env.SPOTIFY_REDIRECT_URI||'';
const SCOPES='streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')));

const DB=path.join(__dirname,'wishes.json');
const BANS=path.join(__dirname,'banned.json');
const QUEUE=path.join(__dirname,'queue.json');
const STATE=path.join(__dirname,'live.json');
const FEEDBACK=path.join(__dirname,'feedback.json');
const HISTORY=path.join(__dirname,'played.json');
const BREEZE_MEMORY_FILE=path.join(__dirname,'breeze-memory.json');

let live=fs.existsSync(STATE)?JSON.parse(fs.readFileSync(STATE,'utf8')):{nowPlaying:null,announcement:'',announcementAt:0,birthday:null};
let feedback=fs.existsSync(FEEDBACK)?JSON.parse(fs.readFileSync(FEEDBACK,'utf8')):[];
let wishes=fs.existsSync(DB)?JSON.parse(fs.readFileSync(DB,'utf8')):[];
let banned=fs.existsSync(BANS)?JSON.parse(fs.readFileSync(BANS,'utf8')):[];
let queue=fs.existsSync(QUEUE)?JSON.parse(fs.readFileSync(QUEUE,'utf8')):[];
let playedHistory=fs.existsSync(HISTORY)?JSON.parse(fs.readFileSync(HISTORY,'utf8')):[];
let breezeMemory=fs.existsSync(BREEZE_MEMORY_FILE)?JSON.parse(fs.readFileSync(BREEZE_MEMORY_FILE,'utf8')):{version:1,mode:'smooth',energy:55,plays:0,topArtists:{},topTitles:{},recentArtists:[],recentGenres:[],accepted:0,rejected:0,birthdayCount:0,lastReason:'',lastDecisionAt:0};

function write(file,data){fs.writeFileSync(file,JSON.stringify(data,null,2));}
const saveLive=()=>write(STATE,live), saveFeedback=()=>write(FEEDBACK,feedback), save=()=>write(DB,wishes), saveBans=()=>write(BANS,banned), saveQueue=()=>write(QUEUE,queue), saveHistory=()=>write(HISTORY,playedHistory), saveBreezeMemory=()=>write(BREEZE_MEMORY_FILE,breezeMemory);
const norm=v=>String(v||'').trim().toLowerCase().replace(/\s+/g,' ');
const isBanned=(title,artist)=>banned.some(b=>b.titleKey===norm(title)&&(b.artistKey?b.artistKey===norm(artist):true));

// Admin sessions are intentionally short-lived and in memory.
// Spotify OAuth uses a signed, stateless state token so a Render restart during
// the Spotify redirect does not invalidate the login flow.
const sessions=new Set();
const spotifySessions=new Map(); // adminToken -> {accessToken,refreshToken,expiresAt}
const revokedTokens=new Set();
let clientToken={accessToken:'',expiresAt:0};
const OAUTH_STATE_TTL_MS=10*60*1000;
function oauthSecret(){
  return process.env.OAUTH_STATE_SECRET || ADMIN_PASSWORD || 'breeze-oauth-secret';
}
function signOAuthState(adminToken){
  const payload=Buffer.from(JSON.stringify({adminToken,iat:Date.now()})).toString('base64url');
  const sig=crypto.createHmac('sha256',oauthSecret()).update(payload).digest('base64url');
  return payload+'.'+sig;
}
function verifyOAuthState(state){
  try{
    const [payload,sig]=String(state||'').split('.');
    if(!payload||!sig) return null;
    const expected=crypto.createHmac('sha256',oauthSecret()).update(payload).digest('base64url');
    if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return null;
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!data.adminToken||!data.iat||Date.now()-Number(data.iat)>OAUTH_STATE_TTL_MS||!verifyAdminToken(data.adminToken)) return null;
    return data;
  }catch{return null;}
}
const loginAttempts=new Map();
const LOGIN_WINDOW_MS=10*60*1000;
const LOGIN_MAX_ATTEMPTS=8;
function clientIp(req){return (req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();}
function loginBlocked(ip){const now=Date.now();const a=loginAttempts.get(ip)||[];const fresh=a.filter(t=>t>now-LOGIN_WINDOW_MS);loginAttempts.set(ip,fresh);return fresh.length>=LOGIN_MAX_ATTEMPTS;}
function recordLoginFailure(ip){const now=Date.now();const a=loginAttempts.get(ip)||[];a.push(now);loginAttempts.set(ip,a.filter(t=>t>now-LOGIN_WINDOW_MS));}

function cookieValue(req,name){
  const raw=req.headers.cookie||'';
  const part=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  try{return part ? decodeURIComponent(part.slice(name.length+1)) : '';}catch{return '';}
}
function signAdminToken(){
  const payload=Buffer.from(JSON.stringify({id:crypto.randomBytes(24).toString('hex'),iat:Date.now()})).toString('base64url');
  const sig=crypto.createHmac('sha256',oauthSecret()).update(payload).digest('base64url');
  return payload+'.'+sig;
}
function verifyAdminToken(token){
  try{
    const [payload,sig]=String(token||'').split('.'); if(!payload||!sig||revokedTokens.has(token)) return false;
    const expected=crypto.createHmac('sha256',oauthSecret()).update(payload).digest('base64url');
    if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return false;
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    return data?.iat && Date.now()-Number(data.iat)<30*24*60*60*1000;
  }catch{return false;}
}
function cookieSet(name,value,maxAge){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;}
function encryptSecret(value){
  const key=crypto.createHash('sha256').update(oauthSecret()).digest();
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]); const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,ciphertext]).toString('base64url');
}
function decryptSecret(value){
  try{const raw=Buffer.from(String(value||''),'base64url'); if(raw.length<28)return null; const key=crypto.createHash('sha256').update(oauthSecret()).digest(); const iv=raw.subarray(0,12),tag=raw.subarray(12,28),ciphertext=raw.subarray(28); const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');}catch{return null;}
}
function auth(req,res,next){
  const headerToken=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const t=headerToken || cookieValue(req,'breeze_admin');
  if(!(sessions.has(t)||verifyAdminToken(t))) return res.status(401).json({error:'Nicht angemeldet'});
  sessions.add(t); req.adminToken=t; next();
}
function spotifyConfigured(){return Boolean(SPOTIFY_CLIENT_ID&&SPOTIFY_CLIENT_SECRET&&SPOTIFY_REDIRECT_URI);}
function basicAuth(){return 'Basic '+Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');}

async function tokenRequest(body){
  const r=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:basicAuth(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error_description||d.error||'Spotify Token-Fehler');
  return d;
}
async function getUserSpotifyToken(adminToken){
  const s=spotifySessions.get(adminToken);
  if(!s?.refreshToken) return null;
  if(s.accessToken && Date.now()<s.expiresAt-60000) return s.accessToken;
  const d=await tokenRequest({grant_type:'refresh_token',refresh_token:s.refreshToken});
  s.accessToken=d.access_token;
  s.expiresAt=Date.now()+(Number(d.expires_in||3600)*1000);
  if(d.refresh_token) s.refreshToken=d.refresh_token;
  return s.accessToken;
}
async function getClientToken(){
  if(clientToken.accessToken && Date.now()<clientToken.expiresAt-60000) return clientToken.accessToken;
  const d=await tokenRequest({grant_type:'client_credentials'});
  clientToken={accessToken:d.access_token,expiresAt:Date.now()+(Number(d.expires_in||3600)*1000)};
  return clientToken.accessToken;
}
async function spotifyFetch(url,token,options={}){
  const r=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(options.headers||{})}});
  const text=await r.text();
  let d={}; try{d=text?JSON.parse(text):{}}catch{d={raw:text}};
  return {r,d};
}


function estimateEnergy(track){
  if(!track) return 55;
  const text=`${track.title||''} ${track.artist||''}`.toLowerCase();
  const high=['party','dance','club','edm','house','techno','remix','hype','fire','energy','summer','festival','hard','boom','levels','animals'];
  const low=['acoustic','ballad','piano','slow','sad','chill','ambient','sleep','calm','unplugged'];
  let e=55;
  high.forEach(w=>{if(text.includes(w))e+=6}); low.forEach(w=>{if(text.includes(w))e-=6});
  if(track.popularity!=null)e += Math.round((Number(track.popularity)-50)*0.08);
  return Math.max(10,Math.min(100,e));
}
function rememberDecision(track,extra={}){
  if(!track)return;
  const artist=String(track.artist||'').split(',')[0].trim()||'Unknown';
  const title=String(track.title||'').trim()||'Unknown';
  const e=Number(extra.energyScore)||estimateEnergy(track);
  breezeMemory.energy=Math.round((Number(breezeMemory.energy||55)*0.72)+(e*0.28));
  breezeMemory.plays=Number(breezeMemory.plays||0)+1;
  breezeMemory.topArtists[artist]=(breezeMemory.topArtists[artist]||0)+1;
  breezeMemory.topTitles[title]=(breezeMemory.topTitles[title]||0)+1;
  breezeMemory.recentArtists=[artist,...(breezeMemory.recentArtists||[]).filter(a=>a!==artist)].slice(0,8);
  if(track.birthday)breezeMemory.birthdayCount=Number(breezeMemory.birthdayCount||0)+1;
  breezeMemory.lastReason=String(extra.reason||breezeMemory.lastReason||'').slice(0,300);
  breezeMemory.lastDecisionAt=Date.now();
  if(extra.mode)breezeMemory.mode=extra.mode;
  saveBreezeMemory();
}
function breezeMemorySnapshot(){
  const topArtists=Object.entries(breezeMemory.topArtists||{}).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const topTitles=Object.entries(breezeMemory.topTitles||{}).sort((a,b)=>b[1]-a[1]).slice(0,6);
  return {...breezeMemory,topArtists,topTitles};
}

app.get('/api/health',(req,res)=>res.json({ok:true,spotifyConfigured:spotifyConfigured()}));
app.get('/api/config',(req,res)=>res.json({spotifyConfigured:spotifyConfigured(),clientId:SPOTIFY_CLIENT_ID||null}));

app.post('/api/admin/login',(req,res)=>{
  if(!ADMIN_PASSWORD) return res.status(503).json({error:'ADMIN_PASSWORD ist auf dem Server nicht gesetzt.'});
  const ip=clientIp(req);
  if(loginBlocked(ip)) return res.status(429).json({error:'Zu viele Loginversuche. Bitte 10 Minuten warten.'});
  if(req.body.password!==ADMIN_PASSWORD){recordLoginFailure(ip);return res.status(401).json({error:'Falsches Passwort'});}
  loginAttempts.delete(ip);
  const token=signAdminToken(); sessions.add(token); res.setHeader('Set-Cookie',cookieSet('breeze_admin',token,30*24*60*60)); res.json({token});
});
app.post('/api/admin/logout',auth,(req,res)=>{sessions.delete(req.adminToken);spotifySessions.delete(req.adminToken);res.setHeader('Set-Cookie',[cookieSet('breeze_admin','',0),cookieSet('breeze_spotify','',0)]);res.json({ok:true})});

// Spotify OAuth: signed state survives a Render restart during the redirect.
function spotifyAuthorizeUrl(adminToken){
  const state=signOAuthState(adminToken);
  const u=new URL('https://accounts.spotify.com/authorize');
  u.searchParams.set('response_type','code');
  u.searchParams.set('client_id',SPOTIFY_CLIENT_ID);
  u.searchParams.set('scope',SCOPES);
  u.searchParams.set('redirect_uri',SPOTIFY_REDIRECT_URI);
  u.searchParams.set('state',state);
  return u.toString();
}
app.post('/auth/spotify/login',auth,(req,res)=>{
  if(!spotifyConfigured()) return res.status(503).json({error:'Spotify ist auf Render noch nicht eingerichtet.'});
  res.json({url:spotifyAuthorizeUrl(req.adminToken)});
});
app.get('/auth/spotify/login',auth,(req,res)=>{
  if(!spotifyConfigured()) return res.status(503).send('Spotify ist auf Render noch nicht eingerichtet.');
  res.redirect(spotifyAuthorizeUrl(req.adminToken));
});
const spotifyCallback=async(req,res)=>{
  const {code,state,error,error_description}=req.query;
  const stateData=verifyOAuthState(state);
  if(!stateData?.adminToken) {
    return res.status(400).send('Spotify-Anmeldung ist abgelaufen oder ungültig. Bitte im Control Room erneut verbinden.');
  }
  const adminToken=stateData.adminToken;
  sessions.add(adminToken);
  if(error) return res.redirect('/?spotify_error='+encodeURIComponent(error_description||error));
  try{
    const d=await tokenRequest({grant_type:'authorization_code',code,redirect_uri:SPOTIFY_REDIRECT_URI});
    spotifySessions.set(adminToken,{accessToken:d.access_token,refreshToken:d.refresh_token,expiresAt:Date.now()+Number(d.expires_in||3600)*1000});
    res.setHeader('Set-Cookie',[cookieSet('breeze_admin',adminToken,30*24*60*60),cookieSet('breeze_spotify',encryptSecret(d.refresh_token),30*24*60*60)]);
    res.redirect('/?spotify=connected&spotify_recovered=1');
  }catch(e){res.redirect('/?spotify_error='+encodeURIComponent(e.message));}
};
app.get('/auth/spotify/callback',spotifyCallback);
app.get('/auth/callback',spotifyCallback);
app.get('/callback',spotifyCallback);

// Exchange a successful OAuth recovery cookie for the normal bearer token used by the app.
app.post('/api/admin/session/recover',(req,res)=>{
  const t=cookieValue(req,'breeze_admin');
  if(!t||!verifyAdminToken(t)) return res.status(401).json({error:'Keine wiederherstellbare Sitzung'});
  sessions.add(t);
  res.setHeader('Set-Cookie',cookieSet('breeze_admin',t,30*24*60*60));
  res.json({token:t});
});
app.get('/api/admin/spotify/status',auth,async(req,res)=>{
  let s=spotifySessions.get(req.adminToken);
  if(!s?.refreshToken){ const refreshToken=decryptSecret(cookieValue(req,'breeze_spotify')); if(refreshToken){s={accessToken:'',refreshToken,expiresAt:0};spotifySessions.set(req.adminToken,s);} }
  if(!s?.refreshToken) return res.json({connected:false,configured:spotifyConfigured()});
  try{
    const before=s.refreshToken;
    const token=await getUserSpotifyToken(req.adminToken);
    if(s.refreshToken!==before)res.setHeader('Set-Cookie',cookieSet('breeze_spotify',encryptSecret(s.refreshToken),30*24*60*60));
    const {r,d}=await spotifyFetch('https://api.spotify.com/v1/me',token);
    res.json({connected:r.ok,configured:spotifyConfigured(),product:d.product||null,displayName:d.display_name||null});
  }catch(e){res.json({connected:false,configured:spotifyConfigured(),error:e.message});}
});
app.get('/api/admin/spotify/token',auth,async(req,res)=>{
  try{
    let s=spotifySessions.get(req.adminToken);
    if(!s?.refreshToken){const refreshToken=decryptSecret(cookieValue(req,'breeze_spotify')); if(refreshToken){s={accessToken:'',refreshToken,expiresAt:0};spotifySessions.set(req.adminToken,s);}}
    if(!s?.refreshToken)return res.status(401).json({error:'Spotify ist nicht verbunden'});
    const before=s.refreshToken;
    const token=await getUserSpotifyToken(req.adminToken);
    if(s.refreshToken!==before)res.setHeader('Set-Cookie',cookieSet('breeze_spotify',encryptSecret(s.refreshToken),30*24*60*60));
    res.json({access_token:token});
  }catch(e){res.status(401).json({error:e.message});}
});
app.post('/api/admin/spotify/play',auth,async(req,res)=>{
  try{
    const token=await getUserSpotifyToken(req.adminToken); if(!token)return res.status(401).json({error:'Spotify ist nicht verbunden'});
    const {spotifyId,deviceId}=req.body; if(!spotifyId||!deviceId)return res.status(400).json({error:'spotifyId und deviceId fehlen'});
    // Transfer zuerst ohne Wiedergabe; danach mit kurzer Retry-Logik starten, weil der Browser-
    // Player nach dem Transfer einen Moment brauchen kann, bis er als aktives Gerät bereitsteht.
    const tr=await spotifyFetch('https://api.spotify.com/v1/me/player',token,{method:'PUT',body:JSON.stringify({device_ids:[deviceId],play:false})});
    if(!tr.r.ok && tr.r.status!==204)return res.status(tr.r.status).json({error:tr.d.error?.message||'Spotify-Gerät konnte nicht aktiviert werden'});
    let lastError='Spotify konnte den Song nicht starten';
    for(let attempt=0;attempt<4;attempt++){
      if(attempt) await new Promise(r=>setTimeout(r,250*attempt));
      const p=await spotifyFetch('https://api.spotify.com/v1/me/player/play',token,{method:'PUT',body:JSON.stringify({device_id:deviceId,uris:[`spotify:track:${spotifyId}`],position_ms:0})});
      if(p.r.ok) return res.json({ok:true,attempt:attempt+1});
      lastError=p.d.error?.message||lastError;
      if(![404,409,502,503].includes(p.r.status)) return res.status(p.r.status).json({error:lastError});
    }
    res.status(503).json({error:lastError+' – Browser-Player war noch nicht bereit.'});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/spotify/pause',auth,async(req,res)=>{
  try{const token=await getUserSpotifyToken(req.adminToken);if(!token)return res.status(401).json({error:'Spotify ist nicht verbunden'});const p=await spotifyFetch('https://api.spotify.com/v1/me/player/pause',token,{method:'PUT'});if(!p.r.ok&&p.r.status!==204)return res.status(p.r.status).json({error:p.d.error?.message||'Pause fehlgeschlagen'});res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/search',async(req,res)=>{
  if(!spotifyConfigured()) return res.status(503).json({error:'Spotify ist noch nicht eingerichtet. Setze SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET und SPOTIFY_REDIRECT_URI auf Render.'});
  const q=String(req.query.q||`${req.query.title||''} ${req.query.artist||''}`).trim(); if(!q)return res.json({tracks:[]});
  try{
    let token=null;
    // Public visitors use client-credentials search; if the DJ is connected, the same endpoint can still search.
    token=await getClientToken();
    const {r,d}=await spotifyFetch(`https://api.spotify.com/v1/search?type=track&limit=8&market=DE&q=${encodeURIComponent(q)}`,token);
    if(!r.ok)return res.status(r.status).json({error:d.error?.message||'Spotify-Suche fehlgeschlagen'});
    res.json({tracks:(d.tracks?.items||[]).map(t=>({id:t.id,title:t.name,artist:t.artists.map(a=>a.name).join(', '),album:t.album.name,image:t.album.images?.[0]?.url||'',uri:t.uri,popularity:t.popularity||0,releaseDate:t.album?.release_date||null,durationMs:t.duration_ms||0}))});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/wishes',(req,res)=>res.json({queue:queue.filter(w=>['pending','accepted'].includes(w.status)),recent:playedHistory.slice(0,10)}));
app.post('/api/wishes/:id/vote', (req,res)=>{
  const w=queue.find(x=>x.id===req.params.id); if(!w||!['pending','accepted'].includes(w.status))return res.status(404).json({error:'Wunsch nicht gefunden.'});
  let voter=cookieValue(req,'breeze_voter'); if(!voter){voter=crypto.randomBytes(18).toString('hex');res.setHeader('Set-Cookie',cookieSet('breeze_voter',voter,180*24*60*60));}
  const value=Number(req.body?.value); if(![1,-1,0].includes(value))return res.status(400).json({error:'Ungültige Bewertung.'});
  if(!w.voterVotes)w.voterVotes={}; const previous=Number(w.voterVotes[voter]||0);
  if(value===previous)return res.json({ok:true,votes:Number(w.votes||0),myVote:previous});
  w.voterVotes[voter]=value;
  w.votes=Math.max(0,Math.min(99,Number(w.votes||0)+(value-previous)));
  saveQueue(); save(); res.json({ok:true,votes:w.votes,myVote:value});
});
app.post('/api/wishes',(req,res)=>{
  const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();
  const now=Date.now();
  const recent=wishes.filter(w=>w.ip===ip&&w.createdAt>now-86400000&&w.status==='pending');
  if(recent.length>=3)return res.status(429).json({error:'Du hast bereits 3 offene Wünsche. Warte, bis einer erledigt wurde.'});
  const {title,artist,spotifyId,sourceUrl,album,image,popularity,releaseDate,durationMs}=req.body;
  if(!title||!artist)return res.status(400).json({error:'Songtitel und Interpret erforderlich.'});
  const birthdayAudio=sourceUrl==='/birthday.mp3';
  if(!spotifyId&&!birthdayAudio)return res.status(400).json({error:'Bitte einen Spotify-Song auswählen.'});
  if(isBanned(title,artist))return res.status(403).json({error:'Dieser Song wurde vom DJ gesperrt.'});
  const duplicate=queue.find(w=>norm(w.title)===norm(title)&&norm(w.artist)===norm(artist)&&w.status==='pending'&&!w.birthday);
  if(duplicate){return res.json(duplicate)}
  const w={id:crypto.randomUUID(),title:String(title).slice(0,120),artist:String(artist).slice(0,120),spotifyId:spotifyId?String(spotifyId).slice(0,100):null,sourceUrl:birthdayAudio?'/birthday.mp3':null,ip,createdAt:now,status:birthdayAudio?'accepted':'pending',votes:0,birthday:birthdayAudio,album:album?String(album).slice(0,180):null,image:image?String(image).slice(0,1000):null,popularity:Number(popularity||0),releaseDate:releaseDate?String(releaseDate).slice(0,30):null,durationMs:Number(durationMs||0)};
  wishes.push(w);if(birthdayAudio) queue.unshift(w); else queue.push(w);save();saveQueue();res.status(201).json(w);
});

app.get('/api/admin/queue',auth,(req,res)=>{const played=wishes.filter(x=>x.status==='done').length;const rejected=wishes.filter(x=>x.status==='rejected').length;const total=wishes.length;const top=[...wishes].sort((a,b)=>(b.votes||0)-(a.votes||0)).slice(0,5);res.json({queue,banned,live,recent:playedHistory.slice(0,20),memory:breezeMemorySnapshot(),stats:{total,played,rejected,pending:queue.filter(x=>['pending','accepted'].includes(x.status)).length,top}})});
app.patch('/api/admin/queue/:id',auth,(req,res)=>{const i=queue.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Nicht gefunden'});const {action,sourceUrl}=req.body;if(action==='moveUp'&&i>0){[queue[i-1],queue[i]]=[queue[i],queue[i-1]]}else if(action==='moveDown'&&i<queue.length-1){[queue[i+1],queue[i]]=[queue[i],queue[i+1]]}else if(action==='source'){queue[i].sourceUrl=String(sourceUrl||'').slice(0,1000)}else if(action==='favorite'){queue[i].favorite=!queue[i].favorite}else if(['accepted','rejected','done','remove'].includes(action)){queue[i].status=action;if(action==='done'){playedHistory.unshift({...queue[i],playedAt:Date.now()});playedHistory=playedHistory.slice(0,30);saveHistory();rememberDecision(queue[i],{mode:breezeMemory.mode,reason:'Song gespielt und in die Event-Memory übernommen.'})}}else return res.status(400).json({error:'Ungültige Aktion'});const orig=wishes.find(x=>x.id===queue[i].id);if(orig)orig.status=queue[i].status;save();saveQueue();res.json(queue[i])});
app.post('/api/admin/ban',auth,(req,res)=>{const title=String(req.body.title||'').trim(),artist=String(req.body.artist||'').trim();if(!title)return res.status(400).json({error:'Songtitel fehlt'});const b={id:crypto.randomUUID(),title,artist,titleKey:norm(title),artistKey:norm(artist)};if(!banned.some(x=>x.titleKey===b.titleKey&&x.artistKey===b.artistKey)){banned.push(b);saveBans()}queue.forEach(x=>{if(isBanned(x.title,x.artist)&&x.status==='pending')x.status='rejected'});saveQueue();res.json({ok:true,banned})});
app.delete('/api/admin/ban/:id',auth,(req,res)=>{banned=banned.filter(x=>x.id!==req.params.id);saveBans();res.json({ok:true,banned})});
app.post('/api/admin/birthday',auth,(req,res)=>{const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({error:'Name fehlt'});const b={id:crypto.randomUUID(),title:`Happy Birthday ${name}`,artist:'Birthday Room',sourceUrl:'/birthday.mp3',createdAt:Date.now(),status:'accepted',votes:0,birthday:true};queue.unshift(b);saveQueue();res.json(b)});


app.get('/api/admin/stats',auth,(req,res)=>{const total=wishes.length,played=wishes.filter(x=>x.status==='done').length,rejected=wishes.filter(x=>x.status==='rejected').length,pending=queue.filter(x=>['pending','accepted'].includes(x.status)).length;const top=[...wishes].sort((a,b)=>(b.votes||0)-(a.votes||0)).slice(0,5).map(x=>({title:x.title,artist:x.artist,votes:x.votes||0}));res.json({total,played,rejected,pending,top,recent:playedHistory.slice(0,10)});});
app.get('/api/live',(req,res)=>res.json(live));
app.get('/api/announcements',(req,res)=>res.json(live.announcement?{text:live.announcement,at:live.announcementAt}:null));
app.post('/api/feedback',(req,res)=>{const type=String(req.body.type||'Feedback').slice(0,30),message=String(req.body.message||'').trim().slice(0,800);if(!message)return res.status(400).json({error:'Bitte schreib eine Nachricht.'});feedback.unshift({id:crypto.randomUUID(),type,message,createdAt:Date.now(),status:'new'});saveFeedback();res.status(201).json({ok:true})});
app.get('/api/admin/feedback',auth,(req,res)=>res.json(feedback));
app.patch('/api/admin/live',auth,(req,res)=>{const {nowPlaying,announcement,birthday}=req.body;if(nowPlaying!==undefined)live.nowPlaying=nowPlaying;if(announcement!==undefined){live.announcement=String(announcement).slice(0,300);live.announcementAt=Date.now()}if(birthday!==undefined)live.birthday=birthday&&birthday.active?{active:true,name:String(birthday.name||'').slice(0,80),age:birthday.age?String(birthday.age).slice(0,3):null,at:Date.now()}:null;saveLive();res.json(live)});
app.patch('/api/admin/feedback/:id',auth,(req,res)=>{const f=feedback.find(x=>x.id===req.params.id);if(!f)return res.status(404).json({error:'Nicht gefunden'});f.status=req.body.status||'read';saveFeedback();res.json({ok:true})});

app.listen(PORT,'0.0.0.0',()=>console.log(`Herner Eisdisco Wunschbox läuft auf 0.0.0.0:${PORT}`));
