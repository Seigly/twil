import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import redisClient from './redisClient.js';
import Twilio from 'twilio';

dotenv.config();

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors({ origin: '*' })); // allow Vercel frontend
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const twilioClient = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- In-memory fallback queues ---
const inMemoryQueues = new Map();
const activeSessions = new Map();
const abuseScores = new Map();

function makeFilterKey(filters) {
  if (!filters || Object.keys(filters).length === 0) return 'all';
  return JSON.stringify(filters);
}

async function pushWaiting(filterKey, socketId) {
  if (redisClient) {
    try {
      await redisClient.rPush(`waiting:${filterKey}`, socketId);
      await redisClient.expire(`waiting:${filterKey}`, 60 * 60);
      return;
    } catch (e) {
      console.warn('Redis push failed, using in-memory', e);
    }
  }
  const arr = inMemoryQueues.get(filterKey) || [];
  arr.push(socketId);
  inMemoryQueues.set(filterKey, arr);
}

async function popWaiting(filterKey) {
  if (redisClient) {
    try {
      return await redisClient.lPop(`waiting:${filterKey}`);
    } catch (e) {
      console.warn('Redis pop failed, using in-memory', e);
    }
  }
  const arr = inMemoryQueues.get(filterKey) || [];
  const val = arr.shift() || null;
  inMemoryQueues.set(filterKey, arr);
  return val;
}

async function removeFromQueue(filterKey, socketId) {
  if (redisClient) {
    try {
      await redisClient.lRem(`waiting:${filterKey}`, 0, socketId);
      return;
    } catch (e) {}
  }
  const arr = inMemoryQueues.get(filterKey) || [];
  inMemoryQueues.set(filterKey, arr.filter(id => id !== socketId));
}

// --- Twilio TURN route ---
app.get('/ice', async (req, res) => {
  try {
    const tokenResponse = await twilioClient.tokens.create({ ttl: 3600 });
    res.json({ iceServers: tokenResponse.ice_servers });
  } catch (err) {
    console.error('Twilio ICE error:', err);
    res.status(500).json({ error: 'Failed to get ICE servers' });
  }
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join_queue', async ({ filters } = {}) => {
    const fk = makeFilterKey(filters);
    socket.data.filterKey = fk;

    const peer = await popWaiting(fk);
    if (peer && peer !== socket.id) {
      const sessionId = 'sess_' + uuidv4();
      activeSessions.set(sessionId, { a: socket.id, b: peer });
      socket.data.sessionId = sessionId;
      const peerSock = io.sockets.sockets.get(peer);
      if (peerSock) peerSock.data.sessionId = sessionId;

      socket.emit('matched', { sessionId, peerSocketId: peer });
      io.to(peer).emit('matched', { sessionId, peerSocketId: socket.id });
      console.log('matched', socket.id, peer, '->', sessionId);
    } else {
      await pushWaiting(fk, socket.id);
      socket.emit('queued');
      console.log('queued', socket.id, 'for', fk);
    }
  });

  socket.on('leave_queue', async () => {
    const fk = socket.data.filterKey;
    if (!fk) return;
    await removeFromQueue(fk, socket.id);
    socket.emit('left_queue');
    console.log('socket left queue', socket.id);
  });

  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('relay_msg', ({ to, text }) => {
    if (!to) return;
    io.to(to).emit('relay_msg', { from: socket.id, text });
  });

  socket.on('report', ({ sessionId, reason }) => {
    const sess = activeSessions.get(sessionId);
    if (!sess) return;
    const other = sess.a === socket.id ? sess.b : sess.a;
    abuseScores.set(other, (abuseScores.get(other) || 0) + 1);
    console.log('report', { sessionId, from: socket.id, reason, other, score: abuseScores.get(other) });
    if (abuseScores.get(other) > 3) {
      const otherSock = io.sockets.sockets.get(other);
      if (otherSock) {
        otherSock.emit('kicked', { reason: 'abuse' });
        otherSock.disconnect(true);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    // cleanup in-memory queues
    for (const [key, arr] of inMemoryQueues.entries()) {
      inMemoryQueues.set(key, arr.filter(id => id !== socket.id));
    }
    // notify peer if in a session
    for (const [sid, pair] of activeSessions.entries()) {
      if (pair.a === socket.id || pair.b === socket.id) {
        const other = pair.a === socket.id ? pair.b : pair.a;
        io.to(other).emit('peer_left');
        activeSessions.delete(sid);
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

server.listen(PORT, () => console.log('Signaling server listening on', PORT));
