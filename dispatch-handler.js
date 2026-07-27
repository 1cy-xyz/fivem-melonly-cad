// In-memory CAD dispatch calls & active unit statuses
const activeCalls = [];
const activeUnits = new Map();

function registerDispatchSocketHandlers(io, socket) {
  // Send current state upon connection
  socket.emit('dispatch:initialData', {
    calls: activeCalls,
    units: Array.from(activeUnits.values())
  });

  // Unit updates their operational status (e.g., 10-8 / On Scene / En Route)
  socket.on('dispatch:updateUnitStatus', (unitData) => {
    activeUnits.set(socket.id, {
      socketId: socket.id,
      callsign: unitData.callsign || 'PC-00',
      name: unitData.name || 'Constable',
      status: unitData.status || 'AVAILABLE',
      division: unitData.division || 'Response',
      assignedCallId: unitData.assignedCallId || null
    });

    io.emit('dispatch:unitsUpdated', Array.from(activeUnits.values()));
  });

  // Control Room / Officer creates a new 999 Incident Call
  socket.on('dispatch:createCall', (callData) => {
    const newCall = {
      id: 'CAD-' + Math.floor(1000 + Math.random() * 9000),
      location: callData.location || 'Unknown Location',
      title: callData.title || 'Grade 1 Emergency',
      grade: callData.grade || 'Grade 1 (Immediate)',
      details: callData.details || 'No additional details provided.',
      assignedUnits: [],
      status: 'OPEN',
      timestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    };

    activeCalls.unshift(newCall);
    io.emit('dispatch:callCreated', newCall);
  });

  // Assign or detach unit from a 999 CAD Call
  socket.on('dispatch:assignUnit', ({ callId, callsign }) => {
    const call = activeCalls.find(c => c.id === callId);
    if (call && !call.assignedUnits.includes(callsign)) {
      call.assignedUnits.push(callsign);
      io.emit('dispatch:callUpdated', call);
    }
  });

  // Close / Clear CAD Call
  socket.on('dispatch:closeCall', (callId) => {
    const index = activeCalls.findIndex(c => c.id === callId);
    if (index !== -1) {
      activeCalls[index].status = 'CLOSED';
      io.emit('dispatch:callClosed', callId);
    }
  });

  // Remove unit on disconnect
  socket.on('disconnect', () => {
    if (activeUnits.has(socket.id)) {
      activeUnits.delete(socket.id);
      io.emit('dispatch:unitsUpdated', Array.from(activeUnits.values()));
    }
  });
}

module.exports = { registerDispatchSocketHandlers };
