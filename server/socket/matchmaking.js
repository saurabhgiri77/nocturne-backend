const CallLog = require('../models/CallLog');

// In-memory stores — module-level (persist for lifetime of process)
const waitingQueue = new Map(); // key: socketId, value: { socket, userId }
const activeRooms = new Map(); // key: roomId,   value: room object

const handleMatchmaking = (io, socket) => {
  socket.on('join_queue', () => {
    if (waitingQueue.has(socket.id)) return; // already queued, ignore duplicate

    if (waitingQueue.size > 0) {
      // ── Pair with first waiting user ──
      const [waitingSocketId, waitingData] = waitingQueue.entries().next().value;
      waitingQueue.delete(waitingSocketId);

      const roomId = `room__${Date.now()}`;

      const room = {
        userA: socket.id, // initiator → will createOffer()
        userB: waitingSocketId, // receiver  → will createAnswer()
        userAId: socket.user.id,
        userBId: waitingData.userId,
        startedAt: new Date(),
      };
      activeRooms.set(roomId, room);

      socket.roomId = roomId;
      waitingData.socket.roomId = roomId;

      socket.emit('match_found', { roomId, role: 'initiator' });
      waitingData.socket.emit('match_found', { roomId, role: 'receiver' });

      console.log(
        `[match] ${socket.user.id} <-> ${waitingData.userId}  room=${roomId}`
      );
    } else {
      // ── Queue empty — wait ──
      waitingQueue.set(socket.id, { socket, userId: socket.user.id });
      socket.emit('waiting', { message: 'Waiting for a match...' });
      console.log(
        `[queue] ${socket.user.id} waiting | queue=${waitingQueue.size}`
      );
    }
  });

  socket.on('leave_queue', () => {
    waitingQueue.delete(socket.id);
    socket.emit('left_queue');
  });

  socket.on('disconnect', async () => {
    waitingQueue.delete(socket.id);

    if (socket.roomId) {
      const room = activeRooms.get(socket.roomId);
      if (room) {
        const peerSocketId =
          room.userA === socket.id ? room.userB : room.userA;
        const peer = io.sockets.sockets.get(peerSocketId);
        if (peer) {
          peer.emit('peer_disconnected');
          peer.roomId = null;
        }
        await saveCallLog(room, 'disconnect');
        activeRooms.delete(socket.roomId);
      }
    }
  });
};

const saveCallLog = async (room, endedBy) => {
  try {
    const endedAt = new Date();
    const durationSeconds = Math.floor((endedAt - room.startedAt) / 1000);
    await CallLog.create({
      userA: room.userAId,
      userB: room.userBId,
      startedAt: room.startedAt,
      endedAt,
      durationSeconds,
      endedBy,
    });
    console.log(`[log] saved  dur=${durationSeconds}s  by=${endedBy}`);
  } catch (err) {
    console.error('[log] failed:', err.message);
  }
};

module.exports = { handleMatchmaking, activeRooms, saveCallLog };
