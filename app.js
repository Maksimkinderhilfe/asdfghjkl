let adminToken=localStorage.getItem('djToken')||'';
const spotifyRecoveryParam=new URLSearchParams(location.search).get('spotify_recovered');
if(spotifyRecoveryParam) recoverAdminSession().finally(()=>history.replaceState({},document.title,location.pathname));
let controlQueue=[];
let controlHistory=[];
let spotifyPlayer=null;
let spotifyDeviceId=null;
let spotifySdkPromise=null;
let spotifyReadyPromise=null;
let spotifyPlayerInitPromise=null;
let spotifyAdvanceLock=false;
let currentSpotifyQueueId=null;
let lastState=null;
let lastTrackId=null;
let spotifyReconnectTimer=null;
let spotifyReadyRejectTimer=null;
let autoDjMode=localStorage.getItem('autoDjMode')!=='off';
let breezeMix='smooth';
let breezeMemory={energy:55,plays:0,topArtists:[],topTitles:[],recentArtists:[],birthdayCount:0,lastReason:''};
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function chooseNext(items){
  const ready=items.filter(x=>['accepted','pending'].includes(x.status)&&(x.spotifyId||x.sourceUrl));
  if(!ready.length)return null;
  const birthday=ready.find(x=>x.birthday);
  if(birthday)return birthday;
  return [...ready].sort((a,b)=>{
    const score=x=>Number(x.favorite?24:0)+Math.min(16,Number(x.popularity||0)/8)+Math.min(40,Number(x.votes||0)*5)+Math.min(12,Math.max(0,Date.now()-(x.createdAt||Date.now()))/60000);
    return score(b)-score(a)||((a.createdAt||0)-(b.createdAt||0));
  })[0]||null;
}
async function maybeAutoStart(){if(!autoDjMode||currentSpotifyQueueId)return;try{await loadControlQueue();const next=await chooseNext(controlQueue);if(next&&spotifyPlayer&&spotifyDeviceId)await playQueue(next.id);}catch(e){console.warn('Auto-DJ konnte nicht starten:',e.message)}}
async function recoverAdminSession(){
  try{
    const r=await fetch('/api/admin/session/recover',{method:'POST',headers:{'Content-Type':'application/json'}});
    if(!r.ok)return false;
    const d=await r.json();
    if(d.token){adminToken=d.token;localStorage.setItem('djToken',adminToken);return true;}
  }catch{}
  return false;
}
async function api(url,opt={}){
  const doFetch=()=>fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});
  let r=await doFetch();let d={};try{d=await r.json()}catch{}
  if(r.status===401 && adminToken){
    const recovered=await recoverAdminSession();
    if(recovered){
      const headers={...(opt.headers||{}),Authorization:'Bearer '+adminToken};
      r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...headers}});
      d={};try{d=await r.json()}catch{}
    }
  }
  if(!r.ok)throw Error(d.error||'Fehler');return d;
}
function go(id){const el=$('#'+id);if(el)el.scrollIntoView({behavior:'smooth'});}
document.querySelectorAll('[data-section]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.section)));
$('#controlRoomBtn').addEventListener('click',()=>{if(adminToken)openControl();else openModal('loginModal')});
function openModal(id){const m=$('#'+id);if(m)m.hidden=false} function closeModal(id){const m=$('#'+id);if(m)m.hidden=true}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.hidden=true}));
$('#detailsBtn').addEventListener('click',()=>openModal('detailsModal'));
$('#djPassword').addEventListener('keydown',e=>{if(e.key==='Enter')$('#loginBtn').click()});
$('#loginBtn').addEventListener('click',async()=>{try{const d=await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:$('#djPassword').value})});adminToken=d.token;localStorage.setItem('djToken',adminToken);$('#djPassword').value='';$('#loginMsg').textContent='';closeModal('loginModal');openControl();await loadControlQueue();await updateSpotifyStatus()}catch(e){$('#loginMsg').textContent='❌ '+e.message}});
$('#logoutBtn').addEventListener('click',async()=>{try{if(adminToken)await api('/api/admin/logout',{method:'POST',headers:{Authorization:'Bearer '+adminToken}})}catch{}adminToken='';localStorage.removeItem('djToken');spotifyPlayer?.disconnect();spotifyPlayer=null;spotifyDeviceId=null;spotifyReadyPromise=null;spotifyPlayerInitPromise=null;lastState=null;currentSpotifyQueueId=null;closeModal('controlModal')});
function openControl(){openModal('controlModal');loadControlQueue();updateSpotifyStatus()}
let pendingRequest=null;
$('#searchForm').addEventListener('submit',async e=>{e.preventDefault();const title=$('#title').value.trim(),artist=$('#artist').value.trim();if(!title&&!artist)return;$('#results').innerHTML='<p class="muted">Spotify wird durchsucht…</p>';try{const d=await api('/api/search?q='+encodeURIComponent([title,artist].filter(Boolean).join(' ')));if(!d.tracks.length){$('#results').innerHTML='<p class="muted">Kein Treffer gefunden.</p>';return}$('#results').innerHTML=d.tracks.map(t=>`<div class="result"><div class="resultInfo">${t.image?`<img src="${esc(t.image)}" alt="">`:''}<div><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></div></div><button type="button" data-spotify-id="${esc(t.id)}" data-title="${esc(t.title)}" data-artist="${esc(t.artist)}" data-album="${esc(t.album||'')}" data-image="${esc(t.image||'')}" data-popularity="${esc(t.popularity||0)}" data-release="${esc(t.releaseDate||'')}" data-duration="${esc(t.durationMs||0)}">WUNSCH</button></div>`).join('');document.querySelectorAll('#results button[data-spotify-id]').forEach(b=>b.onclick=()=>sendWish({title:b.dataset.title,artist:b.dataset.artist,spotifyId:b.dataset.spotifyId,album:b.dataset.album,image:b.dataset.image,popularity:Number(b.dataset.popularity||0),releaseDate:b.dataset.release,durationMs:Number(b.dataset.duration||0)}))}catch(e){$('#results').innerHTML='<p class="message">❌ '+esc(e.message)+'</p>'}});
async function sendWish(w){try{await api('/api/wishes',{method:'POST',body:JSON.stringify(w)});$('#msg').textContent='✓ Wunsch wurde in die Warteschlange gesetzt.';$('#results').innerHTML='';$('#title').value='';$('#artist').value='';loadWishes()}catch(e){$('#msg').textContent='❌ '+e.message}}
function renderPublic(data){const w=Array.isArray(data)?data:(data.queue||[]);const recent=Array.isArray(data)?[]:(data.recent||[]);const box=$('#publicWishes');const active=w.filter(x=>['pending','accepted'].includes(x.status));box.innerHTML=active.length?active.map((x,i)=>`<div class="queueItem"><span class="number">${i+1}</span><div class="wishText"><strong>${esc(x.title)}</strong><small>${esc(x.artist)}</small><span class="status">${x.status==='accepted'?'ALS NÄCHSTES':'WARTET'}${x.birthday?' · BIRTHDAY':''} · ${x.votes||0} ❤</span></div><div class="voteActions"><button type="button" class="voteBtn" data-vote="${esc(x.id)}" data-value="1">❤</button><button type="button" class="voteBtn dislikeBtn" data-vote="${esc(x.id)}" data-value="-1">👎</button></div></div>`).join(''):'<p class="muted">Noch keine Wünsche in der Warteschlange.</p>';const old=$('#recentPlayed');if(old)old.innerHTML=recent.length?recent.map(x=>`<div class="queueItem recentItem"><div class="wishText"><strong>${esc(x.title)}</strong><small>${esc(x.artist)}</small></div></div>`).join(''):'<p class="muted">Noch keine Songs gespielt.</p>';}

async function loadWishes(){try{renderPublic(await api('/api/wishes'));if(autoDjMode&&spotifyPlayer&&spotifyDeviceId&&!currentSpotifyQueueId)maybeAutoStart()}catch{$('#publicWishes').innerHTML='<p class="muted">Warteschlange momentan nicht erreichbar.</p>'}}
$('#refreshQueue').addEventListener('click',loadWishes);
$('#publicWishes').addEventListener('click',async e=>{const b=e.target.closest('[data-vote]');if(!b)return;try{await api('/api/wishes/'+b.dataset.vote+'/vote',{method:'POST',body:JSON.stringify({value:Number(b.dataset.value||1)})});loadWishes()}catch(err){}});
$('#startBirthdayRoom').addEventListener('click',async()=>{const name=$('#birthdayRoomName').value.trim();if(!name){$('#birthdayRoomMsg').textContent='Bitte gib einen Namen ein.';return}try{await api('/api/wishes',{method:'POST',body:JSON.stringify({title:'Happy Birthday '+name,artist:'Birthday Room',sourceUrl:'/birthday.mp3'})});$('#birthdayRoomMsg').textContent='✓ Birthday-Song kommt als NÄCHSTES! 🎂';$('#birthdayRoomName').value='';loadWishes();if(autoDjMode)maybeAutoStart()}catch(e){$('#birthdayRoomMsg').textContent='❌ '+e.message}});

async function loadControlQueue(){if(!adminToken)return;try{const d=await api('/api/admin/queue',{headers:{Authorization:'Bearer '+adminToken}});controlQueue=d.queue||[];controlHistory=d.recent||[];renderControlQueue();updateNow(d.live?.nowPlaying)}catch(e){if(e.message==='Nicht angemeldet'){adminToken='';localStorage.removeItem('djToken');closeModal('controlModal')}}}
function updateBreezeMemoryUi(){const el=$('#breezeMemoryUi');if(!el)return;const artists=(breezeMemory.topArtists||[]).slice(0,3).map(x=>`${esc(x[0])} (${x[1]})`).join(' · ')||'Noch keine';const energy=Math.round(Number(breezeMemory.energy||55));el.innerHTML=`<div><b>${energy}%</b><small>AKTUELLE ENERGIE</small></div><div><b>${Number(breezeMemory.plays||0)}</b><small>SONGS IM GEDÄCHTNIS</small></div><div><b>${Number(breezeMemory.birthdayCount||0)}</b><small>BIRTHDAYS</small></div><div><b>${artists}</b><small>TOP ARTISTS</small></div>`}
function updateNow(live){const title=live?.title||'Gerade läuft keine Musik',artist=live?.artist||'DJ BREEZE ist bereit';$('#controlNowPlaying').textContent=title;$('#controlNowArtist').textContent=artist;$('#homeNow').textContent=title;$('#homeNowArtist').textContent=artist}
function renderControlQueue(){const box=$('#controlQueueList');const arr=controlQueue.filter(x=>['pending','accepted'].includes(x.status));box.innerHTML=arr.length?arr.map((x,i)=>`<div class="controlItem"><span class="number">${i+1}</span><div class="wishText"><strong>${esc(x.title)}</strong><small>${esc(x.artist)}</small><span class="status">${x.status==='accepted'?'AKZEPTIERT':'WARTET'}${x.spotifyId?' · SPOTIFY':' · AUDIO'}${x.favorite?' · ★ FAVORIT':''} · ${Number(x.votes||0)}❤</span></div><div class="actions"><button class="ok" data-act="play" data-id="${x.id}">▶</button><button data-act="up" data-id="${x.id}">↑</button><button data-act="down" data-id="${x.id}">↓</button><button data-act="favorite" data-id="${x.id}">${x.favorite?'★':'☆'}</button><button class="bad" data-act="reject" data-id="${x.id}">✕</button><button class="bad" data-act="ban" data-id="${x.id}">🚫</button></div></div>`).join(''):'<p class="muted">Warteschlange ist leer.</p>'}
$('#controlQueueList').addEventListener('click',async e=>{const b=e.target.closest('button[data-act]');if(!b)return;const id=b.dataset.id,act=b.dataset.act;try{if(act==='play')await playQueue(id);else if(act==='ban')await banQueueSong(id);else{const action={up:'moveUp',down:'moveDown',reject:'rejected',favorite:'favorite'}[act];await queuePatch(id,action)}await loadControlQueue();await loadWishes()}catch(err){alert(err.message)}});
function renderStats(st){if(!st)return;const el=$('#djStats');if(el)el.innerHTML=`<div><b>${st.total}</b><small>WÜNSCHE</small></div><div><b>${st.played}</b><small>GESPIELT</small></div><div><b>${st.pending}</b><small>OFFEN</small></div><div><b>${st.rejected}</b><small>ABGELEHNT</small></div>`;}
async function queuePatch(id,action){await api('/api/admin/queue/'+id,{method:'PATCH',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({action})})}
async function banQueueSong(id){const x=controlQueue.find(q=>q.id===id);if(!x)return;await api('/api/admin/ban',{method:'POST',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({title:x.title,artist:x.artist})})}

async function updateSpotifyStatus(){const btn=$('#spotifyConnectBtn'),status=$('#spotifyStatus');if(!btn)return;try{const d=await api('/api/admin/spotify/status',{headers:{Authorization:'Bearer '+adminToken}});if(!d.configured){btn.hidden=false;btn.disabled=true;btn.textContent='SPOTIFY NICHT EINGERICHTET';status.textContent='Render-Variablen fehlen.';return}if(d.connected){btn.hidden=true;status.textContent=`✓ SPOTIFY VERBUNDEN${d.displayName?' · '+d.displayName:''}`;$('#spotifyDevice').textContent='Bereit: Klicke „SPOTIFY PLAYER STARTEN“ für die Audiofreigabe.'}else{btn.hidden=false;btn.disabled=false;btn.textContent='SPOTIFY VERBINDEN ↗';status.textContent='Spotify muss im Control Room verbunden werden.'}}catch(e){status.textContent='Spotify-Status konnte nicht geladen werden.'}}
$('#spotifyConnectBtn').addEventListener('click',async()=>{try{const d=await api('/auth/spotify/login',{method:'POST',headers:{Authorization:'Bearer '+adminToken}});window.location.href=d.url}catch(e){alert(e.message)}});

function updateProgress(state){const pct=state&&state.duration?Math.min(100,(state.position/state.duration)*100):0;const a=$('#homeProgress'),b=$('#controlProgress');if(a)a.style.width=pct+'%';if(b)b.style.width=pct+'%';}
function loadSpotifySDK(){
  if(window.Spotify) return Promise.resolve(true);
  if(spotifySdkPromise) return spotifySdkPromise;
  spotifySdkPromise=new Promise((resolve,reject)=>{
    window.__spotifySDKResolve=resolve;
    window.__spotifySDKReject=reject;
    const s=document.createElement('script');
    s.src='https://sdk.scdn.co/spotify-player.js';
    s.async=true;
    s.onerror=()=>reject(new Error('Spotify Player SDK konnte nicht geladen werden.'));
    document.head.appendChild(s);
  });
  return spotifySdkPromise;
}
function initSpotifyPlayer(options={}){
  const userGesture=Boolean(options.userGesture);
  if(spotifyPlayerInitPromise) return spotifyPlayerInitPromise;
  spotifyPlayerInitPromise=(async()=>{
    await loadSpotifySDK();
    if(spotifyPlayer && spotifyDeviceId) return true;
    spotifyReadyPromise=new Promise((resolve,reject)=>{
      window.__spotifyResolve=resolve;
      window.__spotifyReject=reject;
      clearTimeout(spotifyReadyRejectTimer);
      spotifyReadyRejectTimer=setTimeout(()=>reject(new Error('Spotify Browser-Player wurde nicht rechtzeitig bereit.')),15000);
    });
    spotifyPlayer=new Spotify.Player({
      name:'Herner Eisdisco – BREEZE KI',
      volume:0.9,
      enableMediaSession:true,
      getOAuthToken:async cb=>{
        try{
          const d=await api('/api/admin/spotify/token',{headers:{Authorization:'Bearer '+adminToken}});
          if(!d.access_token) throw new Error('Kein Spotify-Zugriffstoken erhalten.');
          cb(d.access_token);
        }catch(e){
          console.error('Spotify Token konnte nicht geladen werden:',e);
          cb('');
        }
      }
    });
    spotifyPlayer.addListener('ready',async({device_id})=>{
      clearTimeout(spotifyReadyRejectTimer);
      spotifyDeviceId=device_id;
      $('#spotifyDevice').textContent='Browser-Player bereit · Audioausgabe aktivierbar';
      try{
        const d=await api('/api/admin/spotify/token',{headers:{Authorization:'Bearer '+adminToken}});
        const r=await fetch('https://api.spotify.com/v1/me/player',{method:'PUT',headers:{Authorization:'Bearer '+d.access_token,'Content-Type':'application/json'},body:JSON.stringify({device_ids:[device_id],play:false})});
        if(!r.ok) console.warn('Spotify-Gerät konnte nicht übertragen werden:',r.status);
      }catch(e){console.warn('Spotify-Gerät konnte nicht aktiviert werden:',e.message)}
      window.__spotifyResolve?.(true);
      setTimeout(()=>{if(autoDjMode&&adminToken) maybeAutoStart();},250);
    });
    spotifyPlayer.addListener('not_ready',({device_id})=>{
      spotifyDeviceId=null;
      $('#spotifyDevice').textContent='Browser-Player offline – Verbindung wird wiederhergestellt …';
      if(spotifyReconnectTimer||!adminToken) return;
      spotifyReconnectTimer=setTimeout(async()=>{
        spotifyReconnectTimer=null;
        try{await spotifyPlayer?.connect();}catch(e){console.warn('Spotify-Reconnect fehlgeschlagen:',e.message)}
      },1500);
    });
    spotifyPlayer.addListener('initialization_error',({message})=>{console.error(message);$('#spotifyDevice').textContent='Player-Fehler: '+message;window.__spotifyReject?.(new Error(message))});
    spotifyPlayer.addListener('authentication_error',({message})=>{console.error(message);$('#spotifyDevice').textContent='Spotify-Anmeldung abgelaufen – bitte neu verbinden.';window.__spotifyReject?.(new Error(message))});
    spotifyPlayer.addListener('account_error',({message})=>{console.error(message);$('#spotifyDevice').textContent='Spotify Premium erforderlich';window.__spotifyReject?.(new Error('Spotify Premium erforderlich'))});
    spotifyPlayer.addListener('playback_error',({message})=>{console.error(message);$('#spotifyDevice').textContent='Wiedergabefehler: '+message});
    spotifyPlayer.addListener('autoplay_failed',()=>{$('#spotifyDevice').textContent='Einmal auf „WUNSCHLISTE STARTEN“ klicken, um Browser-Audio freizugeben.'});
    spotifyPlayer.addListener('player_state_changed',state=>{
      if(!state) return;
      const previousId=lastTrackId;
      lastState=state;
      const t=state.track_window?.current_track;
      if(t?.id) lastTrackId=t.id;
      updateProgress(state);
      recordEl?.classList.toggle('playing',!state.paused);
      if(t){
        $('#controlNowPlaying').textContent=t.name;
        $('#controlNowArtist').textContent=t.artists.map(a=>a.name).join(', ');
        $('#homeNow').textContent=t.name;
        $('#homeNowArtist').textContent=t.artists.map(a=>a.name).join(', ');
        setRecordAlbumArt(t);
        if($('#recordSpotifyLink')) $('#recordSpotifyLink').href=t.external_urls?.spotify||`https://open.spotify.com/track/${t.id}`;
      }
      // Wenn Spotify selbst auf einen anderen Track gewechselt hat, halten wir die Queue synchron.
      if(previousId && t?.id && previousId!==t.id && currentSpotifyQueueId && !spotifyAdvanceLock){
        // Der Web Player hat einen externen Trackwechsel erkannt. BREEZE übernimmt wieder ab dem nächsten Queue-Event.
        console.debug('Spotify Trackwechsel erkannt:',previousId,'→',t.id);
      }
    });
    // Browser-Audio zuerst innerhalb des echten Benutzerklicks freigeben.
    if(userGesture){
      try{await spotifyPlayer.activateElement();}catch(e){console.warn('Spotify Audio-Aktivierung fehlgeschlagen:',e.message)}
    }
    const connected=await spotifyPlayer.connect();
    if(!connected) throw new Error('Spotify Browser-Player konnte nicht verbunden werden.');
    return await spotifyReadyPromise;
  })();
  spotifyPlayerInitPromise.catch(()=>{clearTimeout(spotifyReadyRejectTimer);spotifyPlayerInitPromise=null;spotifyReadyPromise=null;});
  return spotifyPlayerInitPromise;
}
window.onSpotifyWebPlaybackSDKReady=()=>window.__spotifySDKResolve?.(true);

async function ensureSpotifyPlayer(userGesture=false){await initSpotifyPlayer({userGesture});if(!spotifyDeviceId)throw new Error('Spotify Browser-Player ist noch nicht bereit. Warte kurz und versuche es erneut.');if(userGesture){try{await spotifyPlayer.activateElement()}catch{}}return spotifyDeviceId}
async function playQueue(id){
  const x=controlQueue.find(q=>q.id===id);
  if(!x) throw new Error('Wunsch nicht gefunden.');
  if(x.spotifyId){
    const device=await ensureSpotifyPlayer();
    await api('/api/admin/spotify/play',{method:'POST',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({spotifyId:x.spotifyId,deviceId:device})});
  }else{
    const audio=$('#browserAudio');
    if(!x.sourceUrl) throw new Error('Für diesen Wunsch gibt es keine abspielbare Quelle.');
    audio.src=x.sourceUrl;
    await audio.play();
  }
  currentSpotifyQueueId=x.id;
  await queuePatch(id,'accepted');
  await api('/api/admin/live',{method:'PATCH',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({nowPlaying:{title:x.title,artist:x.artist}})});
}
async function playNextInQueue(){
  if(spotifyAdvanceLock) return;
  spotifyAdvanceLock=true;
  try{
    const finishedId=currentSpotifyQueueId;
    currentSpotifyQueueId=null;
    if(finishedId) await queuePatch(finishedId,'done');
    await loadControlQueue();
    const next=await chooseNext(controlQueue);
    if(next){
      await playQueue(next.id);
    }else{
      await api('/api/admin/live',{method:'PATCH',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({nowPlaying:null})});
      resetRecordAlbumArt();
    }
  }catch(e){
    console.error('Nächster Wunsch konnte nicht gestartet werden:',e);
    currentSpotifyQueueId=null;
    try{await api('/api/admin/live',{method:'PATCH',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({nowPlaying:null})})}catch{}
    resetRecordAlbumArt();
    throw e;
  }finally{spotifyAdvanceLock=false}
}
$('#browserAudio').addEventListener('play',()=>recordEl?.classList.add('playing'));$('#browserAudio').addEventListener('pause',()=>recordEl?.classList.remove('playing'));$('#browserAudio').addEventListener('ended',playNextInQueue);
$('#activateSpotifyPlayer').addEventListener('click',async()=>{try{const btn=$('#activateSpotifyPlayer');btn.disabled=true;btn.textContent='SPOTIFY PLAYER VERBINDET …';await ensureSpotifyPlayer(true);$('#spotifyDevice').textContent='✓ Browser-Player bereit · Audioausgabe aktiv';btn.textContent='✓ SPOTIFY PLAYER BEREIT';}catch(e){$('#spotifyDevice').textContent='❌ '+e.message;btn.disabled=false;btn.textContent='SPOTIFY PLAYER STARTEN ▶';alert(e.message)}});
$('#startQueueBtn').addEventListener('click',async()=>{try{await ensureSpotifyPlayer(true);await loadControlQueue();const next=await chooseNext(controlQueue);if(!next)throw new Error('Die Warteschlange ist leer.');await playQueue(next.id)}catch(e){alert(e.message)}});
const autoToggle=$('#autoDjToggle');if(autoToggle){autoToggle.checked=autoDjMode;autoToggle.addEventListener('change',()=>{autoDjMode=autoToggle.checked;localStorage.setItem('autoDjMode',autoDjMode?'on':'off');if(autoDjMode)maybeAutoStart()})}


$('#refreshControlQueue').addEventListener('click',loadControlQueue);
$('#banBtn').addEventListener('click',async()=>{const title=$('#banTitle').value.trim(),artist=$('#banArtist').value.trim();if(!title)return;try{await api('/api/admin/ban',{method:'POST',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({title,artist})});$('#banTitle').value='';$('#banArtist').value='';await loadControlQueue();await loadWishes()}catch(e){alert(e.message)}});
$('#pauseSpotify').addEventListener('click',async()=>{try{await api('/api/admin/spotify/pause',{method:'POST',headers:{Authorization:'Bearer '+adminToken}})}catch(e){alert(e.message)}});
$('#nextSpotify').addEventListener('click',playNextInQueue);

// Interactive vinyl: drag the tonearm with mouse/touch. The record animation follows playback.
const recordEl=$('#record'),tonearmEl=$('#tonearm');
const recordAlbumArtEl=$('#recordAlbumArt'),recordFallbackEl=$('#recordFallback');
function setRecordAlbumArt(track){
  const image=track?.album?.images?.[0]?.url || '';
  if(image){
    recordAlbumArtEl.src=image;
    recordAlbumArtEl.hidden=false;
    recordFallbackEl.hidden=true;
    recordAlbumArtEl.title=(track.album?.name||'Album')+' – Spotify';
  }else{
    recordAlbumArtEl.hidden=true;
    recordAlbumArtEl.removeAttribute('src');
    recordFallbackEl.hidden=false;
  }
}
function resetRecordAlbumArt(){
  recordAlbumArtEl.hidden=true;
  recordAlbumArtEl.removeAttribute('src');
  recordFallbackEl.hidden=false;
}

let tonearmAngle=19,tonearmDragging=false;
function setTonearm(angle,user=true){
  tonearmAngle=Math.max(-18,Math.min(34,angle));
  if(tonearmEl)tonearmEl.style.transform=`rotate(${tonearmAngle}deg)`;
  if(!user)return;
  if(tonearmAngle>8){recordEl?.classList.add('playing');if(spotifyPlayer&&lastState?.paused)spotifyPlayer.resume().catch(()=>{});}
  else{recordEl?.classList.remove('playing');if(spotifyPlayer&&!lastState?.paused)spotifyPlayer.pause().catch(()=>{});}
}
if(tonearmEl){
  tonearmEl.addEventListener('pointerdown',e=>{tonearmDragging=true;tonearmEl.classList.add('dragging');tonearmEl.setPointerCapture?.(e.pointerId);e.preventDefault()});
  tonearmEl.addEventListener('pointermove',e=>{if(!tonearmDragging)return;const r=tonearmEl.getBoundingClientRect();const cx=r.left+r.width*.88,cy=r.top+r.height*.08;setTonearm(Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI)});
  tonearmEl.addEventListener('pointerup',e=>{tonearmDragging=false;tonearmEl.classList.remove('dragging');tonearmEl.releasePointerCapture?.(e.pointerId)});
  tonearmEl.addEventListener('pointercancel',()=>{tonearmDragging=false;tonearmEl.classList.remove('dragging')});
}
recordEl?.addEventListener('click',async()=>{try{await ensureSpotifyPlayer(true);await spotifyPlayer.activateElement();await spotifyPlayer.togglePlay()}catch(e){alert(e.message)}});
$('#stopSpotify').addEventListener('click',async()=>{try{if(spotifyPlayer)await spotifyPlayer.pause();else await api('/api/admin/spotify/pause',{method:'POST',headers:{Authorization:'Bearer '+adminToken}});currentSpotifyQueueId=null;await api('/api/admin/live',{method:'PATCH',headers:{Authorization:'Bearer '+adminToken},body:JSON.stringify({nowPlaying:null})});resetRecordAlbumArt();await loadControlQueue()}catch(e){alert(e.message)}});
$('#fullscreenControl').addEventListener('click',()=>{const el=$('#controlModal')?.querySelector('.controlCard');if(!document.fullscreenElement)el?.requestFullscreen?.();else document.exitFullscreen?.()});
document.querySelectorAll('[data-sound]').forEach(b=>b.addEventListener('click',()=>{const a=new Audio(b.dataset.sound);a.volume=.9;a.play().catch(()=>{})}));
async function loadLive(){try{updateNow(await api('/api/live'))}catch{}}
loadWishes();loadLive();
if(new URLSearchParams(location.search).get('spotify')==='connected'){setTimeout(()=>{if(adminToken)openControl()},300);history.replaceState({},'',location.pathname)}
setInterval(()=>{loadWishes();loadLive();if(!$('#controlModal').hidden&&adminToken)loadControlQueue()},5000);
// Detect end of a Spotify track in the browser and advance the DJ queue.
setInterval(async()=>{if(!spotifyPlayer||!lastState||spotifyAdvanceLock||!currentSpotifyQueueId)return;const duration=Number(lastState.duration||0),pos=Number(lastState.position||0);if(duration>0&&!lastState.paused&&pos>=Math.max(0,duration-900)){try{await playNextInQueue()}catch(e){console.error('Auto-DJ:',e)}}},500);
