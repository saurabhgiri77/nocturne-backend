const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { handleMatchmaking } = require('./matchmaking');
const { handleSignaling } = require('./signaling');

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
    console.log(`[connect]  userId=${socket.user.id}  socketId=${socket.id}`);

    handleMatchmaking(io, socket);
    handleSignaling(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] userId=${socket.user.id}  reason=${reason}`);
    });
  });
};

module.exports = { initSocket };
