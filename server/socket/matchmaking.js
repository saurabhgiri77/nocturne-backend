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

// Per-fingerprint match counters for guest sessions. Tracks both how many
// matches a guest has consumed in their current token's lifetime AND a
// rolling 24h counter so a guest can't reset by re-requesting a fresh
// guest token. Both maps are best-effort and live in-process; surviving
// across restarts isn't required for v1.
const guestSessionMatches = new Map(); // gid    → count this token
const guestDailyMatches   = new Map(); // fpHash → { count, resetAt }
const GUEST_MAX_PER_SESSION = 3;
const GUEST_MAX_PER_DAY     = 30;
const GUEST_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

const isGuestSocket = (socket) => !!socket?.user?.guest;

const guestDailyEntry = (fp) => {
  if (!fp) return { count: 0, resetAt: Date.now() + GUEST_DAILY_WINDOW_MS };
  let row = guestDailyMatches.get(fp);
  if (!row || row.resetAt <= Date.now()) {
    row = { count: 0, resetAt: Date.now() + GUEST_DAILY_WINDOW_MS };
    guestDailyMatches.set(fp, row);
  }
  return row;
};

const guestRemainingMatches = (socket) => {
  if (!isGuestSocket(socket)) return Infinity;
  const sessionCount = guestSessionMatches.get(socket.user.gid) || 0;
  const sessionLeft = Math.max(0, GUEST_MAX_PER_SESSION - sessionCount);
  const daily = guestDailyEntry(socket.user.fp);
  const dailyLeft = Math.max(0, GUEST_MAX_PER_DAY - daily.count);
  return Math.min(sessionLeft, dailyLeft);
};

const incrementGuestMatchUsage = (socket) => {
  if (!isGuestSocket(socket)) return;
  const gid = socket.user.gid;
  guestSessionMatches.set(gid, (guestSessionMatches.get(gid) || 0) + 1);
  const daily = guestDailyEntry(socket.user.fp);
  daily.count += 1;
};

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

// Guest sockets don't have a User row to query — return a blank profile so
// they match anyone. No language / interest filters; their match_found
// shows up to the peer as a no-name "Stranger".
const guestProfile = () => ({
  username: null,
  displayName: null,
  languages: [],
  country: null,
  interests: [],
  isGuest: true,
});

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
  const aIsGuest = isGuestSocket(a.socket);
  const bIsGuest = isGuestSocket(b.socket);
  const room = {
    userA: a.socket.id,
    userB: b.socket.id,
    userAId: a.userId,
    userBId: b.userId,
    aIsGuest,
    bIsGuest,
    startedAt: new Date(),
  };
  activeRooms.set(roomId, room);
  a.socket.roomId = roomId;
  b.socket.roomId = roomId;

  // Bump guest match counters now that the pairing actually goes through.
  // Counters are checked at join_queue time and again here so a guest can't
  // sneak past the cap by queueing concurrently in another tab.
  if (aIsGuest) incrementGuestMatchUsage(a.socket);
  if (bIsGuest) incrementGuestMatchUsage(b.socket);

  // Surface existing friendship to the client so the in-call "Add Friend"
  // button reflects the existing relationship instead of inviting a
  // duplicate request. Skipped entirely when either side is a guest — a
  // guest can't have friendships, and `userId` is a non-ObjectId string
  // that would make Mongoose throw.
  let isFriend = false;
  if (!aIsGuest && !bIsGuest) {
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
  }

  const payloadFor = (peerEntry, peerIsGuest) => ({
    peerUserId: peerEntry.userId,
    peerUsername: peerEntry.profile.username,
    peerDisplayName: peerEntry.profile.displayName,
    peerCountry: peerEntry.profile.country,
    peerInterests: peerEntry.profile.interests,
    peerIsGuest,
    isFriend,
  });

  a.socket.emit('match_found', { roomId, role: 'initiator', ...payloadFor(b, bIsGuest) });
  b.socket.emit('match_found', { roomId, role: 'receiver',  ...payloadFor(a, aIsGuest) });

  console.log(
    `[match] ${tag(a.userId)}${aIsGuest ? '(g)' : ''} <-> ${tag(b.userId)}${bIsGuest ? '(g)' : ''}  langs=${a.profile.languages.join(',') || '∅'} ∩ ${b.profile.languages.join(',') || '∅'}  interests=${a.profile.interests.join(',') || '∅'} ∩ ${b.profile.interests.join(',') || '∅'}`
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

    // Guest match cap — both per-session and per-day. Refuse the queue
    // join if exhausted; frontend will surface the "sign up to keep
    // chatting" CTA on this event.
    if (isGuestSocket(socket) && guestRemainingMatches(socket) <= 0) {
      socket.emit('guest_limit_reached', {
        message: 'Sign up to keep chatting.',
        sessionMax: GUEST_MAX_PER_SESSION,
        dailyMax: GUEST_MAX_PER_DAY,
      });
      return;
    }

    // Guests skip the User.findById query — they have no DB row, and the
    // gid string would make Mongoose throw. Use an empty profile so they
    // match anyone in the queue without language/interest filtering.
    const myProfile = isGuestSocket(socket)
      ? guestProfile()
      : await fetchProfile(socket.user.id);
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
  // Skip the log when either side is a guest — their gid is a non-ObjectId
  // string that CallLog can't store, and we don't bill / analyse guest
  // sessions the same way anyway.
  if (room.aIsGuest || room.bIsGuest) return;
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
