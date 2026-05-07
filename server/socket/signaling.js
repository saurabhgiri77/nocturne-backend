const { activeRooms, saveCallLog } = require('./matchmaking');
const { checkSocketLimit } = require('./rateLimit');

const MAX_CHAT_LENGTH = 1000;

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

const handleSignaling = (io, socket) => {
  // Initiator → Server → Receiver
  socket.on('offer', ({ roomId, offer }) => {
    const room = memberRoom(roomId, socket.id);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('offer', { offer });
  });

  // Receiver → Server → Initiator
  socket.on('answer', ({ roomId, answer }) => {
    const room = memberRoom(roomId, socket.id);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('answer', { answer });
  });

  // Both directions, trickle
  socket.on('ice_candidate', ({ roomId, candidate }) => {
    if (!checkSocketLimit(socket, 'ice_candidate')) return;
    const room = memberRoom(roomId, socket.id);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('ice_candidate', { candidate });
  });

  // Peer media state (mic/camera on/off)
  socket.on('media_state', ({ roomId, micEnabled, cameraEnabled }) => {
    if (!checkSocketLimit(socket, 'media_state')) return;
    const room = memberRoom(roomId, socket.id);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('media_state', {
      micEnabled: !!micEnabled,
      cameraEnabled: !!cameraEnabled,
    });
  });

  // Chat — relay only, NEVER persist
  socket.on('chat_message', ({ roomId, message }) => {
    if (!checkSocketLimit(socket, 'chat_message')) return;
    const room = memberRoom(roomId, socket.id);
    if (!room) return;
    if (!message || typeof message !== 'string') return;
    const trimmed = message.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_CHAT_LENGTH) return;
    const peer = getPeer(io, room, socket.id);
    peer?.emit('chat_message', {
      message: trimmed,
      from: socket.user.id,
      timestamp: new Date().toISOString(),
    });
  });

  // Reconnection probe. Frontend re-emits this with its current roomId
  // after a socket reconnect. If the room is gone (e.g. backend restarted
  // mid-call and wiped the in-memory activeRooms map), the server tells
  // the client it's been orphaned so the UI can bounce to the lobby
  // instead of sitting in stale "Connecting..." forever.
  socket.on('check_room', ({ roomId }) => {
    if (typeof roomId !== 'string') return;
    const room = activeRooms.get(roomId);
    if (!room) {
      socket.emit('match_lost', { roomId });
      socket.roomId = null;
    } else if (room.userA !== socket.id && room.userB !== socket.id) {
      // Caller claims to be in a room they're not actually a member of.
      // Same outcome — lost.
      socket.emit('match_lost', { roomId });
    } else {
      // Re-attach socket.roomId so end_call / disconnect cleanup still works.
      socket.roomId = roomId;
    }
  });

  // Voluntary skip / end call
  socket.on('end_call', async ({ roomId }) => {
    const room = memberRoom(roomId, socket.id);
    if (!room) return;

    const peer = getPeer(io, room, socket.id);
    const endedBy = room.userA === socket.id ? 'userA' : 'userB';

    peer?.emit('call_ended', { reason: 'peer_skipped', roomId });
    if (peer) peer.roomId = null;
    socket.roomId = null;

    await saveCallLog(room, endedBy);
    activeRooms.delete(roomId);
  });
};

module.exports = { handleSignaling };
