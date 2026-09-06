// In-call mini games.
//
// State lives at `room.game`, a field on the existing activeRooms value
// object — NOT a second Map. Both real teardown paths already end in
// `activeRooms.delete(roomId)` (matchmaking.js disconnect, signaling.js
// end_call), so game state dies with the call for free, and the
// "room deleted but game retained" desync is unrepresentable. The cost is
// coupling, paid with one discipline rule: only this file ever reads or
// writes room.game.
//
// Same posture as matchmaking.js's guest counters: in-process, single-node,
// best-effort. Surviving a restart is not a requirement — activeRooms is
// wiped too, and `check_room` already bounces orphaned clients with
// `match_lost`, which the game rides for free.
//
// NO SERVER-SIDE TIMERS. A setTimeout parked on room.game would fire after
// activeRooms.delete and operate on a dead room. A stalled round is just
// "waiting for your opponent"; either player can always quit or skip.

const crypto = require('crypto');
const { getPeer, memberRoom, slotOf } = require('./roomUtils');
const { checkSocketLimit } = require('./rateLimit');
const { getGame, catalog } = require('../games');

const INVITE_COOLDOWN_MS = 30_000;
const MAX_DECLINES_PER_CALL = 2;
const GAMES_ENABLED = process.env.GAMES_ENABLED !== 'false'; // opt-out kill switch

const nid = () => crypto.randomBytes(9).toString('base64url');
const otherSlot = (slot) => (slot === 'a' ? 'b' : 'a');

const ensureGame = (room) => {
  if (!room.game) {
    room.game = {
      phase: 'idle',      // 'idle' | 'inviting' | 'playing' | 'over'
      invite: null,       // { id, fromSlot, gameId, at }
      session: null,      // { id, gameId, state }
      declines: 0,        // survives clearGame — anti-nag
      blocked: false,     // 2 declines ⇒ no more invites this call
      cooldownUntil: 0,
    };
  }
  return room.game;
};

// Reset the playable state but KEEP the anti-nag counters — otherwise a
// griefer could clear their own decline count by starting and quitting.
const clearGame = (room) => {
  const g = ensureGame(room);
  g.phase = 'idle';
  g.invite = null;
  g.session = null;
};

const socketForSlot = (io, room, slot) =>
  io.sockets.sockets.get(slot === 'a' ? room.userA : room.userB);

// Every state emit is PER-RECIPIENT: publicState() projects away whatever the
// viewer must not know (RPS's un-revealed choice). Never build one payload and
// send it to both sockets — that is exactly the leak publicState exists to
// prevent.
const emitToBoth = (io, room, event, build) => {
  for (const slot of ['a', 'b']) {
    socketForSlot(io, room, slot)?.emit(event, build(slot));
  }
};

// NOTE: this deliberately does NOT echo the raw client move back. For RPS the
// raw move IS the secret, so an innocent-looking `lastMove` field would defeat
// publicState() entirely. Everything a client needs to animate is already in
// the projected state (`state.last` for TTT/C4).
const pushState = (io, room, roomId) => {
  const s = room.game.session;
  const mod = getGame(s.gameId);
  emitToBoth(io, room, 'game_state', (slot) => ({
    roomId,
    sessionId: s.id,
    gameId: s.gameId,
    yourSlot: slot,
    state: mod.publicState(s.state, slot),
    turn: mod.turnSlot(s.state),
    seq: s.state.seq,
  }));
};

const pushOver = (io, room, roomId, term) => {
  const s = room.game.session;
  const mod = getGame(s.gameId);
  emitToBoth(io, room, 'game_over', (slot) => ({
    roomId,
    sessionId: s.id,
    gameId: s.gameId,
    yourSlot: slot,
    result: { winnerSlot: term.winnerSlot ?? null, draw: !!term.draw },
    state: mod.publicState(s.state, slot),
    seq: s.state.seq,
  }));
};

const startSession = (io, room, roomId, gameId, prevState) => {
  const g = ensureGame(room);
  const mod = getGame(gameId);
  // Slot 'a' is always the WebRTC initiator, which is not random with respect
  // to who queued first — so the first mover is chosen randomly, and alternates
  // on every rematch.
  const state = prevState
    ? mod.rematchState(prevState)
    : mod.createState({ starter: crypto.randomInt(2) === 0 ? 'a' : 'b' });

  g.session = { id: nid(), gameId, state };
  g.phase = 'playing';
  g.invite = null;

  emitToBoth(io, room, 'game_started', (slot) => ({
    roomId,
    sessionId: g.session.id,
    gameId,
    yourSlot: slot,
    state: mod.publicState(state, slot),
    turn: mod.turnSlot(state),
    seq: state.seq,
  }));
};

const handleGames = (io, socket) => {
  if (!GAMES_ENABLED) return;

  // ── invite ──────────────────────────────────────────────────────────────
  socket.on('game_invite', ({ roomId, gameId } = {}, ack) => {
    const done = (r) => typeof ack === 'function' && ack(r);
    if (!checkSocketLimit(socket, 'game_invite')) return done({ ok: false, error: 'rate_limited' });
    const room = memberRoom(roomId, socket.id);
    if (!room) return done({ ok: false, error: 'not_member' });

    const mod = getGame(gameId);
    if (!mod) return done({ ok: false, error: 'unknown_game' });

    const g = ensureGame(room);
    if (g.blocked) return done({ ok: false, error: 'blocked' });
    if (Date.now() < g.cooldownUntil) return done({ ok: false, error: 'cooldown' });

    const slot = slotOf(room, socket.id);

    // Both tapped at once. Resolve deterministically and silently — neither
    // user did anything wrong, so neither should see an error. Slot 'a' wins.
    if (g.phase === 'inviting' && g.invite) {
      if (g.invite.fromSlot === slot) return done({ ok: false, error: 'busy' });
      if (slot === 'b') return done({ ok: false, error: 'busy' }); // A's invite stands; B already has it
      socketForSlot(io, room, 'b')?.emit('game_invite_superseded', { roomId, inviteId: g.invite.id });
    } else if (g.phase !== 'idle') {
      return done({ ok: false, error: 'busy' });
    }

    g.invite = { id: nid(), fromSlot: slot, gameId, at: Date.now() };
    g.phase = 'inviting';
    done({ ok: true, inviteId: g.invite.id });

    getPeer(io, room, socket.id)?.emit('game_invited', {
      roomId,
      inviteId: g.invite.id,
      gameId,
      title: mod.title,
    });
  });

  // ── accept / decline ────────────────────────────────────────────────────
  socket.on('game_invite_response', ({ roomId, inviteId, accept } = {}, ack) => {
    const done = (r) => typeof ack === 'function' && ack(r);
    if (!checkSocketLimit(socket, 'game_invite_response')) return done({ ok: false, error: 'rate_limited' });
    const room = memberRoom(roomId, socket.id);
    if (!room) return done({ ok: false, error: 'not_member' });

    const g = ensureGame(room);
    if (!g.invite || g.invite.id !== inviteId) return done({ ok: false, error: 'no_session' });
    const slot = slotOf(room, socket.id);
    if (slot === g.invite.fromSlot) return done({ ok: false, error: 'not_your_turn' });

    if (!accept) {
      g.declines += 1;
      g.cooldownUntil = Date.now() + INVITE_COOLDOWN_MS;
      if (g.declines >= MAX_DECLINES_PER_CALL) g.blocked = true;
      const inviteIdEcho = g.invite.id;
      clearGame(room);
      done({ ok: true });
      return socketForSlot(io, room, otherSlot(slot))?.emit('game_invite_declined', {
        roomId, inviteId: inviteIdEcho, blocked: g.blocked,
      });
    }

    done({ ok: true });
    startSession(io, room, roomId, g.invite.gameId, null);
  });

  // ── move ────────────────────────────────────────────────────────────────
  socket.on('game_move', ({ roomId, sessionId, seq, move } = {}, ack) => {
    const done = (r) => typeof ack === 'function' && ack(r);
    if (!checkSocketLimit(socket, 'game_move')) return done({ ok: false, error: 'rate_limited' });
    const room = memberRoom(roomId, socket.id);
    if (!room) return done({ ok: false, error: 'not_member' });

    const g = ensureGame(room);
    const s = g.session;
    if (!s || s.id !== sessionId || g.phase !== 'playing') return done({ ok: false, error: 'no_session' });
    if (seq !== s.state.seq) return done({ ok: false, error: 'stale_seq' });
    // Type-check before the engine ever sees it. Socket.IO has no body-size
    // cap here the way express.json does, so nothing untyped gets through.
    if (!move || typeof move !== 'object' || Array.isArray(move)) return done({ ok: false, error: 'bad_payload' });

    const mod = getGame(s.gameId);
    const slot = slotOf(room, socket.id);
    const { state, error } = mod.applyMove(s.state, slot, move);
    if (error) return done({ ok: false, error });

    s.state = state;
    done({ ok: true, seq: state.seq });

    const term = mod.isTerminal(state);
    if (term.over) {
      g.phase = 'over';
      pushOver(io, room, roomId, term);
    } else {
      pushState(io, room, roomId);
    }
  });

  // ── rematch ─────────────────────────────────────────────────────────────
  socket.on('game_rematch', ({ roomId, sessionId } = {}, ack) => {
    const done = (r) => typeof ack === 'function' && ack(r);
    if (!checkSocketLimit(socket, 'game_rematch')) return done({ ok: false, error: 'rate_limited' });
    const room = memberRoom(roomId, socket.id);
    if (!room) return done({ ok: false, error: 'not_member' });

    const g = ensureGame(room);
    const s = g.session;
    if (!s || s.id !== sessionId || g.phase !== 'over') return done({ ok: false, error: 'no_session' });

    done({ ok: true });
    startSession(io, room, roomId, s.gameId, s.state);
  });

  // ── quit (the game ends, the CALL continues) ────────────────────────────
  // The only teardown path in this design that needs its own emission. The
  // other three — disconnect, end_call, restart-orphan — delete the whole
  // room, so room.game goes with it and the client resets off roomId.
  socket.on('game_quit', ({ roomId, sessionId } = {}, ack) => {
    const done = (r) => typeof ack === 'function' && ack(r);
    if (!checkSocketLimit(socket, 'game_quit')) return done({ ok: false, error: 'rate_limited' });
    const room = memberRoom(roomId, socket.id);
    if (!room) return done({ ok: false, error: 'not_member' });

    const g = ensureGame(room);
    const slot = slotOf(room, socket.id);

    // Cancelling an invite you sent, before anyone accepted. Without this the
    // inviter clears their own UI while the server still holds the invite, and
    // a late accept would drop them into a game they thought they'd cancelled.
    if (!sessionId && g.phase === 'inviting' && g.invite?.fromSlot === slot) {
      const inviteId = g.invite.id;
      clearGame(room);
      done({ ok: true });
      return getPeer(io, room, socket.id)?.emit('game_invite_cancelled', { roomId, inviteId });
    }

    if (!g.session || g.session.id !== sessionId) return done({ ok: false, error: 'no_session' });

    clearGame(room);
    done({ ok: true });
    getPeer(io, room, socket.id)?.emit('game_ended', { roomId, sessionId, reason: 'peer_quit' });
  });
};

module.exports = { handleGames, clearGame, catalog, GAMES_ENABLED };
