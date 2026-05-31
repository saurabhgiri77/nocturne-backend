const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Friendship = require('../models/Friendship');
const { handleMatchmaking } = require('./matchmaking');
const { handleSignaling } = require('./signaling');
const { handleMessages } = require('./messages');

// userId → Set<socketId>. A user with multiple tabs counts once.
const userSockets = new Map();

// userId → Timeout. Enforces the email-verification deadline mid-session:
// a user who connects shortly before their deadline would otherwise stay on
// indefinitely. One timer per user, armed on their first socket.
const graceTimers = new Map();

const clearGraceTimer = (uid) => {
  const t = graceTimers.get(uid);
  if (t) {
    clearTimeout(t);
    graceTimers.delete(uid);
  }
};

// When an unverified user's deadline passes, notify them and drop every
// socket they hold. Re-checks the DB first so verifying in another tab (which
// flips emailVerified) cancels the kick instead of booting a now-valid user.
const scheduleGraceKick = (io, uid, deadline) => {
  clearGraceTimer(uid);
  const remaining = new Date(deadline).getTime() - Date.now();
  const fire = async () => {
    graceTimers.delete(uid);
    try {
      const u = await User.findById(uid).select('emailVerified');
      if (!u || u.emailVerified) return; // verified meanwhile — let them stay
    } catch (err) {
      console.error('[verify-grace] kick lookup failed:', err.message);
      return;
    }
    io.to(`user:${uid}`).emit('verification_required', {
      message: 'Verify your email to keep using Bump.',
    });
    const set = userSockets.get(uid);
    if (set) {
      for (const sid of [...set]) io.sockets.sockets.get(sid)?.disconnect(true);
    }
  };
  graceTimers.set(uid, setTimeout(fire, Math.max(0, remaining)));
};

// True iff the user has at least one active socket. Exported so REST
// routes (e.g. GET /api/friends) can decorate responses with presence.
const isUserOnline = (userId) => {
  const set = userSockets.get(String(userId));
  return !!set && set.size > 0;
};

// Look up this user's accepted friends and notify each one. Used on the
// first socket connect / last disconnect so each friend's sidebar can
// flip the status dot without polling.
const notifyFriendsOfPresence = async (io, userId, event) => {
  try {
    const rows = await Friendship.find({
      status: 'accepted',
      $or: [{ requester: userId }, { recipient: userId }],
    }).select('requester recipient').lean();
    const me = String(userId);
    for (const f of rows) {
      const other = String(f.requester) === me ? String(f.recipient) : String(f.requester);
      io.to(`user:${other}`).emit(event, { userId: me });
    }
  } catch (err) {
    console.error('[presence] notifyFriends failed:', err);
  }
};

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
      const user = await User.findById(socket.user.id).select(
        'suspendedUntil passwordChangedAt emailVerified verificationDeadline'
      );
      if (user?.suspendedUntil && user.suspendedUntil > new Date()) {
        return next(new Error('Authentication error: account suspended'));
      }
      // Reject sockets opened with a JWT issued before the user's last
      // password change. Matches the HTTP middleware so a /reset evicts
      // every active socket too.
      if (
        user?.passwordChangedAt &&
        socket.user.iat * 1000 < user.passwordChangedAt.getTime()
      ) {
        return next(new Error('Authentication error: session expired'));
      }
      // Email-verification gate: an unverified user past their grace deadline
      // can't open a socket at all (matchmaking, DMs, and presence all ride
      // it). The frontend maps this message to the "verify your email" screen.
      if (user && user.isVerificationRequired()) {
        return next(new Error('Authentication error: email not verified'));
      }
      // Stash for the connection handler's mid-session grace timer.
      socket.user.emailVerified = !!user?.emailVerified;
      socket.user.verificationDeadline = user?.verificationDeadline || null;
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
    if (wasOffline) {
      broadcastOnlineCount(io);
      // Tell this user's friends they're online now. Fire-and-forget.
      notifyFriendsOfPresence(io, uid, 'friend_online');
    }

    // Arm the verification-deadline kick for unverified users (once per user,
    // on their first socket). Past-deadline users never reach here — the auth
    // middleware already rejected them — so `deadline` is always in the future.
    if (
      !socket.user.emailVerified &&
      socket.user.verificationDeadline &&
      !graceTimers.has(uid)
    ) {
      scheduleGraceKick(io, uid, socket.user.verificationDeadline);
    }

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
          clearGraceTimer(uid);
          broadcastOnlineCount(io);
          notifyFriendsOfPresence(io, uid, 'friend_offline');
        }
      }
    });
  });
};

module.exports = { initSocket, isUserOnline };
