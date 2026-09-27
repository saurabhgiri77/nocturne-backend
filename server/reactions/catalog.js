// Camera-reaction labels — the CLOSED set a client may send. The client never
// sends a GIF or a URL, only one of these ids; the server picks the GIF. That
// is the whole safety model: a stranger cannot push an arbitrary image to
// their peer, only choose which of our G-rated pools it comes from.
//
// Keep in sync with nocturne-frontend/src/reactions/labels.js — ids MUST match.
//
// Deliberately absent: `kiss` (unwelcome between strangers), `sad` (blendshapes
// can't tell it from resting face), and the Closed_Fist / Pointing_Up gestures
// (both fire constantly while people talk with their hands).
const entries = [
  ['thumbs_up',   { query: 'thumbs up' }],
  ['thumbs_down', { query: 'thumbs down' }],
  ['peace',       { query: 'peace sign' }],
  ['love',        { query: 'love you' }],
  ['wave',        { query: 'hello wave' }],
  ['laugh',       { query: 'laughing' }],
  ['surprise',    { query: 'shocked' }],
  ['wink',        { query: 'wink' }],
];

// A Map, not an object literal, so '__proto__' / 'constructor' / 'toString'
// are simply absent rather than inherited.
const byLabel = new Map(entries);

const LABELS = Object.freeze(entries.map(([id]) => id));
const isLabel = (x) => typeof x === 'string' && byLabel.has(x);
const queryFor = (label) => byLabel.get(label)?.query ?? null;

module.exports = { LABELS, isLabel, queryFor };
