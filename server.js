import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static('public'));

// ----- Soccer DB (from your spec) -----
const DB = {
  forwards: ['Lionel Messi','Kylian Mbappé','Erling Haaland','Vinícius Júnior','Mohamed Salah','Harry Kane','Jude Bellingham','Lautaro Martínez','Antoine Griezmann','Robert Lewandowski','Son Heung-min','Bukayo Saka','Jamal Musiala','Florian Wirtz','Rafael Leão','Khvicha Kvaratskhelia','Rodrygo','Ousmane Dembélé','Leroy Sané','Kingsley Coman','Marcus Rashford','Jack Grealish','Christopher Nkunku','Kai Havertz','João Félix','Darwin Núñez','Victor Osimhen','Alexander Isak','Randal Kolo Muani','Dusan Vlahović','Álvaro Morata','Federico Chiesa','Julián Álvarez','Paulo Dybala','Ángel Di María','Kenan Yıldız','Dayro Moreno'],
  mids: ['Kevin De Bruyne','Bernardo Silva','Martin Ødegaard','Bruno Fernandes','Federico Valverde','Pedri','Gavi','Frenkie de Jong','Ilkay Gündoğan','Toni Kroos','Luka Modrić','Declan Rice','Casemiro','Adrien Rabiot','Nicolo Barella','Hakan Çalhanoğlu','Sandro Tonali','Sergej Milinković-Savić','James Maddison','Mason Mount','Dominic Szoboszlai','Dani Olmo','Youssouf Fofana','Aurélien Tchouaméni','Eduardo Camavinga','Marco Verratti','Martin Zubimendi','Mikel Merino','Alexis Mac Allister','Enzo Fernández','Moisés Caicedo','João Palhinha','Teun Koopmeiners','Scott McTominay','Weston McKennie','Christian Pulisic','Giovanni Reyna','Luis Díaz','Rodrigo De Paul','Leandro Paredes'],
  defenders: ['Virgil van Dijk','Rúben Dias','Marquinhos','Éder Militão','David Alaba','William Saliba','Josko Gvardiol','Antonio Rüdiger','Matthijs de Ligt','Milan Škriniar','Kim Min-jae','Dayot Upamecano','Ronald Araújo','Jules Koundé','Raphaël Varane','Pau Cubarsí','Alejandro Balde','Giovanni Di Lorenzo','Khéphren Thuram','Joshua Kimmich','Leon Goretzka','Benjamin Pavard','Raphael Guerreiro'],
  fullbacks: ['João Cancelo','Trent Alexander-Arnold','Andrew Robertson','Achraf Hakimi','Theo Hernández','Alphonso Davies','Reece James','Dani Carvajal'],
  gks: ['Emiliano "Dibu" Martínez','Thibaut Courtois','Alisson Becker','Ederson','Mike Maignan','Marc-André ter Stegen','Jan Oblak','André Onana','Diogo Costa','Yassine Bounou'],
  rising: ['Nico Williams','Khéphren Thuram','Alejandro Garnacho','Cole Palmer','Xavi Simons','Rodrigo Bentancur','Nicolò Fagioli','João Neves','Lamine Yamal']
};
// ----- helpers / room state -----
const rooms = new Map();
const randInt = (n) => crypto.randomInt(0, n);
function genCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c=''; for (let i=0;i<4;i++) c += a[randInt(a.length)];
  return rooms.has(c) ? genCode() : c;
}
function chooseImpostor(ids){ return ids[randInt(ids.length)]; }
function randomCard() {
  const pools = [DB.forwards, DB.mids, DB.defenders, DB.fullbacks, DB.gks, DB.rising];
  const pool = pools[randInt(pools.length)];
  return pool[randInt(pool.length)];
}
function sanitize(room, viewerId){
  return {
    code: room.code,
    hostId: room.hostId,
    youAreHost: viewerId===room.hostId,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    players: Object.values(room.players).map(p=>({id:p.id,nickname:p.nickname,connected:p.connected}))
  };
}
function broadcast(room){
  for (const pid of Object.keys(room.players)){
    io.to(pid).emit('room-update', sanitize(room, pid));
  }
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ nickname, maxPlayers }) => {
    const code = genCode();
    const room = {
      code, hostId: socket.id,
      maxPlayers: Math.max(3, Math.min(Number(maxPlayers)||8, 12)),
      phase: 'lobby',
      players: {}, impostorId: null, votes:{}
    };
    rooms.set(code, room);
    socket.join(code);
    room.players[socket.id] = { id: socket.id, nickname, connected:true, role:'unknown', card:null };
    socket.emit('room-joined', { code });
    broadcast(room);
  });

  socket.on('join-room', ({ code, nickname }) => {
    const room = rooms.get((code||'').toUpperCase());
    if (!room) return socket.emit('error-msg','Room not found.');
    if (room.phase!=='lobby') return socket.emit('error-msg','Game already started.');
    const connected = Object.values(room.players).filter(p=>p.connected).length;
    if (connected >= room.maxPlayers) return socket.emit('error-msg','Room is full.');
    socket.join(room.code);
    room.players[socket.id] = { id: socket.id, nickname, connected:true, role:'unknown', card:null };
    socket.emit('room-joined', { code: room.code });
    broadcast(room);
  });

  socket.on('start-game', ({ code }) => {
    const room = rooms.get((code||'').toUpperCase()); if (!room) return;
    if (socket.id !== room.hostId) return socket.emit('error-msg','Only host can start.');
    const active = Object.values(room.players).filter(p=>p.connected).map(p=>p.id);
    if (active.length < 3) return socket.emit('error-msg','Need at least 3 players.');
    room.impostorId = chooseImpostor(active);
    room.phase='playing';
    for (const pid of active){
      const role = pid===room.impostorId ? 'impostor' : 'crewmate';
      const card = randomCard();
      room.players[pid].role = role; room.players[pid].card = card;
      io.to(pid).emit('role', { role, card }); // private
    }
    broadcast(room);
  });

  socket.on('submit-hint', ({ code, text }) => {
    const room = rooms.get((code||'').toUpperCase()); if (!room || room.phase!=='playing') return;
    io.to(room.code).emit('hint', { id: crypto.randomUUID(), text: String(text||'').slice(0,160) });
  });

  socket.on('call-meeting', ({ code }) => {
    const room = rooms.get((code||'').toUpperCase()); if (!room || room.phase!=='playing') return;
    room.phase='meeting'; room.votes={}; io.to(room.code).emit('meeting-start'); broadcast(room);
  });

  socket.on('cast-vote', ({ code, targetId }) => {
    const room = rooms.get((code||'').toUpperCase()); if (!room || room.phase!=='meeting') return;
    if (!room.players[targetId]) return;
    room.votes[socket.id]=targetId;
    const active = Object.values(room.players).filter(p=>p.connected).map(p=>p.id);
    const votes = Object.values(room.votes).length;
    io.to(room.code).emit('vote-update', { count:votes, total:active.length });
    if (votes >= active.length){
      const tally={}; for (const v of Object.values(room.votes)) tally[v]=(tally[v]||0)+1;
      let ejected=null,max=-1; for (const [pid,c] of Object.entries(tally)){ if (c>max){max=c;ejected=pid;} }
      const impostorCaught = ejected===room.impostorId;
      io.to(room.code).emit('meeting-result',{ ejected, impostorCaught });
      if (impostorCaught){ room.phase='ended'; io.to(room.code).emit('game-over',{ winners:'crewmates', impostorId:room.impostorId }); }
      else {
        if (room.players[ejected]) room.players[ejected].connected=false;
        const remaining = Object.values(room.players).filter(p=>p.connected).length;
        if (remaining<3){ room.phase='ended'; io.to(room.code).emit('game-over',{ winners:'impostor', impostorId:room.impostorId, reason:'not-enough-players' }); }
        else room.phase='playing';
      }
      broadcast(room);
    }
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()){
      if (room.players[socket.id]){
        room.players[socket.id].connected=false;
        if (socket.id===room.hostId){
          const next = Object.values(room.players).find(p=>p.connected);
          if (next) room.hostId = next.id;
        }
        const any = Object.values(room.players).some(p=>p.connected);
        if (!any) rooms.delete(room.code); else broadcast(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running http://localhost:${PORT}`));
