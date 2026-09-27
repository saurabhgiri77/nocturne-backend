#!/usr/bin/env node
// Integration checks for the game relay, against fake sockets.
//
// The engine checks (games/__check.js) prove publicState() is leak-free; these
// prove the RELAY actually uses it per-recipient, plus the membership,
// sequence and anti-nag rules that only exist at this layer.
const assert = require('node:assert/strict');
const { activeRooms } = require('./matchmaking');
const { handleGames } = require('./games');
const { handleReactions } = require('./reactions');
const { eventLimits } = require('./rateLimit');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (err) { console.error(`\n  ✗ ${name}\n    ${err.message}\n`); process.exitCode = 1; }
};

// ── fakes ────────────────────────────────────────────────────────────────
const makeSocket = (id, userId) => ({
  id,
  user: { id: userId },
  handlers: new Map(),
  sent: [],
  on(ev, fn) { this.handlers.set(ev, fn); },
  once(ev, fn) { this.handlers.set(`once:${ev}`, fn); },
  emit(ev, payload) { this.sent.push({ ev, payload }); },
  fire(ev, payload, ack) { return this.handlers.get(ev)?.(payload, ack); },
  received(ev) { return this.sent.filter((m) => m.ev === ev).map((m) => m.payload); },
  last(ev) { const r = this.received(ev); return r[r.length - 1]; },
});

let seqId = 0;
const setup = () => {
  // Unique ids per test: the rate limiter buckets by socket.id and only frees
  // them on a real 'disconnect', so reusing ids would exhaust game_invite.
  const n = seqId += 1;
  const a = makeSocket(`sock_a${n}`, `user_a${n}`);
  const b = makeSocket(`sock_b${n}`, `user_b${n}`);
  const io = { sockets: { sockets: new Map([[a.id, a], [b.id, b]]) } };
  const roomId = 'room_test';
  activeRooms.set(roomId, {
    userA: a.id, userB: b.id, userAId: a.user.id, userBId: b.user.id,
    aIsGuest: false, bIsGuest: false, startedAt: new Date(),
  });
  handleGames(io, a);
  handleGames(io, b);
  return { a, b, io, roomId, room: activeRooms.get(roomId) };
};
const teardown = () => activeRooms.clear();

const ackOf = () => { const box = {}; return [ (r) => { box.r = r; }, box ]; };

// Invite → accept, returning the started session.
const startGame = (ctx, gameId) => {
  const [ack1] = ackOf();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId }, ack1);
  const invite = ctx.b.last('game_invited');
  const [ack2] = ackOf();
  ctx.b.fire('game_invite_response', { roomId: ctx.roomId, inviteId: invite.inviteId, accept: true }, ack2);
  return { invite, startedA: ctx.a.last('game_started'), startedB: ctx.b.last('game_started') };
};

// ── membership ───────────────────────────────────────────────────────────
test('relay: a socket outside the room cannot invite into it', () => {
  const ctx = setup();
  const intruder = makeSocket(`sock_x${seqId}`, 'user_x');
  ctx.io.sockets.sockets.set(intruder.id, intruder);
  handleGames(ctx.io, intruder);
  const [ack, box] = ackOf();
  intruder.fire('game_invite', { roomId: ctx.roomId, gameId: 'tictactoe' }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'not_member' });
  assert.equal(ctx.a.received('game_invited').length, 0);
  assert.equal(ctx.b.received('game_invited').length, 0);
  teardown();
});

test('relay: a non-member cannot move in someone else\'s game', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'tictactoe');
  const intruder = makeSocket(`sock_x${seqId}`, 'user_x');
  ctx.io.sockets.sockets.set(intruder.id, intruder);
  handleGames(ctx.io, intruder);
  const [ack, box] = ackOf();
  intruder.fire('game_move', {
    roomId: ctx.roomId, sessionId: startedA.sessionId, seq: 0, move: { index: 0 },
  }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'not_member' });
  teardown();
});

test('relay: unknown game ids are rejected', () => {
  const ctx = setup();
  const [ack, box] = ackOf();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: '../../etc/passwd' }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'unknown_game' });
  teardown();
});

// ── the leak, at the relay layer ─────────────────────────────────────────
test('relay: RPS choice never reaches the peer before they commit', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'rps');
  ctx.a.fire('game_move', {
    roomId: ctx.roomId, sessionId: startedA.sessionId, seq: 0, move: { choice: 'rock' },
  }, () => {});

  const toB = JSON.stringify(ctx.b.sent);
  assert.ok(!toB.includes('rock'), "relay leaked A's choice to B");
  const bState = ctx.b.last('game_state');
  assert.equal(bState.state.peerCommitted, true);
  assert.equal(bState.state.youCommitted, false);
  assert.equal(bState.state.pending, undefined);
  // and A's own view knows only that A committed
  assert.equal(ctx.a.last('game_state').state.youCommitted, true);
  teardown();
});

test('relay: both slots get distinct per-recipient payloads', () => {
  const ctx = setup();
  const { startedA, startedB } = startGame(ctx, 'rps');
  assert.equal(startedA.yourSlot, 'a');
  assert.equal(startedB.yourSlot, 'b');
  assert.equal(startedA.sessionId, startedB.sessionId);
  teardown();
});

// ── sequencing ───────────────────────────────────────────────────────────
test('relay: a replayed (stale) seq is rejected and does not mutate', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'tictactoe');
  const first = startedA.turn === 'a' ? ctx.a : ctx.b;
  first.fire('game_move', { roomId: ctx.roomId, sessionId: startedA.sessionId, seq: 0, move: { index: 4 } }, () => {});
  const [ack, box] = ackOf();
  first.fire('game_move', { roomId: ctx.roomId, sessionId: startedA.sessionId, seq: 0, move: { index: 0 } }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'stale_seq' });
  assert.equal(ctx.room.game.session.state.seq, 1);
  teardown();
});

test('relay: a move against a stale sessionId is rejected', () => {
  const ctx = setup();
  startGame(ctx, 'tictactoe');
  const [ack, box] = ackOf();
  ctx.a.fire('game_move', { roomId: ctx.roomId, sessionId: 'not-a-session', seq: 0, move: { index: 0 } }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'no_session' });
  teardown();
});

test('relay: non-object moves are rejected before reaching the engine', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'tictactoe');
  const mover = startedA.turn === 'a' ? ctx.a : ctx.b;
  for (const bad of ['x', 42, [1, 2], null, undefined]) {
    const [ack, box] = ackOf();
    mover.fire('game_move', { roomId: ctx.roomId, sessionId: startedA.sessionId, seq: 0, move: bad }, ack);
    assert.equal(box.r.error, 'bad_payload', `accepted ${JSON.stringify(bad)}`);
  }
  teardown();
});

// ── lifecycle ────────────────────────────────────────────────────────────
test('relay: playing to a win emits game_over to both, not game_state', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'tictactoe');
  const sid = startedA.sessionId;
  const bySlot = { a: ctx.a, b: ctx.b };
  let turn = startedA.turn;
  let seq = 0;
  // winner takes 0,1,2; loser takes 3,4
  const script = { [turn]: [0, 1, 2], [turn === 'a' ? 'b' : 'a']: [3, 4] };
  const idx = { a: 0, b: 0 };
  for (let i = 0; i < 5; i += 1) {
    const move = { index: script[turn][idx[turn]] };
    idx[turn] += 1;
    bySlot[turn].fire('game_move', { roomId: ctx.roomId, sessionId: sid, seq, move }, () => {});
    seq += 1;
    turn = turn === 'a' ? 'b' : 'a';
  }
  assert.equal(ctx.a.received('game_over').length, 1);
  assert.equal(ctx.b.received('game_over').length, 1);
  assert.equal(ctx.a.last('game_over').result.winnerSlot, startedA.turn);
  assert.equal(ctx.room.game.phase, 'over');
  teardown();
});

test('relay: quit ends the game, keeps the room, and tells only the peer', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'tictactoe');
  const before = ctx.a.received('game_ended').length;
  const [ack, box] = ackOf();
  ctx.a.fire('game_quit', { roomId: ctx.roomId, sessionId: startedA.sessionId }, ack);
  assert.deepEqual(box.r, { ok: true });
  assert.equal(ctx.b.received('game_ended').length, 1);
  assert.equal(ctx.b.last('game_ended').reason, 'peer_quit');
  assert.equal(ctx.a.received('game_ended').length, before);
  assert.ok(activeRooms.has(ctx.roomId), 'quitting a game must not end the call');
  assert.equal(ctx.room.game.phase, 'idle');
  teardown();
});

test('relay: rematch alternates the starter', () => {
  const ctx = setup();
  const { startedA } = startGame(ctx, 'tictactoe');
  const sid = startedA.sessionId;
  const bySlot = { a: ctx.a, b: ctx.b };
  let turn = startedA.turn;
  let seq = 0;
  const script = { [turn]: [0, 1, 2], [turn === 'a' ? 'b' : 'a']: [3, 4] };
  const idx = { a: 0, b: 0 };
  for (let i = 0; i < 5; i += 1) {
    bySlot[turn].fire('game_move', { roomId: ctx.roomId, sessionId: sid, seq, move: { index: script[turn][idx[turn]++] } }, () => {});
    seq += 1;
    turn = turn === 'a' ? 'b' : 'a';
  }
  ctx.a.fire('game_rematch', { roomId: ctx.roomId, sessionId: sid }, () => {});
  const restarted = ctx.a.last('game_started');
  assert.notEqual(restarted.sessionId, sid, 'rematch must mint a new session id');
  assert.equal(restarted.turn, startedA.turn === 'a' ? 'b' : 'a', 'starter did not alternate');
  teardown();
});

// ── anti-nag ─────────────────────────────────────────────────────────────
test('relay: two declines block invites for the rest of the call', () => {
  const ctx = setup();
  for (let i = 0; i < 2; i += 1) {
    ctx.room.game && (ctx.room.game.cooldownUntil = 0); // skip the 30s wait
    const [ack1] = ackOf();
    ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, ack1);
    const inv = ctx.b.last('game_invited');
    ctx.b.fire('game_invite_response', { roomId: ctx.roomId, inviteId: inv.inviteId, accept: false }, () => {});
  }
  assert.equal(ctx.a.last('game_invite_declined').blocked, true);
  ctx.room.game.cooldownUntil = 0;
  const [ack, box] = ackOf();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'blocked' });
  teardown();
});

test('relay: a decline arms the cooldown', () => {
  const ctx = setup();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, () => {});
  const inv = ctx.b.last('game_invited');
  ctx.b.fire('game_invite_response', { roomId: ctx.roomId, inviteId: inv.inviteId, accept: false }, () => {});
  const [ack, box] = ackOf();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'cooldown' });
  teardown();
});

test('relay: the inviter cannot accept their own invite', () => {
  const ctx = setup();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, () => {});
  const inv = ctx.b.last('game_invited');
  const [ack, box] = ackOf();
  ctx.a.fire('game_invite_response', { roomId: ctx.roomId, inviteId: inv.inviteId, accept: true }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'not_your_turn' });
  teardown();
});

test('relay: simultaneous invites resolve to slot a with no error shown to a', () => {
  const ctx = setup();
  ctx.b.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, () => {});
  const [ack, box] = ackOf();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'connect4' }, ack);
  assert.equal(box.r.ok, true, "A's invite should win the race");
  assert.equal(ctx.b.received('game_invite_superseded').length, 1);
  assert.equal(ctx.b.last('game_invited').gameId, 'connect4');
  assert.equal(ctx.room.game.invite.fromSlot, 'a');
  teardown();
});

test('relay: cancelling your own invite clears it on the peer', () => {
  const ctx = setup();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'connect4' }, () => {});
  const inv = ctx.b.last('game_invited');
  const [ack, box] = ackOf();
  ctx.a.fire('game_quit', { roomId: ctx.roomId }, ack);
  assert.deepEqual(box.r, { ok: true });
  assert.equal(ctx.b.last('game_invite_cancelled').inviteId, inv.inviteId);
  assert.equal(ctx.room.game.phase, 'idle');
  // and a late accept can no longer start a game the canceller doesn't know about
  const [ack2, box2] = ackOf();
  ctx.b.fire('game_invite_response', { roomId: ctx.roomId, inviteId: inv.inviteId, accept: true }, ack2);
  assert.deepEqual(box2.r, { ok: false, error: 'no_session' });
  assert.equal(ctx.a.received('game_started').length, 0);
  teardown();
});

test('relay: you cannot cancel an invite the OTHER side sent', () => {
  const ctx = setup();
  ctx.a.fire('game_invite', { roomId: ctx.roomId, gameId: 'rps' }, () => {});
  const [ack, box] = ackOf();
  ctx.b.fire('game_quit', { roomId: ctx.roomId }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'no_session' });
  assert.equal(ctx.room.game.phase, 'inviting');
  teardown();
});

test('relay: game state dies with the room (no second map to leak)', () => {
  const ctx = setup();
  startGame(ctx, 'connect4');
  assert.ok(ctx.room.game.session);
  activeRooms.delete(ctx.roomId); // what end_call / disconnect already do
  const [ack, box] = ackOf();
  ctx.a.fire('game_move', { roomId: ctx.roomId, sessionId: 'x', seq: 0, move: { col: 0 } }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'not_member' });
  teardown();
});

// ── camera reactions ─────────────────────────────────────────────────────
const GIF = { id: 'g1', url: 'https://media1.giphy.com/media/g1/200w.webp', stillUrl: null, width: 200, height: 150 };

// setup() also wires the game handlers onto a and b; they don't interact.
// Every call gets fresh socket ids, which matters here: reactions allow only
// 5 per 10s per socket and the limiter frees a bucket only on 'disconnect'.
const reactionSetup = (pick = () => GIF) => {
  const ctx = setup();
  const pool = { pick };
  handleReactions(ctx.io, ctx.a, { enabled: true, pool });
  handleReactions(ctx.io, ctx.b, { enabled: true, pool });
  return ctx;
};

test('reaction: a member\'s valid label reaches the peer and acks the sender', () => {
  const ctx = reactionSetup();
  const [ack, box] = ackOf();
  ctx.a.fire('reaction', { roomId: ctx.roomId, label: 'thumbs_up' }, ack);
  assert.equal(box.r.ok, true);
  assert.equal(box.r.reaction.label, 'thumbs_up');
  assert.equal(box.r.reaction.roomId, ctx.roomId);
  assert.deepEqual(box.r.reaction.gif, GIF);
  assert.equal(typeof box.r.reaction.id, 'string');
  assert.deepEqual(ctx.b.received('reaction_received'), [box.r.reaction]);
  assert.equal(ctx.a.received('reaction_received').length, 0, 'sender must not get its own echo');
  teardown();
});

test('reaction: the payload never carries the sender\'s user id', () => {
  const ctx = reactionSetup();
  ctx.a.fire('reaction', { roomId: ctx.roomId, label: 'wave' }, () => {});
  assert.ok(!JSON.stringify(ctx.b.sent).includes(ctx.a.user.id));
  teardown();
});

test('reaction: a non-member cannot inject into the room', () => {
  const ctx = reactionSetup();
  const intruder = makeSocket(`sock_x${seqId}`, 'user_x');
  ctx.io.sockets.sockets.set(intruder.id, intruder);
  handleReactions(ctx.io, intruder, { enabled: true, pool: { pick: () => GIF } });
  const [ack, box] = ackOf();
  intruder.fire('reaction', { roomId: ctx.roomId, label: 'wave' }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'not_member' });
  assert.equal(ctx.a.received('reaction_received').length, 0);
  assert.equal(ctx.b.received('reaction_received').length, 0);
  teardown();
});

test('reaction: labels outside the closed set are rejected', () => {
  for (const label of ['__proto__', 'constructor', 'toString', '', 42, null, {}, [], 'THUMBS_UP', 'thumbs_up ', 'kiss']) {
    const ctx = reactionSetup();
    const [ack, box] = ackOf();
    ctx.a.fire('reaction', { roomId: ctx.roomId, label }, ack);
    assert.deepEqual(box.r, { ok: false, error: 'unknown_label' }, `accepted ${JSON.stringify(label)}`);
    assert.equal(ctx.b.received('reaction_received').length, 0);
    teardown();
  }
});

test('reaction: junk payloads and a missing ack never throw', () => {
  for (const payload of [null, undefined, 'x', 42, [], {}]) {
    const ctx = reactionSetup();
    const [ack, box] = ackOf();
    assert.doesNotThrow(() => ctx.a.fire('reaction', payload, ack));
    assert.deepEqual(box.r, { ok: false, error: 'not_member' }, `payload ${JSON.stringify(payload)}`);
    teardown();
  }
  const ctx = reactionSetup();
  assert.doesNotThrow(() => ctx.a.fire('reaction', { roomId: ctx.roomId, label: 'wave' }));
  assert.equal(ctx.b.received('reaction_received').length, 1);
  teardown();
});

test('reaction: a client-supplied gif or url never reaches the peer', () => {
  const ctx = reactionSetup();
  ctx.a.fire('reaction', {
    roomId: ctx.roomId,
    label: 'wave',
    gif: { url: 'https://evil.example/x.gif' },
    url: 'https://evil.example/y.gif',
  }, () => {});
  assert.equal(ctx.b.received('reaction_received').length, 1);
  assert.ok(!JSON.stringify(ctx.b.sent).includes('evil'), 'client-controlled URL was relayed');
  teardown();
});

test('reaction: the sixth reaction inside 10s is rate limited', () => {
  const ctx = reactionSetup();
  const results = [];
  for (let i = 0; i < 6; i += 1) {
    const [ack, box] = ackOf();
    ctx.a.fire('reaction', { roomId: ctx.roomId, label: 'wave' }, ack);
    results.push(box.r);
  }
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.deepEqual(results[5], { ok: false, error: 'rate_limited' });
  assert.equal(ctx.b.received('reaction_received').length, 5);
  teardown();
});

test('reaction: an empty GIF pool still delivers, with gif null', () => {
  const ctx = reactionSetup(() => null);
  const [ack, box] = ackOf();
  ctx.a.fire('reaction', { roomId: ctx.roomId, label: 'laugh' }, ack);
  assert.equal(box.r.ok, true);
  assert.equal(box.r.reaction.gif, null);
  assert.equal(ctx.b.last('reaction_received').gif, null);
  teardown();
});

test('reaction: a late reaction after the room is torn down is rejected', () => {
  const ctx = reactionSetup();
  activeRooms.delete(ctx.roomId); // what end_call / disconnect already do
  const [ack, box] = ackOf();
  ctx.a.fire('reaction', { roomId: ctx.roomId, label: 'wave' }, ack);
  assert.deepEqual(box.r, { ok: false, error: 'not_member' });
  assert.equal(ctx.b.received('reaction_received').length, 0);
  teardown();
});

test('reaction: the kill switch registers zero handlers', () => {
  const s = makeSocket('sock_off', 'user_off');
  handleReactions({ sockets: { sockets: new Map() } }, s, { enabled: false, pool: { pick: () => GIF } });
  assert.equal(s.handlers.size, 0);
});

// The limiter's default for an unlisted event is UNLIMITED, so a handler added
// without a limit entry is an open abuse vector. This catches it.
test('rate limits: every games and reactions event has an eventLimits entry', () => {
  const s = makeSocket('sock_limits', 'user_limits');
  const io = { sockets: { sockets: new Map([[s.id, s]]) } };
  handleGames(io, s);
  handleReactions(io, s, { enabled: true, pool: { pick: () => null } });
  const events = [...s.handlers.keys()].filter((k) => !k.startsWith('once:'));
  assert.ok(events.includes('reaction'));
  for (const ev of events) assert.ok(eventLimits[ev], `no rate limit for "${ev}"`);
});

if (process.exitCode) console.error(`socket: FAILED (${passed} passed)`);
else console.log(`socket: ${passed} checks passed`);
