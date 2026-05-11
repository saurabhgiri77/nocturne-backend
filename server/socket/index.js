const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { handleMatchmaking } = require('./matchmaking');
const { handleSignaling } = require('./signaling');
const { handleMessages } = require('./messages');

// userId → Set<socketId>. A user with multiple tabs counts once.
const userSockets = new Map();

// Throttle broadcasts: at most one `online_count` emit per second. If a
// burst of (dis)connects happens we coalesce into a single trailing emit.
const BROADCAST_THROTTLE_MS = 1000;
let lastBroadcast = 0;
let pendingTimer = null;

const broadcastOnlineCount = (io) => {
  const now = Date.now();
  const elapsed = now - lastBroadcast;
  if (elapsed >= BROADCAST_THROTTLE_MS) {
    lastBroadcast = now;
    io.emit('online_count', { count: userSockets.size });
  } else if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      lastBroadcast = Date.now();
      io.emit('online_count', { count: userSockets.size });
    }, BROADCAST_THROTTLE_MS - elapsed);
  }
};

const initSocket = (io) => {
  // JWT auth middleware — runs before any event handler. Also rejects
  // suspended users so they can't use sockets at all (matches REST 403
  // behavior on /me + /login).
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error: no token'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      // socket.user = { id, iat, exp }
    } catch {
      return next(new Error('Authentication error: invalid token'));
    }

    try {
      const user = await User.findById(socket.user.id).select('suspendedUntil');
      if (user?.suspendedUntil && user.suspendedUntil > new Date()) {
        return next(new Error('Authentication error: account suspended'));
      }
    } catch (err) {
      // DB error — fail closed: refuse the connection rather than letting a
      // potentially-suspended user slip through.
      console.error('[socket/auth] suspension lookup failed:', err);
      return next(new Error('Authentication error: lookup failed'));
    }

    next();
  });

  io.on('connection', (socket) => {
    const userTag = String(socket.user.id || '').slice(0, 6);
    console.log(`[connect]  user=${userTag}  sock=${socket.id.slice(0, 6)}`);

    // Each connected socket joins a room named after its userId so REST
    // routes (e.g. /api/friends/:userId/request) can `io.to(userRoom(id)).emit(...)`
    // without keeping their own socketId map.
    socket.join(`user:${socket.user.id}`);

    // Online-count tracking. First socket for this user bumps the count.
    const uid = String(socket.user.id);
    let sockets = userSockets.get(uid);
    if (!sockets) {
      sockets = new Set();
      userSockets.set(uid, sockets);
    }
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);
    // Send current count to the new socket immediately so the UI doesn't
    // wait for the next throttled broadcast.
    socket.emit('online_count', { count: userSockets.size });
    if (wasOffline) broadcastOnlineCount(io);

    handleMatchmaking(io, socket);
    handleSignaling(io, socket);
    handleMessages(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] user=${userTag}  reason=${reason}`);
      const set = userSockets.get(uid);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          userSockets.delete(uid);
          broadcastOnlineCount(io);
        }
      }
    });
  });
};

module.exports = { initSocket };
