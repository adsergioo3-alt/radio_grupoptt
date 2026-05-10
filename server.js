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

// Logger utility
const logger = {
  info: (msg) => console.log(`ℹ️  [INFO]`, msg),
  success: (msg) => console.log(`✅ [SUCCESS]`, msg),
  warn: (msg) => console.log(`⚠️  [WARN]`, msg),
  error: (msg) => console.error(`❌ [ERROR]`, msg)
};

// ==================== EXPRESS SETUP ====================
const app = express();

// CORS configuration com segurança melhorada
app.use(cors({
  origin: NODE_ENV === 'production' ? ALLOWED_ORIGINS : "*",
  methods: ["GET", "POST"],
  credentials: true,
  maxAge: 3600
}));

const server = http.createServer(app);

// Socket.io configuration com tratamento de erros
const io = socketIO(server, {
  cors: {
    origin: NODE_ENV === 'production' ? ALLOWED_ORIGINS : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6
});

// PeerJS server configuration
const peerServer = ExpressPeerServer(server, {
  debug: NODE_ENV === 'development',
  path: '/peerjs',
  proxied: true,
  allow_discovery: false // Segurança: desabilitar descoberta
});

app.use(peerServer);

// Error handler para PeerJS
peerServer.on('error', (err) => {
  logger.error(`PeerJS Error: ${err.message}`);
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname), { 
  maxAge: NODE_ENV === 'production' ? '1d' : 0 
}));

// ==================== ROTAS ====================
app.get('/', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'index.html'));
  } catch (err) {
    logger.error(`Erro ao servir index.html: ${err.message}`);
    res.status(500).send('Erro ao carregar página');
  }
});

app.get('/grupo.html', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'grupo.html'));
  } catch (err) {
    logger.error(`Erro ao servir grupo.html: ${err.message}`);
    res.status(500).send('Erro ao carregar página');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length 
  });
});

// ==================== ROOM MANAGEMENT ====================
let rooms = {};

// Funções auxiliares com tratamento de erros
const getUserRoom = (socketId) => {
  try {
    for (const room in rooms) {
      if (rooms[room][socketId]) {
        return room;
      }
    }
  } catch (err) {
    logger.error(`Erro ao obter room do usuário: ${err.message}`);
  }
  return null;
};

const broadcastPresence = (room) => {
  try {
    if (rooms[room]) {
      const userList = Object.values(rooms[room]);
      io.to(room).emit('presence', userList);
      logger.info(`Presença atualizada para sala: ${room} (${userList.length} usuários)`);
    }
  } catch (err) {
    logger.error(`Erro ao broadcast presença: ${err.message}`);
  }
};

const validateRegistrationData = (data) => {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Dados inválidos' };
  }

  const { room, peerId, name } = data;

  if (!room || typeof room !== 'string' || room.trim().length === 0) {
    return { valid: false, error: 'Room inválida' };
  }

  if (!peerId || typeof peerId !== 'string' || peerId.trim().length === 0) {
    return { valid: false, error: 'PeerId inválido' };
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { valid: false, error: 'Nome inválido' };
  }

  return { valid: true };
};

// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
  logger.success(`Novo cliente conectado: ${socket.id}`);

  // EVENT: Usuário se registra em uma sala
  socket.on('register', (data) => {
    try {
      const validation = validateRegistrationData(data);
      
      if (!validation.valid) {
        logger.warn(`Registro inválido: ${validation.error}`);
        socket.emit('error', { message: validation.error });
        return;
      }

      const { room, peerId, name } = data;

      socket.join(room);

      if (!rooms[room]) {
        rooms[room] = {};
      }

      rooms[room][socket.id] = {
        peerId: peerId.trim(),
        name: name.trim(),
        isTalking: false,
        room: room,
        joinedAt: new Date().toISOString()
      };

      logger.success(`Usuário registrado em [${room}]: ${name} (${peerId})`);
      broadcastPresence(room);

      socket.emit('registered', { success: true });
    } catch (err) {
      logger.error(`Erro no registro: ${err.message}`);
      socket.emit('error', { message: 'Erro ao registrar' });
    }
  });

  // EVENT: Obter lista de usuários ativos
  socket.on('get_active_users', (callback) => {
    try {
      const userRoom = getUserRoom(socket.id);
      if (typeof callback !== 'function') {
        logger.warn('Callback de get_active_users não é uma função');
        return;
      }

      if (userRoom && rooms[userRoom]) {
        const userList = Object.values(rooms[userRoom]);
        callback(userList);
        logger.info(`Lista de usuários enviada para ${socket.id}: ${userList.length} usuários`);
      } else {
        callback([]);
      }
    } catch (err) {
      logger.error(`Erro ao obter usuários ativos: ${err.message}`);
      if (typeof callback === 'function') {
        callback([]);
      }
    }
  });

  // EVENT: Atualizar estado de fala (talking state)
  socket.on('talking_state', (data) => {
    try {
      if (!data || typeof data.isTalking !== 'boolean') {
        logger.warn('Dados de talking_state inválidos');
        return;
      }

      const userRoom = getUserRoom(socket.id);

      if (userRoom && rooms[userRoom] && rooms[userRoom][socket.id]) {
        rooms[userRoom][socket.id].isTalking = data.isTalking;
        
        socket.to(userRoom).emit('user_talking', {
          peerId: rooms[userRoom][socket.id].peerId,
          name: rooms[userRoom][socket.id].name,
          isTalking: data.isTalking
        });

        broadcastPresence(userRoom);
        logger.info(`Usuário ${rooms[userRoom][socket.id].name} está ${data.isTalking ? 'falando' : 'silencioso'}`);
      }
    } catch (err) {
      logger.error(`Erro ao atualizar talking state: ${err.message}`);
    }
  });

  // EVENT: Desconexão
  socket.on('disconnect', () => {
    try {
      const userRoom = getUserRoom(socket.id);

      if (userRoom && rooms[userRoom] && rooms[userRoom][socket.id]) {
        const user = rooms[userRoom][socket.id];
        logger.warn(`Usuário desconectado de [${userRoom}]: ${user.name}`);

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
          logger.info(`Sala [${userRoom}] foi deletada (vazia)`);
        } else {
          broadcastPresence(userRoom);
        }
      }
    } catch (err) {
      logger.error(`Erro ao processar desconexão: ${err.message}`);
    }
  });

  // EVENT: Tratamento de erros de socket
  socket.on('error', (error) => {
    logger.error(`Erro de Socket [${socket.id}]: ${error.message}`);
  });
});

// ==================== GLOBAL ERROR HANDLERS ====================

// Error handler para Express
app.use((err, req, res, next) => {
  logger.error(`Express Error: ${err.message}`);
  res.status(err.status || 500).json({
    error: NODE_ENV === 'development' ? err.message : 'Erro interno do servidor'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ==================== SERVER STARTUP ====================
server.listen(PORT, () => {
  logger.success(`🚀 Servidor rodando em http://localhost:${PORT}`);
  logger.info(`Modo: ${NODE_ENV}`);
  logger.info(`CORS Origins: ${NODE_ENV === 'production' ? ALLOWED_ORIGINS.join(', ') : 'Todos'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.warn('SIGTERM recebido, encerrando servidor...');
  server.close(() => {
    logger.success('Servidor encerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.warn('SIGINT recebido, encerrando servidor...');
  server.close(() => {
    logger.success('Servidor encerrado');
    process.exit(0);
  });
});

// Uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection em ${promise}: ${reason}`);
});