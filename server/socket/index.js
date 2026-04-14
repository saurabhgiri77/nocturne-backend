const jwt = require('jsonwebtoken');
const { handleMatchmaking } = require('./matchmaking');
const { handleSignaling } = require('./signaling');

const initSocket = (io) => {
  // JWT auth middleware — runs before any event handler
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error: no token'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      // socket.user = { id, iat, exp }
      next();
    } catch {
      next(new Error('Authentication error: invalid token'));
    }
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
