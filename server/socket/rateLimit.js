// Per-socket sliding-window rate limiter for socket events. Cheaper than
// pulling Redis in for every chat message; lives only as long as the
// socket is connected.
//
//   const limit = createSocketLimiter({ chat: { windowMs: 10_000, max: 20 } });
//   if (!limit(socket, 'chat')) return; // dropped
//
// Limits silently drop the event when exceeded. We don't tell the client
// (it'd add chatter); from their POV it just looks like a network hiccup.

const createSocketLimiter = (config) => {
  // Map<socketId, Map<eventName, number[]>>
  const buckets = new Map();

  return (socket, event) => {
    const conf = config[event];
    if (!conf) return true;

    let socketBuckets = buckets.get(socket.id);
    if (!socketBuckets) {
      socketBuckets = new Map();
      buckets.set(socket.id, socketBuckets);

      // Cleanup on disconnect — prevents memory leak from sockets that
      // come and go all day.
      socket.once('disconnect', () => buckets.delete(socket.id));
    }

    const now = Date.now();
    const windowStart = now - conf.windowMs;
    let timestamps = socketBuckets.get(event);
    if (!timestamps) {
      timestamps = [];
      socketBuckets.set(event, timestamps);
    }

    // Drop expired entries (window slides). Cheap in-place trim from the
    // front; events pushed in chronological order, so first-out-of-window
    // is always at index 0.
    while (timestamps.length && timestamps[0] < windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= conf.max) return false;
    timestamps.push(now);
    return true;
  };
};

// Limits per event name, per socket. Keep these generous — legitimate
// users shouldn't ever hit them. Tighten if abuse shows up.
const eventLimits = {
  chat_message:    { windowMs: 10_000, max: 20 },  // 20 msgs / 10s
  dm_message:      { windowMs: 10_000, max: 20 },  // 20 msgs / 10s
  media_state:     { windowMs: 5_000,  max: 30 },  // toggle spam
  ice_candidate:   { windowMs: 1_000,  max: 50 },  // legitimate trickle ICE bursts
  join_queue:      { windowMs: 60_000, max: 30 },  // 30 skips/queue-joins per minute
  leave_queue:     { windowMs: 60_000, max: 30 },
};

const checkSocketLimit = createSocketLimiter(eventLimits);

module.exports = { checkSocketLimit, createSocketLimiter };
