require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');
const WebSocket = require('ws'); // Trocamos socket.io por ws
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use(cors());

const server = http.createServer(app);

// ================= WEBSOCKET SERVER =================
const wss = WebSocket.isServer ? WebSocket : new WebSocket.Server({ server });

const rooms = new Map(); // roomName -> Map(socket -> userData)

wss.on('connection', (ws) => {
    console.log('Novo dispositivo conectado via WebSocket');
    ws.isAlive = true;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type } = data;

            switch (type) {
                case 'register':
                    const { room, peerId, name } = data;
                    ws.userData = { room, peerId, name, isTalking: false };
                    
                    if (!rooms.has(room)) rooms.set(room, new Map());
                    rooms.get(room).set(ws, ws.userData);
                    
                    console.log(`[Registro] ${name} entrou na sala: ${room}`);
                    broadcastPresence(room);
                    break;

                case 'talking_state':
                    if (ws.userData) {
                        ws.userData.isTalking = data.isTalking;
                        broadcastTalkingState(ws.userData.room, ws.userData);
                    }
                    break;
                
                // relay para WebRTC
                case 'offer':
                case 'answer':
                case 'candidate':
                    relayWebRTC(ws.userData.room, data);
                    break;
            }
        } catch (e) {
            console.error('Erro ao processar mensagem:', e.message);
        }
    });

    ws.on('close', () => {
        if (ws.userData) {
            const { room, name } = ws.userData;
            if (rooms.has(room)) {
                rooms.get(room).delete(ws);
                if (rooms.get(room).size === 0) rooms.delete(room);
                else broadcastPresence(room);
            }
            console.log(`Usuário saiu: ${name}`);
        }
    });
});

function broadcastPresence(roomName) {
    const room = rooms.get(roomName);
    if (!room) return;

    const users = Array.from(room.values()).map(u => ({
        peerId: u.peerId,
        name: u.name,
        isTalking: u.isTalking
    }));

    const message = JSON.stringify({ type: 'presence', users });
    room.forEach((_, socket) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message);
    });
}

function broadcastTalkingState(roomName, senderData) {
    const room = rooms.get(roomName);
    if (!room) return;

    const message = JSON.stringify({
        type: 'user_talking',
        peerId: senderData.peerId,
        name: senderData.name,
        isTalking: senderData.isTalking
    });

    room.forEach((_, socket) => {
        // Envia para todos na sala exceto para quem está falando
        if (socket.userData.peerId !== senderData.peerId && socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    });
}

function relayWebRTC(roomName, data) {
    const room = rooms.get(roomName);
    if (!room) return;
    const message = JSON.stringify(data);
    room.forEach((_, socket) => {
        if (socket.userData.peerId === data.to && socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    });
}

// ================= PEER SERVER & OUTROS =================
const peerServer = ExpressPeerServer(server, { debug: true, path: '/', proxied: true });
app.use('/peerjs', peerServer);
app.get('/health', (req, res) => res.status(200).send('OK'));

server.listen(PORT, '0.0.0.0', () => console.log(`Servidor WebSocket rodando na porta ${PORT}`));
