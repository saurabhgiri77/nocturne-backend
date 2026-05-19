const crypto = require('crypto');
const CallLog = require('../models/CallLog');
const User = require('../models/User');
const Friendship = require('../models/Friendship');
const { checkSocketLimit } = require('./rateLimit');

// Truncate a user ID for logging — first 6 hex chars is enough to debug a
// session without leaving full PII in log aggregators.
const tag = (id) => (id ? String(id).slice(0, 6) : '?');

// In-memory stores — module-level (persist for lifetime of process)
const waitingQueue = new Map(); // socketId → { socket, userId, profile, joinedAt, retryTimer }
const activeRooms = new Map();  // roomId   → room object

// Soft-fallback timeouts. Compatibility is SYMMETRIC (max of both parties'
// ages), so once either user has been queued past the threshold, the
// corresponding filter relaxes for both:
//   - max age < 10s  → require shared language AND shared interest
//   - max age 10–15s → require shared language only
//   - max age ≥ 15s  → match anyone (both expired)
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

// Symmetric compatibility check. Uses the OLDER of the two waits to decide
// when filters expire — so two queued users who have BOTH been waiting >15s
// will match each other (the bug fixed here was only checking the waiter's
// age, never the newcomer/scanner's, which meant queued pairs never timed
// out into a match unless a third user arrived).
const isCompatible = (a, b) => {
  const now = Date.now();
  const maxAge = Math.max(now - a.joinedAt, now - b.joinedAt);
  const langOk = sharesLanguage(a, b) || maxAge > FILTER_TIMEOUT_MS;
  const interestOk = sharesInterest(a, b) || maxAge > INTEREST_TIMEOUT_MS;
  return langOk && interestOk;
};

// Find the first queued user (other than `entry`) compatible with `entry`.
const findCompatibleFor = (entry) => {
  for (const [otherId, other] of waitingQueue) {
    if (other.socket.id === entry.socket.id) continue;
    if (isCompatible(entry, other)) return [otherId, other];
  }
  return null;
};

// Pair two queue entries: build a room, wire up roomIds, emit match_found
// to both sides. `a` is the initiator (creates the offer).
const pairUsers = async (a, b) => {
  const roomId = `room_${crypto.randomBytes(16).toString('hex')}`;
  const room = {
    userA: a.socket.id,
    userB: b.socket.id,
    userAId: a.userId,
    userBId: b.userId,
    startedAt: new Date(),
  };
  activeRooms.set(roomId, room);
  a.socket.roomId = roomId;
  b.socket.roomId = roomId;

  // Surface existing friendship to the client so the in-call "Add Friend"
  // button reflects the existing relationship instead of inviting a
  // duplicate request. Single fast indexed lookup; failure is non-fatal —
  // we fall back to isFriend=false rather than blocking the match emit.
  let isFriend = false;
  try {
    const friendship = await Friendship.findOne({
      status: 'accepted',
      $or: [
        { requester: a.userId, recipient: b.userId },
        { requester: b.userId, recipient: a.userId },
      ],
    }).select('_id').lean();
    isFriend = !!friendship;
  } catch (err) {
    console.error('[match] friendship lookup failed:', err);
  }

  const payloadFor = (peerEntry) => ({
    peerUserId: peerEntry.userId,
    peerUsername: peerEntry.profile.username,
    peerDisplayName: peerEntry.profile.displayName,
    peerCountry: peerEntry.profile.country,
    peerInterests: peerEntry.profile.interests,
    isFriend,
  });

  a.socket.emit('match_found', { roomId, role: 'initiator', ...payloadFor(b) });
  b.socket.emit('match_found', { roomId, role: 'receiver',  ...payloadFor(a) });

  console.log(
    `[match] ${tag(a.userId)} <-> ${tag(b.userId)}  langs=${a.profile.languages.join(',') || '∅'} ∩ ${b.profile.languages.join(',') || '∅'}  interests=${a.profile.interests.join(',') || '∅'} ∩ ${b.profile.interests.join(',') || '∅'}`
  );
};

// Remove an entry from the queue and clear its retry timer if any.
const dequeue = (socketId) => {
  const entry = waitingQueue.get(socketId);
  if (entry?.retryTimer) clearTimeout(entry.retryTimer);
  waitingQueue.delete(socketId);
  return entry;
};

// Periodic per-user retry. When a user has been queued long enough that
// their filters expire, we re-scan the queue from THEIR perspective. Without
// this, two queued users with no overlap would sit forever even if both
// passed the 15s threshold (they were never the "newcomer" again).
const scheduleRetry = (entry, delay) => {
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entry.retryTimer = setTimeout(() => attemptMatchFor(entry.socket.id), delay);
};

const attemptMatchFor = (socketId) => {
  const entry = waitingQueue.get(socketId);
  if (!entry) return; // already paired or left
  const match = findCompatibleFor(entry);
  if (match) {
    const [otherId, other] = match;
    dequeue(socketId);
    dequeue(otherId);
    pairUsers(entry, other).catch((err) => console.error('[match] pairUsers failed:', err));
    return;
  }
  // Still no match. Try again after another full window. Stops naturally
  // when the user pairs (dequeue) or disconnects.
  scheduleRetry(entry, FILTER_TIMEOUT_MS);
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

    // Try immediate pairing.
    const match = findCompatibleFor(newcomer);
    if (match) {
      const [otherSocketId, other] = match;
      dequeue(otherSocketId);
      pairUsers(newcomer, other).catch((err) => console.error('[match] pairUsers failed:', err));
      return;
    }

    // No match — queue + schedule first retry just past the language
    // expiry threshold so the symmetric check kicks in.
    waitingQueue.set(socket.id, newcomer);
    scheduleRetry(newcomer, FILTER_TIMEOUT_MS + 100);
    socket.emit('waiting', { message: 'Waiting for a match...' });
    console.log(
      `[queue] ${tag(socket.user.id)} waiting | langs=${myProfile.languages.join(',') || '∅'} | queue=${waitingQueue.size}`
    );
  });

  socket.on('leave_queue', () => {
    if (!checkSocketLimit(socket, 'leave_queue')) return;
    dequeue(socket.id);
    socket.emit('left_queue');
  });

  socket.on('disconnect', async () => {
    dequeue(socket.id);

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
