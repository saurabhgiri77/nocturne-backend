const { activeRooms, saveCallLog } = require('./matchmaking');

// Resolve the other socket in a room
const getPeer = (io, room, mySocketId) => {
  const peerSocketId = room.userA === mySocketId ? room.userB : room.userA;
  return io.sockets.sockets.get(peerSocketId);
};

const handleSignaling = (io, socket) => {
  // Initiator → Server → Receiver
  // Payload: { roomId: string, offer: RTCSessionDescriptionInit }
  socket.on('offer', ({ roomId, offer }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('offer', { offer });
  });

  // Receiver → Server → Initiator
  // Payload: { roomId: string, answer: RTCSessionDescriptionInit }
  socket.on('answer', ({ roomId, answer }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('answer', { answer });
  });

  // Both directions, trickle — called multiple times per connection
  // Payload: { roomId: string, candidate: RTCIceCandidateInit }
  socket.on('ice_candidate', ({ roomId, candidate }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('ice_candidate', { candidate });
  });

  // Peer media state (mic/camera on/off) — relay only
  // Payload: { roomId: string, micEnabled: boolean, cameraEnabled: boolean }
  socket.on('media_state', ({ roomId, micEnabled, cameraEnabled }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    getPeer(io, room, socket.id)?.emit('media_state', { micEnabled, cameraEnabled });
  });

  // Chat — relay only, NEVER persist to DB
  // Payload: { roomId: string, message: string }
  socket.on('chat_message', ({ roomId, message }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    if (!message || typeof message !== 'string' || message.trim().length === 0)
      return;
    const peer = getPeer(io, room, socket.id);
    peer?.emit('chat_message', {
      message: message.trim(),
      from: socket.user.id,
      timestamp: new Date().toISOString(),
    });
    // No DB write — chat is ephemeral by design
  });

  // Voluntary skip / end call
  // Payload: { roomId: string }
  socket.on('end_call', async ({ roomId }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;

    const peer = getPeer(io, room, socket.id);
    const endedBy = room.userA === socket.id ? 'userA' : 'userB';

    peer?.emit('call_ended', { reason: 'peer_skipped' });
    if (peer) peer.roomId = null;
    socket.roomId = null;

    await saveCallLog(room, endedBy);
    activeRooms.delete(roomId);
  });
};

module.exports = { handleSignaling };
