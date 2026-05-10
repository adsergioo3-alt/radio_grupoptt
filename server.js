const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const socketIO = require('socket.io');
const cors = require('cors');

// ==================== CONFIGURAÇÃO ====================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:3000'
).split(',');

const logger = {
  info: (msg) => console.log(`ℹ️ [INFO]`, msg),
  success: (msg) => console.log(`✅ [SUCCESS]`, msg),
  warn: (msg) => console.log(`⚠️ [WARN]`, msg),
  error: (msg) => console.error(`❌ [ERROR]`, msg)
};

// ==================== EXPRESS ====================
const app = express();

app.use(cors({
  origin: NODE_ENV === 'production'
    ? ALLOWED_ORIGINS
    : "*",
  methods: ["GET", "POST"],
  credentials: true,
  maxAge: 3600
}));

const server = http.createServer(app);

// ==================== SOCKET.IO ====================
const io = socketIO(server, {
  cors: {
    origin: NODE_ENV === 'production'
      ? ALLOWED_ORIGINS
      : "*",
    methods: ["GET", "POST"],
    credentials: true
  },

  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// ==================== PEERJS ====================
const peerServer = ExpressPeerServer(server, {
  debug: NODE_ENV === 'development',
  path: '/peerjs',
  proxied: true,
  allow_discovery: false,
  pingInterval: 5000
});

app.use(peerServer);

peerServer.on('error', (err) => {
  logger.error(`PeerJS Error: ${err.message}`);
});

// ==================== ESTÁTICOS ====================
app.use(express.static(path.join(__dirname), {
  maxAge: NODE_ENV === 'production'
    ? '1d'
    : 0
}));

// ==================== ROTAS ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/grupo.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'grupo.html'));
});

app.get('/web-tester.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'web-tester.html'));
});

app.get('/health', (req, res) => {

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length
  });
});

// ==================== SALAS ====================
let rooms = {};

// Buscar sala do usuário
const getUserRoom = (socketId) => {

  for (const room in rooms) {

    if (rooms[room][socketId]) {
      return room;
    }
  }

  return null;
};

// Atualizar presença
const broadcastPresence = (room) => {

  if (!rooms[room]) return;

  const userList = Object.values(rooms[room]).map(user => ({
    peerId: user.peerId,
    name: user.name,
    isTalking: user.isTalking
  }));

  io.to(room).emit('presence', userList);

  logger.info(
    `Presença atualizada em [${room}] → ${userList.length} usuários`
  );
};

// ==================== SOCKET CONNECTION ====================
io.on('connection', (socket) => {

  logger.success(`Novo cliente conectado: ${socket.id}`);

  // ==================== REGISTER ====================
  socket.on('register', (data) => {

    try {

      if (!data?.room || !data?.peerId || !data?.name) {

        return socket.emit('error', {
          message: 'Dados incompletos'
        });
      }

      const room = data.room.trim();
      const peerId = data.peerId.trim();
      const name = data.name.trim();

      socket.join(room);

      if (!rooms[room]) {
        rooms[room] = {};
      }

      const currentRoom = rooms[room];

      // ==================== EVITAR DUPLICADOS ====================
      let replaced = false;

      for (const [existingSocketId, user] of Object.entries(currentRoom)) {

        if (
          user.peerId === peerId ||
          user.name.toLowerCase() === name.toLowerCase()
        ) {

          if (existingSocketId !== socket.id) {

            logger.warn(
              `Usuário duplicado removido: ${user.name}`
            );

            delete currentRoom[existingSocketId];
          }

          replaced = true;
        }
      }

      // ==================== REGISTRAR ====================
      currentRoom[socket.id] = {
        peerId,
        name,
        room,
        isTalking: false,
        joinedAt: new Date().toISOString()
      };

      logger.success(
        `${replaced ? '🔄 Reconectado' : '✅ Registrado'}: ${name} em [${room}]`
      );

      // Atualizar presença
      broadcastPresence(room);

      socket.emit('registered', {
        success: true,
        reconnected: replaced
      });

    } catch (err) {

      logger.error(`Erro register: ${err.message}`);

      socket.emit('error', {
        message: 'Erro interno'
      });
    }
  });

  // ==================== USUÁRIOS ATIVOS ====================
  socket.on('get_active_users', (callback) => {

    try {

      const userRoom = getUserRoom(socket.id);

      if (typeof callback === 'function') {

        callback(
          userRoom && rooms[userRoom]
            ? Object.values(rooms[userRoom])
            : []
        );
      }

    } catch (err) {

      logger.error(`Erro get_active_users: ${err.message}`);

      if (typeof callback === 'function') {
        callback([]);
      }
    }
  });

  // ==================== TALKING ====================
  socket.on('talking_state', (data) => {

    try {

      if (typeof data?.isTalking !== 'boolean') {
        return;
      }

      const userRoom = getUserRoom(socket.id);

      if (!userRoom || !rooms[userRoom]?.[socket.id]) {
        return;
      }

      const user = rooms[userRoom][socket.id];

      user.isTalking = data.isTalking;

      socket.to(userRoom).emit('user_talking', {
        peerId: user.peerId,
        name: user.name,
        isTalking: data.isTalking
      });

      broadcastPresence(userRoom);

    } catch (err) {

      logger.error(`Erro talking_state: ${err.message}`);
    }
  });

  // ==================== RELÉ WEBRTC ====================
  // Compatível Android + Web + PeerJS

  socket.on('offer', (data) => {

    try {

      const target = data.to || getUserRoom(socket.id);

      if (!target) return;

      socket.to(target).emit('offer', data);

    } catch (err) {

      logger.error(`Erro offer: ${err.message}`);
    }
  });

  socket.on('answer', (data) => {

    try {

      const target = data.to || getUserRoom(socket.id);

      if (!target) return;

      socket.to(target).emit('answer', data);

    } catch (err) {

      logger.error(`Erro answer: ${err.message}`);
    }
  });

  socket.on('candidate', (data) => {

    try {

      const target = data.to || getUserRoom(socket.id);

      if (!target) return;

      socket.to(target).emit('candidate', data);

    } catch (err) {

      logger.error(`Erro candidate: ${err.message}`);
    }
  });

  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {

    try {

      const userRoom = getUserRoom(socket.id);

      if (!userRoom || !rooms[userRoom]?.[socket.id]) {
        return;
      }

      const user = rooms[userRoom][socket.id];

      logger.warn(
        `Desconectado: ${user.name} (${socket.id})`
      );

      // Remover indicador de fala
      if (user.isTalking) {

        socket.to(userRoom).emit('user_talking', {
          peerId: user.peerId,
          name: user.name,
          isTalking: false
        });
      }

      // Remover usuário
      delete rooms[userRoom][socket.id];

      // Remover sala vazia
      if (Object.keys(rooms[userRoom]).length === 0) {

        delete rooms[userRoom];

        logger.info(
          `Sala [${userRoom}] removida`
        );

      } else {

        broadcastPresence(userRoom);
      }

    } catch (err) {

      logger.error(`Erro disconnect: ${err.message}`);
    }
  });

  // ==================== SOCKET ERROR ====================
  socket.on('error', (err) => {

    logger.error(
      `Socket Error [${socket.id}]: ${err.message}`
    );
  });
});

// ==================== EXPRESS ERROR ====================
app.use((err, req, res, next) => {

  logger.error(`Express Error: ${err.message}`);

  res.status(500).json({
    error: NODE_ENV === 'development'
      ? err.message
      : 'Erro interno'
  });
});

// ==================== 404 ====================
app.use((req, res) => {

  res.status(404).json({
    error: 'Rota não encontrada'
  });
});

// ==================== START ====================
server.listen(PORT, () => {

  logger.success(
    `🚀 Servidor rodando em http://localhost:${PORT}`
  );

  logger.info(`Modo: ${NODE_ENV}`);
});

// ==================== FINALIZAÇÃO ====================
process.on('SIGTERM', () => {

  logger.warn('SIGTERM recebido');

  server.close();
});

process.on('SIGINT', () => {

  logger.warn('SIGINT recebido');

  server.close();
});
