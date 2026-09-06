// Connect 4, 7 columns × 6 rows.
//
// Stored as COLUMNS, bottom-up: gravity is a push, fullness is O(1), and the
// win scan only ever looks outward from the cell just placed — O(1) per move,
// and far easier to get right at the board edges than a full-board sweep.

const COLS = 7;
const ROWS = 6;
const NEED = 4;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

const other = (slot) => (slot === 'a' ? 'b' : 'a');
const at = (cols, c, r) => (c < 0 || c >= COLS || r < 0 || r >= ROWS ? null : cols[c][r] ?? null);

const createState = ({ starter = 'a' } = {}) => ({
  seq: 0,
  cols: Array.from({ length: COLS }, () => []), // each ≤ ROWS, index 0 = bottom
  turn: starter,
  starter,
  last: null, // { col, row, slot }
  over: false,
  winner: null,
  draw: false,
  line: null,
});

// Only meaningful immediately after a placement — scans outward from state.last.
const isTerminal = (state) => {
  const last = state.last;
  if (last) {
    const { col, row, slot } = last;
    for (const [dc, dr] of DIRS) {
      const cells = [[col, row]];
      for (const sign of [1, -1]) {
        let c = col + dc * sign;
        let r = row + dr * sign;
        while (at(state.cols, c, r) === slot) {
          cells.push([c, r]);
          c += dc * sign;
          r += dr * sign;
        }
      }
      if (cells.length >= NEED) {
        return { over: true, winnerSlot: slot, draw: false, line: cells.slice(0, NEED) };
      }
    }
  }
  if (state.cols.every((c) => c.length === ROWS)) {
    return { over: true, winnerSlot: null, draw: true, line: null };
  }
  return { over: false };
};

const applyMove = (state, slot, move) => {
  if (state.over) return { error: 'game_over' };
  if (slot !== state.turn) return { error: 'not_your_turn' };
  const c = move?.col;
  if (!Number.isInteger(c) || c < 0 || c >= COLS) return { error: 'bad_payload' };
  if (state.cols[c].length >= ROWS) return { error: 'illegal_move' };

  const cols = state.cols.map((col, i) => (i === c ? [...col, slot] : col));
  const row = cols[c].length - 1;
  const next = {
    ...state,
    seq: state.seq + 1,
    cols,
    turn: other(slot),
    last: { col: c, row, slot },
  };

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

const publicState = (s) => s;
const turnSlot = (s) => (s.over ? null : s.turn);
const rematchState = (prev) => createState({ starter: other(prev?.starter || 'a') });

module.exports = {
  id: 'connect4',
  title: 'Connect 4',
  minPlayers: 2,
  maxPlayers: 2,
  allowGuests: true,
  createState,
  applyMove,
  isTerminal,
  publicState,
  turnSlot,
  rematchState,
  COLS,
  ROWS,
};
