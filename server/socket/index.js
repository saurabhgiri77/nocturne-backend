const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { handleMatchmaking } = require('./matchmaking');
const { handleSignaling } = require('./signaling');
const { handleMessages } = require('./messages');

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

    handleMatchmaking(io, socket);
    handleSignaling(io, socket);
    handleMessages(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] user=${userTag}  reason=${reason}`);
    });
  });
};

module.exports = { initSocket };
