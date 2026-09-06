// Rock–Paper–Scissors, best of 3.
//
// Best of 3 rather than 5: this has to finish inside the attention span of a
// stranger call. bo5 averages ~4.2 rounds against bo3's ~2.7, and every round
// costs a full client→server→client round trip.
//
// SIMULTANEOUS HIDDEN MOVES. `state.pending` is secret and never leaves the
// server — publicState() reduces it to two booleans. The string 'rock'
// physically does not cross the socket until BOTH players have irrevocably
// committed, at which point there is nothing left to gain by knowing it.
// That is strictly stronger than a commit-reveal hash scheme, which you'd
// only need if the server itself were untrusted. It isn't; it's ours.

const CHOICES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const TARGET = 2; // first to 2 round wins

const other = (slot) => (slot === 'a' ? 'b' : 'a');

const createState = () => ({
  seq: 0,
  round: 1,
  scores: { a: 0, b: 0 },
  pending: { a: null, b: null }, // ← SECRET. Never serialised to a client.
  history: [],                   // [{ a, b, winner: 'a'|'b'|null }] — written only after both commit
  over: false,
  winner: null,
});

const applyMove = (state, slot, move) => {
  if (state.over) return { error: 'game_over' };
  // Whitelist membership BEFORE any BEATS[...] lookup — never index an object
  // with attacker-controlled input.
  if (!move || !CHOICES.includes(move.choice)) return { error: 'illegal_move' };
  // No changing your mind. Combined with the fact that you cannot observe the
  // opponent's choice, this single rule is the entire anti-cheat surface.
  if (state.pending[slot] !== null) return { error: 'not_your_turn' };

  const pending = { ...state.pending, [slot]: move.choice };
  const next = {
    ...state,
    seq: state.seq + 1,
    pending,
    scores: { ...state.scores },
    history: state.history,
  };

  if (pending.a !== null && pending.b !== null) {
    const winner = pending.a === pending.b ? null : BEATS[pending.a] === pending.b ? 'a' : 'b';
    next.history = [...state.history, { a: pending.a, b: pending.b, winner }];
    if (winner) next.scores[winner] += 1;
    next.pending = { a: null, b: null };
    next.round = state.round + 1;
    if (next.scores.a >= TARGET || next.scores.b >= TARGET) {
      next.over = true;
      next.winner = next.scores.a >= TARGET ? 'a' : 'b';
    }
  }

  return { state: next };
};

const isTerminal = (state) =>
  state.over ? { over: true, winnerSlot: state.winner, draw: false } : { over: false };

// The ONLY projection that reaches a client. `pending` is stripped entirely.
const publicState = (s, viewer) => ({
  seq: s.seq,
  round: s.round,
  scores: s.scores,
  target: TARGET,
  youCommitted: s.pending[viewer] !== null,
  peerCommitted: s.pending[other(viewer)] !== null,
  history: s.history,
  over: s.over,
  winner: s.winner,
});

// Both players may always move; there is no turn order.
const turnSlot = (s) => (s.over ? null : 'both');

const rematchState = () => createState();

module.exports = {
  id: 'rps',
  title: 'Rock Paper Scissors',
  minPlayers: 2,
  maxPlayers: 2,
  allowGuests: true,
  createState,
  applyMove,
  isTerminal,
  publicState,
  turnSlot,
  rematchState,
  CHOICES,
};
