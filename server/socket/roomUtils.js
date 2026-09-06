// Room membership primitives, shared by every handler that relays inside a
// call (signaling, games). Extracted from signaling.js so there is exactly
// ONE copy — this is the codebase's most security-critical helper and a
// second copy would mean a future fix lands in only one of them.
const { activeRooms } = require('./matchmaking');

// Two membership tests:
//  - isMember: socket is in the room (sender allowed)
//  - getPeer: returns the OTHER socket in the room (receiver)
// We must verify isMember on every incoming event — otherwise any
// authenticated socket that knows a roomId can inject SDP/ICE/chat into
// any call, MITM the WebRTC handshake, or end a call they aren't in.
const isMember = (room, mySocketId) =>
  room.userA === mySocketId || room.userB === mySocketId;

const getPeer = (io, room, mySocketId) => {
  const peerSocketId = room.userA === mySocketId ? room.userB : room.userA;
  return io.sockets.sockets.get(peerSocketId);
};

// Look up the room and verify the sender is a member. Returns null on
// either failure so handlers can early-return cleanly.
const memberRoom = (roomId, mySocketId) => {
  if (typeof roomId !== 'string') return null;
  const room = activeRooms.get(roomId);
  if (!room) return null;
  if (!isMember(room, mySocketId)) return null;
  return room;
};

// Slot identity for the game layer. Mirrors the vocabulary saveCallLog
// already uses for `endedBy` ('userA' | 'userB'), so a game slot and a
// call-log participant always name the same person. Slot 'a' is always the
// WebRTC initiator — which is NOT random with respect to who queued first,
// so games must never let 'a' be the permanent first mover.
const slotOf = (room, mySocketId) =>
  room.userA === mySocketId ? 'a' : room.userB === mySocketId ? 'b' : null;

// Membership by USER id rather than socket id. HTTP routes have no socket,
// so this is the only way a REST endpoint can authorise a caller against a
// live call. Guests are covered too: their gid is what lands in userAId.
const memberRoomByUserId = (roomId, userId) => {
  if (typeof roomId !== 'string') return null;
  const room = activeRooms.get(roomId);
  if (!room) return null;
  const uid = String(userId);
  if (String(room.userAId) !== uid && String(room.userBId) !== uid) return null;
  return room;
};

module.exports = { isMember, getPeer, memberRoom, slotOf, memberRoomByUserId };
