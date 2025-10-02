const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ===== Soccer Player Database =====
const DB = {
  forwards: ['Lionel Messi','Kylian Mbappé','Erling Haaland','Vinícius Júnior','Mohamed Salah','Harry Kane','Jude Bellingham','Lautaro Martínez','Antoine Griezmann','Robert Lewandowski','Son Heung-min','Bukayo Saka','Jamal Musiala','Florian Wirtz','Rafael Leão','Khvicha Kvaratskhelia','Rodrygo','Ousmane Dembélé','Leroy Sané','Kingsley Coman','Marcus Rashford','Jack Grealish','Christopher Nkunku','Kai Havertz','João Félix','Darwin Núñez','Victor Osimhen','Alexander Isak','Randal Kolo Muani','Dusan Vlahović','Álvaro Morata','Federico Chiesa','Julián Álvarez','Paulo Dybala','Ángel Di María','Kenan Yıldız','Dayro Moreno'],
  midfielders: ['Kevin De Bruyne','Bernardo Silva','Martin Ødegaard','Bruno Fernandes','Federico Valverde','Pedri','Gavi','Frenkie de Jong','Ilkay Gündoğan','Toni Kroos','Luka Modrić','Declan Rice','Casemiro','Adrien Rabiot','Nicolo Barella','Hakan Çalhanoğlu','Sandro Tonali','Sergej Milinković-Savić','James Maddison','Mason Mount','Dominic Szoboszlai','Dani Olmo','Youssouf Fofana','Aurélien Tchouaméni','Eduardo Camavinga','Marco Verratti','Martin Zubimendi','Mikel Merino','Alexis Mac Allister','Enzo Fernández','Moisés Caicedo','João Palhinha','Teun Koopmeiners','Scott McTominay','Weston McKennie','Christian Pulisic','Giovanni Reyna','Luis Díaz','Rodrigo De Paul','Leandro Paredes'],
  defenders: ['Virgil van Dijk','Rúben Dias','Marquinhos','Éder Militão','David Alaba','William Saliba','Josko Gvardiol','Antonio Rüdiger','Matthijs de Ligt','Milan Škriniar','Kim Min-jae','Dayot Upamecano','Ronald Araújo','Jules Koundé','Raphaël Varane','Pau Cubarsí','Alejandro Balde','Giovanni Di Lorenzo','Khéphren Thuram','Joshua Kimmich','Leon Goretzka','Benjamin Pavard','Raphael Guerreiro'],
  fullbacks: ['João Cancelo','Trent Alexander-Arnold','Andrew Robertson','Achraf Hakimi','Theo Hernández','Alphonso Davies','Reece James','Dani Carvajal'],
  goalkeepers: ['Emiliano "Dibu" Martínez','Thibaut Courtois','Alisson Becker','Ederson','Mike Maignan','Marc-André ter Stegen','Jan Oblak','André Onana','Diogo Costa','Yassine Bounou'],
  rising: ['Nico Williams','Khéphren Thuram','Alejandro Garnacho','Cole Palmer','Xavi Simons','Rodrigo Bentancur','Nicolò Fagioli','João Neves','Lamine Yamal']
};
const flatPlayers = () => [...DB.forwards, ...DB.midfielders, ...DB.defenders, ...DB.fullbacks, ...DB.goalkeepers, ...DB.rising];

// ===== Room state =====
const rooms = new Map();
const randInt = (max) => crypto.randomInt(0, max);
const pick = (arr) => arr[randInt(arr.length)];
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genRoomCode = () => Array.from({length:5},()=>alphabet[randInt(alphabet.length)]).join('');
const genUniqueRoomCode = () => { let c=genRoomCode(); while (rooms.has(c)) c=genRoomCode(); return c; };

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId: null,
      createdAt: Date.now(),
      players: new Map(), // socketId -> {name, uuid, connected, alive:true}
      uuidIndex: new Map(), // uuid -> socketId
      phase: 'lobby',       // lobby | clues | vote | reveal
      minPlayers: 3,
      maxPlayers: 12,
      chosenPlayer: null,
      impostorId: null,
      round: 0,
      votes: new Map(),     // voter -> target
      settings: { clueSeconds: 60, allowChat: true, tasksTarget: 100, killCooldown: 20, sabotageDuration: 15 },
      tasks: { total: 100, progress: 0, sabotagedUntil: 0 },
      lastKillAt: 0
    });
  }
  return rooms.get(code);
}
const publicPlayerList = (room) =>
  Array.from(room.players.entries()).map(([id,p]) => ({ id, name: p.name, connected: p.connected, alive: p.alive !== false }));

function broadcastState(room) {
  io.to(room.code).emit('state:update', {
    phase: room.phase,
    players: publicPlayerList(room),
    settings: room.settings,
    round: room.round,
    tasks: room.tasks
  });
}
function aliveIds(room) {
  return Array.from(room.players.entries()).filter(([id,p]) => p.connected && p.alive !== false).map(([id])=>id);
}
function checkWin(room) {
  if (room.tasks.progress >= room.settings.tasksTarget) {
    room.phase = 'reveal';
    io.to(room.code).emit('phase:reveal', {
      impostorId: room.impostorId,
      impostorName: room.players.get(room.impostorId)?.name || 'Unknown',
      playerName: room.chosenPlayer,
      impostorCaught: true,
      reason: 'Civilians completed tasks'
    });
    broadcastState(room); return true;
  }
  if (room.impostorId && room.players.get(room.impostorId)?.alive === false) {
    room.phase = 'reveal';
    io.to(room.code).emit('phase:reveal', {
      impostorId: room.impostorId,
      impostorName: room.players.get(room.impostorId)?.name || 'Unknown',
      playerName: room.chosenPlayer,
      impostorCaught: true,
      reason: 'Impostor ejected'
    });
    broadcastState(room); return true;
  }
  const alive = aliveIds(room);
  if (alive.length > 0 && room.impostorId && room.players.get(room.impostorId)?.alive !== false) {
    const civs = alive.filter(id => id !== room.impostorId).length;
    const imps = 1;
    if (imps >= civs) {
      room.phase = 'reveal';
      io.to(room.code).emit('phase:reveal', {
        impostorId: room.impostorId,
        impostorName: room.players.get(room.impostorId)?.name || 'Unknown',
        playerName: room.chosenPlayer,
        impostorCaught: false,
        reason: 'Impostor reached parity'
      });
      broadcastState(room); return true;
    }
  }
  return false;
}
function startGame(room) {
  const ids = aliveIds(room);
  if (ids.length < room.minPlayers) throw new Error('Not enough players (need at least 3).');
  room.phase = 'clues';
  room.round += 1;
  room.chosenPlayer = pick(flatPlayers());
  room.impostorId = ids[randInt(ids.length)];
  room.votes.clear();
  room.tasks = { total: room.settings.tasksTarget, progress: 0, sabotagedUntil: 0 };
  room.lastKillAt = 0;
  for (const id of Array.from(room.players.keys())) {
    const p = room.players.get(id);
    if (p.connected) p.alive = true;
  }
  for (const id of ids) {
    if (id === room.impostorId) io.to(id).emit('secret:role', { role:'IMPOSTOR', player:null });
    else io.to(id).emit('secret:role', { role:'CIVILIAN', player: room.chosenPlayer });
  }
  io.to(room.code).emit('phase:clues:start', { seconds: room.settings.clueSeconds });
  broadcastState(room);
}
function endClues(room) {
  if (checkWin(room)) return;
  room.phase = 'vote';
  room.votes.clear();
  io.to(room.code).emit('phase:vote:start', { players: publicPlayerList(room) });
  broadcastState(room);
}
function resolveVote(room) {
  const tally = new Map();
  for (const target of room.votes.values()) tally.set(target, (tally.get(target)||0)+1);
  let max=-1, suspect=null;
  for (const [t,c] of tally.entries()) { if (c>max) { max=c; suspect=t; } }
  if (suspect && room.players.has(suspect)) {
    room.players.get(suspect).alive = false;
    io.to(room.code).emit('system:message', { text: `🟥 ${room.players.get(suspect).name} was ejected.` });
  }
  if (checkWin(room)) return;
  room.phase = 'reveal';
  io.to(room.code).emit('phase:reveal', {
    impostorId: room.impostorId,
    impostorName: room.players.get(room.impostorId)?.name || 'Unknown',
    playerName: room.chosenPlayer,
    impostorCaught: room.players.get(room.impostorId)?.alive === false
  });
  broadcastState(room);
}

io.on('connection', (socket) => {
  socket.on('room:create', (ack) => {
    const code = genUniqueRoomCode();
    ensureRoom(code);
    if (typeof ack === 'function') ack({ code });
  });

  socket.on('room:join', ({ code, name, uuid }) => {
    const room = rooms.get((code||'').toUpperCase());
    if (!room) { socket.emit('error:toast','Room not found. Ask host for the invite link or code.'); return; }
    socket.join(room.code);
    if (!room.hostId) room.hostId = socket.id;

    if (uuid && room.uuidIndex.has(uuid)) {
      const oldId = room.uuidIndex.get(uuid);
      const p = room.players.get(oldId);
      if (p) {
        room.players.delete(oldId);
        room.players.set(socket.id, { ...p, connected: true });
        room.uuidIndex.set(uuid, socket.id);
      }
    } else {
      const player = { name: (name||'Player').slice(0,20), uuid: uuid || crypto.randomUUID(), connected: true, alive: true };
      room.players.set(socket.id, player);
      room.uuidIndex.set(player.uuid, socket.id);
    }

    socket.emit('room:joined', {
      code: room.code,
      you: { id: socket.id, name: room.players.get(socket.id).name, uuid: room.players.get(socket.id).uuid },
      hostId: room.hostId,
      phase: room.phase,
      settings: room.settings,
      players: publicPlayerList(room),
      tasks: room.tasks
    });
    broadcastState(room);
  });

  socket.on('host:start', ({ code }) => { const room = rooms.get(code); if (!room) return; if (socket.id !== room.hostId) return; try { startGame(room); } catch (e) { socket.emit('error:toast', e.message); } });
  socket.on('host:endClues', ({ code }) => { const room = rooms.get(code); if (!room) return; if (socket.id !== room.hostId) return; endClues(room); });
  socket.on('host:settings', ({ code, settings }) => { const room = rooms.get(code); if (!room) return; if (socket.id !== room.hostId) return; room.settings = { ...room.settings, ...settings }; broadcastState(room); });

  socket.on('clue:send', ({ code, text }) => {
    const room = rooms.get(code); if (!room || room.phase !== 'clues' || !room.settings.allowChat) return;
    const player = room.players.get(socket.id); if (!player || player.alive === false) return;
    const clean = String(text||'').trim().slice(0,140); if (!clean) return;
    io.to(code).emit('clue:new', { id: socket.id, name: player.name, text: clean });
  });

  socket.on('task:complete', ({ code, amount=5 }) => {
    const room = rooms.get(code); if (!room || room.phase !== 'clues') return;
    const p = room.players.get(socket.id); if (!p || socket.id === room.impostorId || p.alive === false) return;
    const now = Date.now();
    if (now < room.tasks.sabotagedUntil) return;
    room.tasks.progress = Math.min(room.settings.tasksTarget, room.tasks.progress + amount);
    io.to(code).emit('tasks:update', room.tasks);
    checkWin(room);
  });

  socket.on('imp:sabotage', ({ code }) => {
    const room = rooms.get(code); if (!room || room.phase !== 'clues') return;
    if (socket.id !== room.impostorId) return;
    const now = Date.now();
    if (now < room.tasks.sabotagedUntil) return;
    room.tasks.sabotagedUntil = now + room.settings.sabotageDuration * 1000;
    io.to(code).emit('sabotage:started', { until: room.tasks.sabotagedUntil });
    setTimeout(() => io.to(code).emit('sabotage:ended'), room.settings.sabotageDuration * 1000);
  });

  socket.on('imp:kill', ({ code, targetId }) => {
    const room = rooms.get(code); if (!room || room.phase !== 'clues') return;
    if (socket.id !== room.impostorId) return;
    const now = Date.now();
    if (now - room.lastKillAt < room.settings.killCooldown * 1000) return;
    if (!room.players.has(targetId)) return;
    const target = room.players.get(targetId);
    if (target.alive === false || targetId === room.impostorId) return;
    target.alive = false;
    room.lastKillAt = now;
    io.to(code).emit('system:message', { text:`🟥 ${target.name} was eliminated.` });
    broadcastState(room);
    checkWin(room);
  });

  socket.on('vote:cast', ({ code, targetId }) => {
    const room = rooms.get(code); if (!room || room.phase !== 'vote') return;
    if (!room.players.has(targetId)) return;
    const voter = room.players.get(socket.id);
    if (!voter || voter.alive === false) return;
    room.votes.set(socket.id, targetId);
    io.to(code).emit('vote:update', { votes: Array.from(room.votes.entries()) });
    const alive = aliveIds(room);
    const allVoted = alive.every(id => room.votes.has(id));
    if (allVoted) resolveVote(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (!room.players.has(socket.id)) continue;
      const p = room.players.get(socket.id);
      p.connected = false;
      if (room.hostId === socket.id) {
        const next = Array.from(room.players.entries()).find(([id,pl]) => pl.connected && pl.alive !== false);
        room.hostId = next ? next[0] : null;
      }
      if (room.phase !== 'lobby' && room.impostorId === socket.id) {
        room.phase = 'reveal';
        io.to(room.code).emit('phase:reveal', {
          impostorId: socket.id,
          impostorName: p.name,
          playerName: room.chosenPlayer,
          impostorCaught: true,
          reason: 'Impostor disconnected'
        });
      }
      broadcastState(room);
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Soccer Impostor running on http://localhost:${PORT}`));
