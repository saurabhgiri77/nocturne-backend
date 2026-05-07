const crypto = require('crypto');
const CallLog = require('../models/CallLog');
const User = require('../models/User');

// In-memory stores — module-level (persist for lifetime of process)
const waitingQueue = new Map(); // socketId → { socket, userId, profile, joinedAt }
const activeRooms = new Map();  // roomId   → room object

// After this long in the queue, a user's language filter "expires" — they
// become matchable with anyone, and any newcomer is allowed to pair with
// them regardless of language overlap. Prevents indefinite waits in low-
// population language buckets.
const FILTER_TIMEOUT_MS = 15000;

// Look up the public-facing profile bits we need for matchmaking +
// match_found display.
const fetchProfile = async (userId) => {
  try {
    const u = await User.findById(userId)
      .select('username displayName languages country')
      .lean();
    return {
      username: u?.username || null,
      displayName: u?.displayName || null,
      languages: Array.isArray(u?.languages) ? u.languages : [],
      country: u?.country || null,
    };
  } catch {
    return { username: null, displayName: null, languages: [], country: null };
  }
};

// Two users are language-compatible if either has no preference, or they
// share at least one language.
const sharesLanguage = (a, b) => {
  if (!a.profile.languages.length || !b.profile.languages.length) return true;
  return a.profile.languages.some((l) => b.profile.languages.includes(l));
};

// Find the first waiter in the queue that the newcomer can be paired with.
// Pair if they share a language OR if the waiter's filter has timed out.
// Newcomer is always fresh (joinedAt = now) so their own filter never
// "expires" mid-call — that's fine, the OTHER side's expiry covers them.
const findCompatible = (newcomer) => {
  const now = Date.now();
  for (const [otherSocketId, other] of waitingQueue) {
    const otherExpired = now - other.joinedAt > FILTER_TIMEOUT_MS;
    if (sharesLanguage(newcomer, other) || otherExpired) {
      return [otherSocketId, other];
    }
  }
  return null;
};

const handleMatchmaking = (io, socket) => {
  socket.on('join_queue', async () => {
    if (waitingQueue.has(socket.id)) return; // already queued

    const myProfile = await fetchProfile(socket.user.id);
    const newcomer = {
      socket,
      userId: socket.user.id,
      profile: myProfile,
      joinedAt: Date.now(),
    };

    const match = findCompatible(newcomer);

    if (match) {
      const [otherSocketId, other] = match;
      waitingQueue.delete(otherSocketId);

      const roomId = `room_${crypto.randomBytes(16).toString('hex')}`;

      const room = {
        userA: socket.id,         // initiator → createOffer()
        userB: otherSocketId,     // receiver  → createAnswer()
        userAId: socket.user.id,
        userBId: other.userId,
        startedAt: new Date(),
      };
      activeRooms.set(roomId, room);

      socket.roomId = roomId;
      other.socket.roomId = roomId;

      socket.emit('match_found', {
        roomId,
        role: 'initiator',
        peerUserId: other.userId,
        peerUsername: other.profile.username,
        peerDisplayName: other.profile.displayName,
        peerCountry: other.profile.country,
      });
      other.socket.emit('match_found', {
        roomId,
        role: 'receiver',
        peerUserId: socket.user.id,
        peerUsername: myProfile.username,
        peerDisplayName: myProfile.displayName,
        peerCountry: myProfile.country,
      });

      console.log(
        `[match] ${socket.user.id} <-> ${other.userId}  room=${roomId}  langs=${myProfile.languages.join(',') || '∅'} ∩ ${other.profile.languages.join(',') || '∅'}`
      );
    } else {
      waitingQueue.set(socket.id, newcomer);
      socket.emit('waiting', { message: 'Waiting for a match...' });
      console.log(
        `[queue] ${socket.user.id} waiting | langs=${myProfile.languages.join(',') || '∅'} | queue=${waitingQueue.size}`
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
