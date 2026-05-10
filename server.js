const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const socketIO = require('socket.io');
const cors = require('cors');

// ================= CONFIG =================

const PORT = process.env.PORT || 3000;

const app = express();

const server = http.createServer(app);

// ================= SOCKET.IO =================

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// ================= PEER SERVER =================

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/peerjs',
  proxied: true,
  allow_discovery: false,
  pingInterval: 5000
});

app.use(peerServer);

// ================= STATIC =================

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ================= ROOMS =================

const rooms = {};
const peerMap = {};

// ================= HELPERS =================

function getUserRoom(socketId) {

  for (const room in rooms) {

    if (rooms[room][socketId]) {
      return room;
    }
  }

  return null;
}

function broadcastPresence(room) {

  if (!rooms[room]) return;

  const users = Object.values(rooms[room]).map(user => ({
    peerId: user.peerId,
    name: user.name,
    isTalking: user.isTalking
  }));

  io.to(room).emit('presence', users);

  console.log(`Presenca enviada: ${users.length} usuarios`);
}

// ================= SOCKET CONNECTION =================

io.on('connection', (socket) => {

  console.log(`Novo socket conectado: ${socket.id}`);

  // ================= REGISTER =================

  socket.on('register', (data) => {

    try {

      if (!data.room || !data.peerId || !data.name) {
        return;
      }

      const room = data.room;
      const peerId = data.peerId;
      const name = data.name;

      socket.join(room);

      if (!rooms[room]) {
        rooms[room] = {};
      }

      rooms[room][socket.id] = {
        peerId: peerId,
        name: name,
        isTalking: false
      };

      // Mapeia peerId -> socket.id
      peerMap[peerId] = socket.id;

      console.log(`${name} entrou na sala ${room}`);

      // Atualiza todos
      broadcastPresence(room);

      socket.emit('registered', {
        success: true
      });

    } catch (e) {

      console.log('Erro register:', e.message);
    }
  });

  // ================= TALKING =================

  socket.on('talking_state', (data) => {

    try {

      const room = getUserRoom(socket.id);

      if (!room) return;

      const user = rooms[room][socket.id];

      if (!user) return;

      user.isTalking = data.isTalking;

      socket.to(room).emit('user_talking', {
        peerId: user.peerId,
        name: user.name,
        isTalking: data.isTalking
      });

      broadcastPresence(room);

    } catch (e) {

      console.log('Erro talking_state:', e.message);
    }
  });

  // ================= OFFER =================

  socket.on('offer', (data) => {

    try {

      const targetSocketId = peerMap[data.to];

      if (!targetSocketId) {

        console.log('Destino offer nao encontrado');
        return;
      }

      io.to(targetSocketId).emit('offer', data);

    } catch (e) {

      console.log('Erro offer:', e.message);
    }
  });

  // ================= ANSWER =================

  socket.on('answer', (data) => {

    try {

      const targetSocketId = peerMap[data.to];

      if (!targetSocketId) {

        console.log('Destino answer nao encontrado');
        return;
      }

      io.to(targetSocketId).emit('answer', data);

    } catch (e) {

      console.log('Erro answer:', e.message);
    }
  });

  // ================= CANDIDATE =================

  socket.on('candidate', (data) => {

    try {

      const targetSocketId = peerMap[data.to];

      if (!targetSocketId) {

        console.log('Destino candidate nao encontrado');
        return;
      }

      io.to(targetSocketId).emit('candidate', data);

    } catch (e) {

      console.log('Erro candidate:', e.message);
    }
  });

  // ================= DISCONNECT =================

  socket.on('disconnect', () => {

    try {

      const room = getUserRoom(socket.id);

      if (!room) return;

      const user = rooms[room][socket.id];

      if (!user) return;

      console.log(`${user.name} desconectou`);

      // Remove do mapa
      delete peerMap[user.peerId];

      // Remove da sala
      delete rooms[room][socket.id];

      // Remove sala vazia
      if (Object.keys(rooms[room]).length === 0) {

        delete rooms[room];

        console.log(`Sala ${room} removida`);

      } else {

        broadcastPresence(room);
      }

    } catch (e) {

      console.log('Erro disconnect:', e.message);
    }
  });

  // ================= SOCKET ERROR =================

  socket.on('error', (err) => {

    console.log('Socket error:', err);
  });
});

// ================= START =================

server.listen(PORT, () => {

  console.log(`Servidor iniciado na porta ${PORT}`);
});
