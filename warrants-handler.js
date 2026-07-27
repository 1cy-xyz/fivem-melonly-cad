// In-memory PNC storage for warrants and custody logs
const warrants = [
  { id: 'PNC-90112', subjectName: 'John Doe', charges: 'Failure to Appear / Theft', severity: 'Summary Offence', status: 'ACTIVE' },
  { id: 'PNC-88401', subjectName: 'Speedy Driver', charges: 'Dangerous Driving / Fail to Stop', severity: 'Indictable Offence', status: 'ACTIVE' }
];

const arrests = [
  { id: 'CUST-102', subjectName: 'John Doe', officer: 'PC 104 Davies', charges: 'Section 4 Public Order' }
];

function registerWarrantSocketHandlers(io, socket) {
  // Send initial PNC data to newly connected client
  socket.emit('warrants:initialData', { warrants, arrests });

  // Issue a new PNC wanted alert
  socket.on('warrants:issue', (data) => {
    const newWarrant = {
      id: 'PNC-' + Math.floor(10000 + Math.random() * 90000),
      subjectName: data.subjectName,
      charges: data.charges,
      severity: data.severity || 'Summary Offence',
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    };

    warrants.push(newWarrant);
    io.emit('warrants:added', newWarrant);
  });

  // Log a custody / arrest record
  socket.on('arrests:log', (data) => {
    const newArrest = {
      id: 'CUST-' + Math.floor(100 + Math.random() * 900),
      subjectName: data.subjectName,
      officer: data.officer,
      charges: data.charges,
      loggedAt: new Date().toISOString()
    };

    arrests.push(newArrest);
    io.emit('arrests:added', newArrest);
  });

  // Clear / execute a PNC warrant
  socket.on('warrants:serve', (warrantId) => {
    const target = warrants.find(w => w.id === warrantId);
    if (target) {
      target.status = 'EXECUTED';
      io.emit('warrants:updated', target);
    }
  });
}

module.exports = {
  warrants,
  arrests,
  registerWarrantSocketHandlers
};
