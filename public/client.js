const socket = io();

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

let state = { code: '', you: null, hostId: null, phase: 'lobby', settings: {}, players: [] };
let timerInt = null; let remaining = 0;

function saveUUID(uuid) { localStorage.setItem('si_uuid', uuid); }
function getUUID() { return localStorage.getItem('si_uuid'); }

// --- URL param support: ?room=ABCDE
window.addEventListener('DOMContentLoaded', () => {
  const qp = new URLSearchParams(location.search);
  if (qp.has('room')) $('code').value = qp.get('room').toUpperCase();
});

// --- Create: ask server for a room code, then auto-join host
$('create').addEventListener('click', () => {
  socket.emit('room:create', ({ code }) => {
    $('code').value = code;
    const name = (($('name').value || 'Player').trim()).slice(0,20);
    socket.emit('room:join', { code, name, uuid: getUUID() });
  });
});

// --- Copy invite link
$('copyLink').addEventListener('click', () => {
  const code = ($('code').value || '').trim().toUpperCase();
  if (!code) return alert('No room code yet. Click Create first.');
  const url = `${location.origin}?room=${code}`;
  navigator.clipboard.writeText(url).then(() => alert('Invite link copied!'));
});

// --- Join with basic validation
$('joinBtn').addEventListener('click', () => {
  const code = ($('code').value || '').trim().toUpperCase();
  const name = (($('name').value || 'Player').trim()).slice(0,20);
  if (!code) return alert('Please enter a valid room code or click Create.');
  socket.emit('room:join', { code, name, uuid: getUUID() });
});

// --- Host controls
$('start').addEventListener('click', () => socket.emit('host:start', { code: state.code }));
$('endClues').addEventListener('click', () => socket.emit('host:endClues', { code: state.code }));
$('clueSeconds').addEventListener('change', updateSettings);
$('allowChat').addEventListener('change', updateSettings);
function updateSettings(){ socket.emit('host:settings', { code: state.code, settings: { clueSeconds:Number($('clueSeconds').value), allowChat:$('allowChat').checked } }); }

// --- Clues/chat
$('sendClue').addEventListener('click', sendClue);
$('clueInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter') sendClue(); });
function sendClue(){ const text=$('clueInput').value.trim(); if(!text) return; socket.emit('clue:send',{ code: state.code, text }); $('clueInput').value=''; }
$('backToLobby').addEventListener('click', ()=>location.href = location.origin);

// --- Socket events
socket.on('room:joined', (payload) => {
  state = { ...state, ...payload };
  saveUUID(payload.you.uuid);
  hide('join'); show('lobby');
  $('lobbyCode').innerText = `#${payload.code}`;
  renderPlayers(payload.players); renderHostTools();
});
socket.on('state:update', ({ phase, players, settings, round }) => {
  state.phase = phase; state.players = players; state.settings = settings; state.round = round;
  renderPlayers(players); renderHostTools();
});
socket.on('secret:role', ({ role, player }) => {
  hide('lobby'); show('role');
  const badge=$('roleBadge'), secret=$('secret'), tip=$('roleTip');
  if (role==='IMPOSTOR'){ badge.textContent='IMPOSTOR'; badge.className='badge danger'; secret.textContent='❓ Unknown Player'; tip.textContent='Blend in. Give vague soccer hints.'; }
  else { badge.textContent='CIVILIAN'; badge.className='badge'; secret.textContent=`🟢 ${player}`; tip.textContent='Give subtle hints without saying the name.'; }
});
socket.on('phase:clues:start', ({ seconds }) => {
  hide('role'); show('clues');
  $('clueList').innerHTML=''; startTimer(seconds);
  if (isHost()) show('hostClues'); else hide('hostClues');
});
socket.on('clue:new', ({ name, text }) => {
  const el=document.createElement('div'); el.className='clue';
  el.innerHTML=`<strong>${escapeHTML(name)}</strong><span>${escapeHTML(text)}</span>`;
  $('clueList').appendChild(el); $('clueList').scrollTop=$('clueList').scrollHeight;
});
socket.on('phase:vote:start', ({ players }) => { hide('clues'); show('vote'); renderVote(players); });
socket.on('vote:update', () => {});
socket.on('phase:reveal', ({ impostorName, playerName, impostorCaught, reason }) => {
  hide('vote'); show('reveal');
  $('revealText').innerHTML = `
    <p>The secret player was <b>${escapeHTML(playerName)}</b>.</p>
    <p>Impostor: <b>${escapeHTML(impostorName)}</b> ${reason ? '('+escapeHTML(reason)+')' : ''}</p>
    <p>${impostorCaught ? '✅ Civilians win!' : '❌ Impostor survived!'}</p>`;
});
socket.on('error:toast', (msg) => alert(msg));

// --- Renders & helpers
function renderPlayers(players){ $('players').innerHTML = players.map(p=>`<span class="pill ${p.connected?'on':'off'}">${escapeHTML(p.name)}</span>`).join(''); }
function renderHostTools(){ const isHostNow=isHost(); if(isHostNow && state.phase==='lobby') show('hostTools'); else hide('hostTools'); }
function renderVote(players){
  const me=state.you?.id;
  $('voteList').innerHTML = players.filter(p=>p.connected).map(p=>`<button class="voteBtn" data-id="${p.id}" ${p.id===me?'disabled':''}>${escapeHTML(p.name)}</button>`).join('');
  document.querySelectorAll('.voteBtn').forEach(btn=>btn.addEventListener('click',()=>{
    socket.emit('vote:cast',{ code: state.code, targetId: btn.dataset.id });
    document.querySelectorAll('.voteBtn').forEach(b=>b.disabled=true);
  }));
}
function isHost(){ return state.you && state.you.id === state.hostId; }
function startTimer(seconds){
  clearInterval(timerInt); remaining=seconds; $('timer').textContent=remaining;
  timerInt=setInterval(()=>{ remaining-=1; $('timer').textContent=remaining;
    if(remaining<=0){ clearInterval(timerInt); socket.emit('host:endClues',{ code: state.code }); }
  },1000);
}
function escapeHTML(s){ return (s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
