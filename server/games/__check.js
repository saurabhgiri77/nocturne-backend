#!/usr/bin/env node
// Engine assertions. Plain node, zero dependencies, non-zero exit on failure:
//   npm run test:games
//
// Aimed squarely at where bugs in this kind of code actually live — win-line
// tables, board edges, and the RPS hidden-move projection.
const assert = require('node:assert/strict');
const rps = require('./rps');
const ttt = require('./tictactoe');
const c4 = require('./connect4');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`\n  ✗ ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
  }
};

// Play a list of moves, asserting each succeeds. Returns the final state.
const play = (mod, state, moves) => {
  for (const [slot, move] of moves) {
    const res = mod.applyMove(state, slot, move);
    assert.equal(res.error, undefined, `unexpected error "${res.error}" on ${slot} ${JSON.stringify(move)}`);
    state = res.state;
  }
  return state;
};

// ─── Rock Paper Scissors ──────────────────────────────────────────────────

test('rps: never leaks A\'s choice to B before B commits', () => {
  let s = rps.createState();
  ({ state: s } = rps.applyMove(s, 'a', { choice: 'rock' }));
  const seenByB = JSON.stringify(rps.publicState(s, 'b'));
  assert.ok(!seenByB.includes('rock'), "RPS leaked A's choice to B before B committed");
  assert.equal(rps.publicState(s, 'b').peerCommitted, true);
  assert.equal(rps.publicState(s, 'b').youCommitted, false);
  assert.equal(rps.publicState(s, 'a').youCommitted, true);
});

test('rps: publicState never carries `pending` for either viewer', () => {
  let s = rps.createState();
  ({ state: s } = rps.applyMove(s, 'b', { choice: 'scissors' }));
  for (const viewer of ['a', 'b']) {
    assert.equal(rps.publicState(s, viewer).pending, undefined);
  }
});

test('rps: a slot cannot move twice in one round', () => {
  let s = rps.createState();
  ({ state: s } = rps.applyMove(s, 'a', { choice: 'rock' }));
  assert.equal(rps.applyMove(s, 'a', { choice: 'paper' }).error, 'not_your_turn');
});

test('rps: rejects choices outside the whitelist', () => {
  const s = rps.createState();
  for (const bad of [{ choice: 'constructor' }, { choice: '__proto__' }, { choice: 'ROCK' }, { choice: 1 }, {}, null]) {
    assert.equal(rps.applyMove(s, 'a', bad).error, 'illegal_move', `accepted ${JSON.stringify(bad)}`);
  }
});

test('rps: a tie scores nobody and advances the round', () => {
  const s = play(rps, rps.createState(), [['a', { choice: 'rock' }], ['b', { choice: 'rock' }]]);
  assert.deepEqual(s.scores, { a: 0, b: 0 });
  assert.equal(s.round, 2);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].winner, null);
  assert.deepEqual(s.pending, { a: null, b: null });
});

test('rps: best of 3 terminates at 2 wins and rejects further moves', () => {
  const s = play(rps, rps.createState(), [
    ['a', { choice: 'rock' }], ['b', { choice: 'scissors' }],
    ['b', { choice: 'paper' }], ['a', { choice: 'scissors' }],
  ]);
  assert.equal(s.over, true);
  assert.equal(s.winner, 'a');
  assert.deepEqual(s.scores, { a: 2, b: 0 });
  assert.deepEqual(rps.isTerminal(s), { over: true, winnerSlot: 'a', draw: false });
  assert.equal(rps.applyMove(s, 'b', { choice: 'rock' }).error, 'game_over');
  assert.equal(rps.turnSlot(s), null);
});

test('rps: every beat relation resolves correctly', () => {
  const wins = [['rock', 'scissors'], ['paper', 'rock'], ['scissors', 'paper']];
  for (const [win, lose] of wins) {
    const s = play(rps, rps.createState(), [['a', { choice: win }], ['b', { choice: lose }]]);
    assert.equal(s.history[0].winner, 'a', `${win} should beat ${lose}`);
    const t = play(rps, rps.createState(), [['a', { choice: lose }], ['b', { choice: win }]]);
    assert.equal(t.history[0].winner, 'b', `${win} should beat ${lose} from slot b`);
  }
});

test('rps: turnSlot is "both" while live', () => {
  assert.equal(rps.turnSlot(rps.createState()), 'both');
});

// ─── Tic Tac Toe ──────────────────────────────────────────────────────────

const TTT_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

test('ttt: all 8 win lines detected, from both slots', () => {
  for (const winner of ['a', 'b']) {
    for (const line of TTT_LINES) {
      const filler = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !line.includes(i));
      let s = ttt.createState({ starter: winner });
      const loser = winner === 'a' ? 'b' : 'a';
      // winner takes the line; loser takes harmless cells in between
      s = play(ttt, s, [
        [winner, { index: line[0] }], [loser, { index: filler[0] }],
        [winner, { index: line[1] }], [loser, { index: filler[1] }],
        [winner, { index: line[2] }],
      ]);
      assert.equal(s.over, true, `line ${line} not terminal`);
      assert.equal(s.winner, winner, `line ${line} wrong winner`);
      assert.deepEqual(s.line, line, `line ${line} not recorded`);
      assert.equal(s.draw, false);
      assert.equal(ttt.turnSlot(s), null);
    }
  }
});

test('ttt: full board with no line is a draw', () => {
  // a b a / a b b / b a a  → no three in a row
  const s = play(ttt, ttt.createState({ starter: 'a' }), [
    ['a', { index: 0 }], ['b', { index: 1 }], ['a', { index: 2 }],
    ['b', { index: 4 }], ['a', { index: 3 }], ['b', { index: 5 }],
    ['a', { index: 7 }], ['b', { index: 6 }], ['a', { index: 8 }],
  ]);
  assert.equal(s.over, true);
  assert.equal(s.draw, true);
  assert.equal(s.winner, null);
  assert.equal(s.line, null);
});

test('ttt: rejects occupied cells, wrong turn, and bad payloads', () => {
  let s = ttt.createState({ starter: 'a' });
  assert.equal(ttt.applyMove(s, 'b', { index: 0 }).error, 'not_your_turn');
  for (const bad of [{ index: -1 }, { index: 9 }, { index: '0' }, { index: 1.5 }, { index: undefined }, {}, null]) {
    assert.equal(ttt.applyMove(s, 'a', bad).error, 'bad_payload', `accepted ${JSON.stringify(bad)}`);
  }
  ({ state: s } = ttt.applyMove(s, 'a', { index: 4 }));
  assert.equal(ttt.applyMove(s, 'b', { index: 4 }).error, 'illegal_move');
});

test('ttt: applyMove is pure — the input state is never mutated', () => {
  const s = ttt.createState({ starter: 'a' });
  const snapshot = JSON.stringify(s);
  ttt.applyMove(s, 'a', { index: 0 });
  assert.equal(JSON.stringify(s), snapshot, 'applyMove mutated its argument');
});

test('ttt: rematch alternates the starter', () => {
  const first = ttt.createState({ starter: 'a' });
  assert.equal(ttt.rematchState(first).starter, 'b');
  assert.equal(ttt.rematchState(ttt.rematchState(first)).starter, 'a');
});

// ─── Connect 4 ────────────────────────────────────────────────────────────

// Drop a sequence of columns, alternating slots starting from `starter`.
const drop = (cols, starter = 'a') => {
  let s = c4.createState({ starter });
  let slot = starter;
  for (const col of cols) {
    const res = c4.applyMove(s, slot, { col });
    assert.equal(res.error, undefined, `unexpected error "${res.error}" dropping col ${col}`);
    s = res.state;
    slot = slot === 'a' ? 'b' : 'a';
  }
  return s;
};

test('c4: horizontal win at the left edge (cols 0-3)', () => {
  const s = drop([0, 0, 1, 1, 2, 2, 3]);
  assert.equal(s.over, true);
  assert.equal(s.winner, 'a');
  assert.equal(s.line.length, 4);
});

test('c4: horizontal win at the right edge (cols 3-6)', () => {
  const s = drop([3, 3, 4, 4, 5, 5, 6]);
  assert.equal(s.over, true);
  assert.equal(s.winner, 'a');
});

test('c4: vertical win in the leftmost and rightmost columns', () => {
  for (const col of [0, 6]) {
    const otherCol = col === 0 ? 1 : 5;
    const s = drop([col, otherCol, col, otherCol, col, otherCol, col]);
    assert.equal(s.over, true, `no vertical win in col ${col}`);
    assert.equal(s.winner, 'a');
  }
});

test('c4: rising diagonal win', () => {
  // a builds (0,0) (1,1) (2,2) (3,3)
  const s = drop([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
  assert.equal(s.over, true);
  assert.equal(s.winner, 'a');
  assert.equal(s.line.length, 4);
});

test('c4: falling diagonal win', () => {
  // mirror of the rising case across the board's vertical axis
  const s = drop([6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3]);
  assert.equal(s.over, true);
  assert.equal(s.winner, 'a');
});

test('c4: win detected at the top row — the scan must not run off the board', () => {
  // col0 fills bottom-up as [b,b,a,a,a,a]: a's four ends ON row 5, so the
  // upward scan steps to row 6 and must come back null rather than throw or
  // read into the next column.
  const s = drop([0, 1, 0, 0, 1, 0, 1, 0, 1, 0], 'b');
  assert.equal(s.over, true, 'top-row win not detected');
  assert.equal(s.winner, 'a');
  assert.equal(s.line.length, 4);
  assert.ok(s.line.some(([, row]) => row === c4.ROWS - 1), 'winning line should touch the top row');
  assert.equal(s.cols[0].length, c4.ROWS);
});

test('c4: rejects a full column, wrong turn, and bad payloads', () => {
  let s = c4.createState({ starter: 'a' });
  assert.equal(c4.applyMove(s, 'b', { col: 0 }).error, 'not_your_turn');
  for (const bad of [{ col: -1 }, { col: 7 }, { col: '0' }, { col: 2.5 }, { col: undefined }, {}, null]) {
    assert.equal(c4.applyMove(s, 'a', bad).error, 'bad_payload', `accepted ${JSON.stringify(bad)}`);
  }
  // Both players stack the same column: ownership alternates a,b,a,b,a,b, so
  // it fills to six without anyone getting four in a row.
  s = drop([0, 0, 0, 0, 0, 0]);
  assert.equal(s.over, false);
  assert.equal(s.cols[0].length, c4.ROWS);
  assert.equal(c4.applyMove(s, s.turn, { col: 0 }).error, 'illegal_move');
});

test('c4: applyMove is pure — the input state is never mutated', () => {
  const s = c4.createState({ starter: 'a' });
  const snapshot = JSON.stringify(s);
  c4.applyMove(s, 'a', { col: 3 });
  assert.equal(JSON.stringify(s), snapshot, 'applyMove mutated its argument');
});

// ─── Cross-cutting ────────────────────────────────────────────────────────

test('all: seq increments on every accepted move and never on a rejected one', () => {
  for (const [mod, slot, good, bad] of [
    [ttt, 'a', { index: 0 }, { index: 99 }],
    [c4, 'a', { col: 0 }, { col: 99 }],
    [rps, 'a', { choice: 'rock' }, { choice: 'nope' }],
  ]) {
    const s0 = mod.createState({ starter: 'a' });
    const { state: s1 } = mod.applyMove(s0, slot, good);
    assert.equal(s1.seq, s0.seq + 1, `${mod.id}: seq did not advance`);
    const rejected = mod.applyMove(s1, slot, bad);
    assert.ok(rejected.error, `${mod.id}: bad move was accepted`);
    assert.equal(rejected.state, undefined, `${mod.id}: rejected move returned a state`);
  }
});

test('all: every registered engine implements the full interface', () => {
  const { catalog, getGame } = require('./index');
  assert.ok(catalog.length >= 3);
  for (const entry of catalog) {
    const mod = getGame(entry.id);
    for (const fn of ['createState', 'applyMove', 'isTerminal', 'publicState', 'turnSlot', 'rematchState']) {
      assert.equal(typeof mod[fn], 'function', `${entry.id} is missing ${fn}()`);
    }
    assert.equal(mod.createState().seq, 0, `${entry.id}: createState must stamp seq 0`);
  }
  assert.equal(getGame('nope'), null);
  assert.equal(getGame(42), null);
});

if (process.exitCode) {
  console.error(`games: FAILED (${passed} passed)`);
} else {
  console.log(`games: ${passed} checks passed`);
}
