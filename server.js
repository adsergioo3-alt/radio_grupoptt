require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const socketIO = require('socket.io');
const cors = require('cors');

// ================= CONFIGURAÇÃO =================
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean) : [];
const app = express();

app.use(express.json());

// Middleware de CORS para permitir requisições do Android e Web
app.use(cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*',
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

const server = http.createServer(app);

// ================= SOCKET.IO =================
// Configurado para lidar com a instabilidade de redes móveis
const io = socketIO(server, {
    cors: {
        origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*',
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});
// ================= LOG SYSTEM =================
const systemLogs = [];
const MAX_LOGS = 100; // Mantém apenas os últimos 100 na memória

function addLog(type, message) {
    const logEntry = {
        time: new Date().toLocaleTimeString(),
        type, // 'info', 'error', 'connection'
        message
    };
    systemLogs.push(logEntry);
    if (systemLogs.length > MAX_LOGS) systemLogs.shift();
    
    // Envia em tempo real para quem estiver na página de logs
    io.to('admin-logs').emit('new-log', logEntry);
}

// Middleware para capturar logs do console (opcional, mas recomendado)
const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
    addLog('info', args.join(' '));
    originalLog.apply(console, args);
};

console.error = (...args) => {
    addLog('error', args.join(' '));
    originalError.apply(console, args);
};

// Rota para servir a página de logs do painel admin
app.get('/admin/logs', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'logs.html'));
});

// ================= PEER SERVER =================
// 'proxied: true' é vital para o funcionamento no Render (HTTPS)
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/',
    proxied: true,
    allow_discovery: false,
    pingInterval: 5000
});

app.use('/peerjs', peerServer);

// ================= DATA STORAGE =================
const rooms = new Map();
const peerMap = new Map(); // Mapeia peerId -> socket.id

// ================= HELPERS =================
function getUserRoom(socketId) {
    for (const [roomName, users] of rooms.entries()) {
        if (users[socketId]) return roomName;
    }
    return null;
}

function broadcastPresence(room) {
    const roomData = rooms.get(room);
    if (!roomData) return;

    const users = Object.values(roomData).map(user => ({
        peerId: user.peerId,
        name: user.name,
        isTalking: user.isTalking
    }));

    io.to(room).emit('presence', users);
    console.log(`[Sala: ${room}] Usuários ativos: ${users.length}`);
}

// ================= SOCKET CONNECTION =================
io.on('connection', (socket) => {
    console.log(`Novo dispositivo conectado: ${socket.id}`);

    socket.on('subscribe-logs', () => {
        socket.join('admin-logs');
        socket.emit('initial-logs', systemLogs);
    });

    socket.on('error', (err) => {
        console.error('Socket.IO error:', err);
    });

    // --- Registrar Usuário ---
    socket.on('register', (data) => {
        try {
            const { room, peerId, name } = data;
            if (!room || !peerId || !name) return;

            socket.join(room);

            if (!rooms.has(room)) {
                rooms.set(room, {});
            }

            rooms.get(room)[socket.id] = {
                peerId,
                name,
                isTalking: false
            };

            peerMap.set(peerId, socket.id);
            
            console.log(`[Registro] ${name} entrou na sala: ${room}`);
            broadcastPresence(room);

            socket.emit('registered', { success: true });

        } catch (e) {
            console.error('Erro no registro:', e.message);
        }
    });

    // --- Estado de Fala (PTT) ---
    socket.on('talking_state', (data) => {
        const roomName = getUserRoom(socket.id);
        if (!roomName) return;

        const roomData = rooms.get(roomName);
        if (roomData && roomData[socket.id]) {
            roomData[socket.id].isTalking = data.isTalking;

            // Avisa os outros usuários da sala
            socket.to(roomName).emit('user_talking', {
                peerId: roomData[socket.id].peerId,
                name: roomData[socket.id].name,
                isTalking: data.isTalking
            });
        }
    });

    // --- Sinalização WebRTC (Relay) ---
    const relayEvents = ['offer', 'answer', 'candidate'];
    relayEvents.forEach(eventName => {
        socket.on(eventName, (data) => {
            const targetSocketId = peerMap.get(data.to);
            if (targetSocketId) {
                io.to(targetSocketId).emit(eventName, data);
            }
        });
    });

    // --- Desconexão ---
    socket.on('disconnect', () => {
        const roomName = getUserRoom(socket.id);
        if (!roomName) return;

        const roomData = rooms.get(roomName);
        const user = roomData[socket.id];

        if (user) {
            console.log(`Usuário saiu: ${user.name}`);
            peerMap.delete(user.peerId);
            delete roomData[socket.id];

            if (Object.keys(roomData).length === 0) {
                rooms.delete(roomName);
            } else {
                broadcastPresence(roomName);
            }
        }
    });
});

// ================= ROTAS DE APOIO =================

// Rota de saúde para o Render (evita que o serviço seja marcado como offline)
app.get('/health', (req, res) => {
    res.status(200).send('Server is Up');
});

// Fallback para arquivos estáticos (se houver um index.html na raiz)
app.use(express.static(path.join(__dirname)));

// ================= START =================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
