const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const socketIO = require('socket.io');
const cors = require('cors');

// ==================== CONFIGURAÇÃO ====================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');

const logger = {
  info: (msg) => console.log(`ℹ️  [INFO]`, msg),
  success: (msg) => console.log(`✅ [SUCCESS]`, msg),
  warn: (msg) => console.log(`⚠️  [WARN]`, msg),
  error: (msg) => console.error(`❌ [ERROR]`, msg)
};

// ==================== EXPRESS SETUP ====================
const app = express();

app.use(cors({
  origin: NODE_ENV === 'production' ? ALLOWED_ORIGINS : "*",
  methods: ["GET", "POST"],
  credentials: true,
  maxAge: 3600
}));

const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: NODE_ENV === 'production' ? ALLOWED_ORIGINS : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// PeerJS
const peerServer = ExpressPeerServer(server, {
  debug: NODE_ENV === 'development',
  path: '/peerjs',
  proxied: true,
  allow_discovery: false
});

app.use(peerServer);

peerServer.on('error', (err) => {
  logger.error(`PeerJS Error: ${err.message}`);
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname), { 
  maxAge: NODE_ENV === 'production' ? '1d' : 0 
}));

// ==================== ROTAS ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/grupo.html', (req, res) => res.sendFile(path.join(__dirname, 'grupo.html')));
app.get('/web-tester.html', (req, res) => res.sendFile(path.join(__dirname, 'web-tester.html')));

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length 
  });
});

// ==================== ROOM MANAGEMENT ====================
let rooms = {};

// Funções auxiliares
const getUserRoom = (socketId) => {
  for (const room in rooms) {
    if (rooms[room][socketId]) return room;
  }
  return null;
};

const broadcastPresence = (room) => {
  if (!rooms[room]) return;
  
  const userList = Object.values(rooms[room]).map(user => ({
    peerId: user.peerId,
    name: user.name,
    isTalking: user.isTalking
  }));

  io.to(room).emit('presence', userList);
  logger.info(`Presença atualizada em [${room}] → ${userList.length} usuários`);
};

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  logger.success(`Novo cliente conectado: ${socket.id}`);

  // ==================== REGISTER ====================
  socket.on('register', (data) => {
    try {
      if (!data?.room || !data?.peerId || !data?.name) {
        return socket.emit('error', { message: 'Dados incompletos' });
      }

      const { room, peerId, name } = data;
      const cleanRoom = room.trim();
      const cleanPeerId = peerId.trim();
      const cleanName = name.trim();

      socket.join(cleanRoom);

      if (!rooms[cleanRoom]) rooms[cleanRoom] = {};

      const currentRoom = rooms[cleanRoom];

      // === PREVENÇÃO DE DUPLICATAS ===
      let replaced = false;
      for (const [existingSocketId, user] of Object.entries(currentRoom)) {
        if (user.peerId === cleanPeerId || user.name.toLowerCase() === cleanName.toLowerCase()) {
          if (existingSocketId !== socket.id) {
            logger.warn(`Removendo usuário duplicado: ${user.name} (${existingSocketId})`);
            delete currentRoom[existingSocketId];
          }
          replaced = true;
        }
      }

      // Registra / Atualiza usuário
      currentRoom[socket.id] = {
        peerId: cleanPeerId,
        name: cleanName,
        isTalking: false,
        room: cleanRoom,
        joinedAt: new Date().toISOString()
      };

      logger.success(`${replaced ? '🔄 Reconectado' : '✅ Registrado'}: ${cleanName} em [${cleanRoom}]`);

      broadcastPresence(cleanRoom);
      socket.emit('registered', { success: true, reconnected: replaced });

    } catch (err) {
      logger.error(`Erro no register: ${err.message}`);
      socket.emit('error', { message: 'Erro interno ao registrar' });
    }
  });

  // ==================== OUTROS EVENTOS ====================
  socket.on('get_active_users', (callback) => {
    try {
      const userRoom = getUserRoom(socket.id);
      if (typeof callback === 'function') {
        callback(userRoom && rooms[userRoom] ? Object.values(rooms[userRoom]) : []);
      }
    } catch (err) {
      logger.error(`Erro get_active_users: ${err.message}`);
      if (typeof callback === 'function') callback([]);
    }
  });

  socket.on('talking_state', (data) => {
    try {
      if (typeof data?.isTalking !== 'boolean') return;

      const userRoom = getUserRoom(socket.id);
      if (!userRoom || !rooms[userRoom]?.[socket.id]) return;

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

  // ==================== DISCONNECT ====================
  socket.on('disconnect', () => {
    try {
      const userRoom = getUserRoom(socket.id);
      if (!userRoom || !rooms[userRoom]?.[socket.id]) return;

      const user = rooms[userRoom][socket.id];

      logger.warn(`Desconexão: ${user.name} (${socket.id})`);

      if (user.isTalking) {
        socket.to(userRoom).emit('user_talking', {
          peerId: user.peerId,
          name: user.name,
          isTalking: false
        });
      }

      delete rooms[userRoom][socket.id];

      if (Object.keys(rooms[userRoom]).length === 0) {
        delete rooms[userRoom];
        logger.info(`Sala [${userRoom}] removida (vazia)`);
      } else {
        broadcastPresence(userRoom);
      }
    } catch (err) {
      logger.error(`Erro no disconnect: ${err.message}`);
    }
  });

  socket.on('error', (err) => {
    logger.error(`Socket Error [${socket.id}]: ${err.message}`);
  });
});

// ==================== ERROR HANDLERS ====================
app.use((err, req, res, next) => {
  logger.error(`Express Error: ${err.message}`);
  res.status(500).json({ error: NODE_ENV === 'development' ? err.message : 'Erro interno' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ==================== START ====================
server.listen(PORT, () => {
  logger.success(`🚀 Servidor rodando em http://localhost:${PORT}`);
  logger.info(`Modo: ${NODE_ENV}`);
});

process.on('SIGTERM', () => { logger.warn('SIGTERM recebido'); server.close(); });
process.on('SIGINT', () => { logger.warn('SIGINT recebido'); server.close(); });
