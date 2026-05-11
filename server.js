const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const socketIO = require('socket.io');
const cors = require('cors');

// ================= CONFIGURAÇÃO =================
const PORT = process.env.PORT || 3000;
const app = express();

// Middleware de CORS para permitir requisições do Android e Web
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"]
}));

const server = http.createServer(app);

// ================= SOCKET.IO =================
// Configurado para lidar com a instabilidade de redes móveis
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000, 
    pingInterval: 25000
});

// ================= PEER SERVER =================
// 'proxied: true' é vital para o funcionamento no Render (HTTPS)
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/myapp',
    proxied: true,
    allow_discovery: false,
    pingInterval: 5000
});

// A rota final no Android será: https://radio-grupoptt.onrender.com/peerjs/myapp
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
