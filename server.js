```javascript
// ==================== server.js ====================

const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const socketIO = require('socket.io');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();

const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// ==================== PEERJS ====================

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/peerjs',
  proxied: true,
  allow_discovery: false,
  pingInterval: 5000
});

app.use(peerServer);

// ==================== STATIC ====================

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== SALAS ====================

const rooms = {};
const peerMap = {};

// ==================== HELPERS ====================

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

  console.log(`Presença enviada: ${users.length} usuários`);
}

// ==================== SOCKET ====================

io.on('connection', (socket) => {

  console.log('Novo socket:', socket.id);

  // ==================== REGISTER ====================

  socket.on('register', (data) => {

    try {

      const room = data.room;
      const peerId = data.peerId;
      const name = data.name;

      socket.join(room);

      if (!rooms[room]) {
        rooms[room] = {};
      }

      rooms[room][socket.id] = {
        peerId,
        name,
        isTalking: false
      };

      // MAPEAR peerId -> socket.id
      peerMap[peerId] = socket.id;

      console.log(`${name} entrou em ${room}`);

      broadcastPresence(room);

      socket.emit('registered', {
        success: true
      });

    } catch (e) {

      console.log(e);
    }
  });

  // ==================== TALKING ====================

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

      console.log(e);
    }
  });

  // ==================== OFFER ====================

  socket.on('offer', (data) => {

    try {

      const targetSocketId = peerMap[data.to];

      if (!targetSocketId) {
        console.log('Destino offer não encontrado');
        return;
      }

      io.to(targetSocketId).emit('offer', data);

    } catch (e) {

      console.log(e);
    }
  });

  // ==================== ANSWER ====================

  socket.on('answer', (data) => {

    try {

      const targetSocketId = peerMap[data.to];

      if (!targetSocketId) {
        console.log('Destino answer não encontrado');
        return;
      }

      io.to(targetSocketId).emit('answer', data);

    } catch (e) {

      console.log(e);
    }
  });

  // ==================== CANDIDATE ====================

  socket.on('candidate', (data) => {

    try {

      const targetSocketId = peerMap[data.to];

      if (!targetSocketId) {
        console.log('Destino candidate não encontrado');
        return;
      }

      io.to(targetSocketId).emit('candidate', data);

    } catch (e) {

      console.log(e);
    }
  });

  // ==================== DISCONNECT ====================

  socket.on('disconnect', () => {

    try {

      const room = getUserRoom(socket.id);

      if (!room) return;

      const user = rooms[room][socket.id];

      if (!user) return;

      console.log(`${user.name} saiu`);

      delete peerMap[user.peerId];

      delete rooms[room][socket.id];

      if (Object.keys(rooms[room]).length === 0) {

        delete rooms[room];

      } else {

        broadcastPresence(room);
      }

    } catch (e) {

      console.log(e);
    }
  });
});

// ==================== START ====================

server.listen(PORT, () => {

  console.log(`Servidor rodando na porta ${PORT}`);
});
```
