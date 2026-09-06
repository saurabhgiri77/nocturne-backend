// Game registry. Every engine is a pure module — it never touches sockets,
// never touches Mongo, and never mutates the state it is handed. That is what
// makes them unit-testable without a test framework (see __check.js) and what
// keeps the socket layer game-agnostic.
const mods = [
  require('./rps'),
  require('./tictactoe'),
  require('./connect4'),
];

const byId = new Map(mods.map((m) => [m.id, m]));

const getGame = (id) => (typeof id === 'string' ? byId.get(id) : undefined) || null;

// Wire-safe catalog: metadata only, no functions, no secrets. Served verbatim.
const catalog = mods.map(({ id, title, minPlayers, maxPlayers, allowGuests }) => ({
  id, title, minPlayers, maxPlayers, allowGuests,
}));

module.exports = { getGame, catalog };
