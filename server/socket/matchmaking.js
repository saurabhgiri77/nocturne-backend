const crypto = require('crypto');
const CallLog = require('../models/CallLog');
const User = require('../models/User');
const { checkSocketLimit } = require('./rateLimit');

// Truncate a user ID for logging — first 6 hex chars is enough to debug a
// session without leaving full PII in log aggregators.
const tag = (id) => (id ? String(id).slice(0, 6) : '?');

// In-memory stores — module-level (persist for lifetime of process)
const waitingQueue = new Map(); // socketId → { socket, userId, profile, joinedAt }
const activeRooms = new Map();  // roomId   → room object

// Tiered soft-fallback. The newcomer is always fresh; the WAITER's age
// determines how strict we are:
//   - waiter < 10s  → require shared language AND shared interest
//   - waiter 10–15s → require shared language only (interest expired)
//   - waiter ≥ 15s  → match anyone (both expired)
const FILTER_TIMEOUT_MS = 15000;
const INTEREST_TIMEOUT_MS = 10000;

// Look up the public-facing profile bits we need for matchmaking +
// match_found display.
const fetchProfile = async (userId) => {
  try {
    const u = await User.findById(userId)
      .select('username displayName languages country interests')
      .lean();
    return {
      username: u?.username || null,
      displayName: u?.displayName || null,
      languages: Array.isArray(u?.languages) ? u.languages : [],
      country: u?.country || null,
      interests: Array.isArray(u?.interests) ? u.interests : [],
    };
  } catch {
    return { username: null, displayName: null, languages: [], country: null, interests: [] };
  }
};

// Empty preference on either side = "match anyone" (doesn't fragment the
// queue further); otherwise need ≥1 overlap.
const sharesLanguage = (a, b) => {
  if (!a.profile.languages.length || !b.profile.languages.length) return true;
  return a.profile.languages.some((l) => b.profile.languages.includes(l));
};
const sharesInterest = (a, b) => {
  if (!a.profile.interests.length || !b.profile.interests.length) return true;
  return a.profile.interests.some((i) => b.profile.interests.includes(i));
};

// Pick the first queued waiter that meets the tiered compatibility bar.
const findCompatible = (newcomer) => {
  const now = Date.now();
  for (const [otherSocketId, other] of waitingQueue) {
    const waitedFor = now - other.joinedAt;
    const langOk = sharesLanguage(newcomer, other) || waitedFor > FILTER_TIMEOUT_MS;
    const interestOk = sharesInterest(newcomer, other) || waitedFor > INTEREST_TIMEOUT_MS;
    if (langOk && interestOk) {
      return [otherSocketId, other];
    }
  }
  return null;
};

const handleMatchmaking = (io, socket) => {
  socket.on('join_queue', async () => {
    if (!checkSocketLimit(socket, 'join_queue')) return;
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
        peerInterests: other.profile.interests,
      });
      other.socket.emit('match_found', {
        roomId,
        role: 'receiver',
        peerUserId: socket.user.id,
        peerUsername: myProfile.username,
        peerDisplayName: myProfile.displayName,
        peerCountry: myProfile.country,
        peerInterests: myProfile.interests,
      });

      console.log(
        `[match] ${tag(socket.user.id)} <-> ${tag(other.userId)}  langs=${myProfile.languages.join(',') || '∅'} ∩ ${other.profile.languages.join(',') || '∅'}  interests=${myProfile.interests.join(',') || '∅'} ∩ ${other.profile.interests.join(',') || '∅'}`
      );
    } else {
      waitingQueue.set(socket.id, newcomer);
      socket.emit('waiting', { message: 'Waiting for a match...' });
      console.log(
        `[queue] ${tag(socket.user.id)} waiting | langs=${myProfile.languages.join(',') || '∅'} | queue=${waitingQueue.size}`
      );
    }
  });

  socket.on('leave_queue', () => {
    if (!checkSocketLimit(socket, 'leave_queue')) return;
    waitingQueue.delete(socket.id);
    socket.emit('left_queue');
  });

  socket.on('disconnect', async () => {
    waitingQueue.delete(socket.id);

    if (socket.roomId) {
      const roomIdAtDisconnect = socket.roomId;
      const room = activeRooms.get(roomIdAtDisconnect);
      if (room) {
        const peerSocketId =
          room.userA === socket.id ? room.userB : room.userA;
        const peer = io.sockets.sockets.get(peerSocketId);
        if (peer) {
          // Include roomId so the recipient can ignore the event if they've
          // already moved on (e.g. raced with their own skip).
          peer.emit('peer_disconnected', { roomId: roomIdAtDisconnect });
          peer.roomId = null;
        }
        await saveCallLog(room, 'disconnect');
        activeRooms.delete(roomIdAtDisconnect);
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
