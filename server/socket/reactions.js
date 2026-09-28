// Camera reactions — relay only, NEVER persist (same posture as chat_message).
//
// The client detects a gesture or expression on-device and sends only a label
// from the closed set in reactions/catalog.js. This file picks the GIF, so the
// Giphy key never leaves the server and a stranger can never hand their peer
// an arbitrary URL. Frames never reach the server at all.
//
// Stateless per call: nothing is stored on the room, so the existing
// activeRooms.delete teardown is all the cleanup there is — after it,
// memberRoom() rejects every late reaction.

const crypto = require('crypto');
const { getPeer, memberRoom } = require('./roomUtils');
const { checkSocketLimit } = require('./rateLimit');
const { LABELS, isLabel, queryFor } = require('../reactions/catalog');
const { search } = require('../reactions/giphy');
const { createGifPool } = require('../reactions/pool');

// Opt-IN kill switch (unlike GAMES_ENABLED): the feature needs a Giphy key and
// runs ML on users' devices, so it stays off until someone turns it on. The
// frontend's VITE_REACTIONS_ENABLED only shows the setting; THIS is
// authoritative.
const REACTIONS_ENABLED = process.env.REACTIONS_ENABLED === 'true';
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

// Comma-separated Giphy ids to never serve — a moderation lever that doesn't
// need a redeploy.
const blocklist = new Set(
  (process.env.REACTION_GIF_BLOCKLIST || '').split(',').map((s) => s.trim()).filter(Boolean)
);

if (REACTIONS_ENABLED && !GIPHY_API_KEY) {
  console.warn('[reactions] enabled without GIPHY_API_KEY — clients get the emoji fallback only');
}

const defaultPool = createGifPool({ search, apiKey: GIPHY_API_KEY, queryFor, blocklist });
// One search per label at boot (8 calls, well inside a beta key's 100/hour).
if (REACTIONS_ENABLED && GIPHY_API_KEY) defaultPool.warm(LABELS);

const nid = () => crypto.randomBytes(9).toString('base64url');

// `enabled` and `pool` are injectable so __check.js can drive the handler
// without env vars or network.
const handleReactions = (io, socket, { enabled = REACTIONS_ENABLED, pool = defaultPool } = {}) => {
  if (!enabled) return;

  socket.on('reaction', (payload, ack) => {
    const reply = (r) => { if (typeof ack === 'function') ack(r); };
    if (!checkSocketLimit(socket, 'reaction')) return reply({ ok: false, error: 'rate_limited' });

    // Two shapes. With a roomId this is an in-call reaction: membership is
    // checked and the peer is told. Without one it is a LOBBY reaction — the
    // user is alone on the home screen, so the GIF is picked and handed back
    // to them only, and nothing is relayed anywhere. Same closed label set,
    // same rate limit, still no client-supplied URLs.
    const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
    const room = roomId ? memberRoom(roomId, socket.id) : null;
    if (roomId && !room) return reply({ ok: false, error: 'not_member' });
    if (!isLabel(payload?.label)) return reply({ ok: false, error: 'unknown_label' });

    // Built from validated fields only — anything else the client put in the
    // payload (a `gif`, a `url`) is dropped here. No sender id either: for a
    // guest that would be their guest_xxx id, and the peer already knows who
    // they're talking to.
    const reaction = {
      id: nid(),
      roomId,
      label: payload.label,
      gif: pool.pick(payload.label),
    };
    if (room) getPeer(io, room, socket.id)?.emit('reaction_received', reaction);
    reply({ ok: true, reaction });
  });
};

module.exports = { handleReactions, REACTIONS_ENABLED };
