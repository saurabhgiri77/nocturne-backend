// Tic-Tac-Toe. Slot 'a' renders as X, 'b' as O — the client pairs each with a
// distinct colour AND glyph, never colour alone.

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const other = (slot) => (slot === 'a' ? 'b' : 'a');

const createState = ({ starter = 'a' } = {}) => ({
  seq: 0,
  board: Array(9).fill(null), // null | 'a' | 'b'
  turn: starter,
  starter,
  last: null, // { index, slot } — the cell just played, for the client's animation
  over: false,
  winner: null,
  draw: false,
  line: null,
});

const isTerminal = (state) => {
  for (const line of LINES) {
    const [x, y, z] = line;
    const v = state.board[x];
    if (v && v === state.board[y] && v === state.board[z]) {
      return { over: true, winnerSlot: v, draw: false, line };
    }
  }
  if (state.board.every(Boolean)) return { over: true, winnerSlot: null, draw: true, line: null };
  return { over: false };
};

const applyMove = (state, slot, move) => {
  if (state.over) return { error: 'game_over' };
  if (slot !== state.turn) return { error: 'not_your_turn' };
  const i = move?.index;
  if (!Number.isInteger(i) || i < 0 || i > 8) return { error: 'bad_payload' };
  if (state.board[i] !== null) return { error: 'illegal_move' };

  const board = state.board.slice();
  board[i] = slot;
  const next = { ...state, seq: state.seq + 1, board, turn: other(slot), last: { index: i, slot } };

  const term = isTerminal(next);
  if (term.over) {
    next.over = true;
    next.winner = term.winnerSlot;
    next.draw = !!term.draw;
    next.line = term.line;
    next.turn = null;
  }
  return { state: next };
};

const publicState = (s) => s; // nothing hidden — still routed through here so the transport stays uniform
const turnSlot = (s) => (s.over ? null : s.turn);
const rematchState = (prev) => createState({ starter: other(prev?.starter || 'a') });

module.exports = {
  id: 'tictactoe',
  title: 'Tic Tac Toe',
  minPlayers: 2,
  maxPlayers: 2,
  allowGuests: true,
  createState,
  applyMove,
  isTerminal,
  publicState,
  turnSlot,
  rematchState,
};
