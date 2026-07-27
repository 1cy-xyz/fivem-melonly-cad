const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

// Ensure SQLite fallback for local development before Prisma initializes
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./dev.db";
}

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ========================================================
// GLOBAL MIDDLEWARE
// ========================================================
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ========================================================
// ROUTE IMPORTS & MOUNTING
// ========================================================
const erlcRouter = require('./erlc-router');
const { registerWarrantSocketHandlers } = require('./warrants-handler');
const { registerDispatchSocketHandlers } = require('./dispatch-handler');

// Mount ER:LC API Router
app.use('/api/erlc', erlcRouter);

// --- AUTHENTICATION & MULTI-TENANT MANAGEMENT ---

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hashedPassword }
    });
    res.status(201).json({ message: 'User created successfully', userId: user.id });
  } catch (err) {
    res.status(400).json({ error: 'Username already exists or invalid request' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findUnique({ where: { username } });
  
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, cadId: user.cadId, role: user.role }, JWT_SECRET);
  res.json({ token, role: user.role, cadId: user.cadId });
});

app.post('/api/cad/create', authenticateToken, async (req, res) => {
  const { name, joinCode } = req.body;
  
  try {
    const defaultDepartments = JSON.stringify(['LSPD', 'BCSO', 'SAHP', 'SAFR', 'Dispatch']);
    const defaultStatuses = JSON.stringify(['10-8 Available', '10-7 Unavailable', '10-6 Busy', '10-23 En Route', '10-97 On Scene']);
    const defaultPenalCode = JSON.stringify([
      { title: 'Speeding (15-25 MPH Over)', fine: 150, jailTime: 0 },
      { title: 'Reckless Endangerment', fine: 500, jailTime: 300 }
    ]);

    const newCad = await prisma.cadServer.create({
      data: {
        name,
        joinCode,
        ownerId: req.user.id,
        departments: defaultDepartments,
        statusCodes: defaultStatuses,
        penalCode: defaultPenalCode
      }
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { cadId: newCad.id, role: 'OWNER' }
    });

    res.json({ message: 'CAD Created successfully', cad: newCad });
  } catch (err) {
    res.status(400).json({ error: 'CAD creation failed or join code taken' });
  }
});

app.post('/api/cad/join', authenticateToken, async (req, res) => {
  const { joinCode } = req.body;
  const cad = await prisma.cadServer.findUnique({ where: { joinCode } });

  if (!cad) return res.status(404).json({ error: 'Invalid CAD Join Code' });

  await prisma.user.update({
    where: { id: req.user.id },
    data: { cadId: cad.id, role: 'CIVILIAN' }
  });

  res.json({ message: 'Successfully joined CAD', cadId: cad.id });
});

// --- OWNER CUSTOMIZATION ---

app.put('/api/cad/customize', authenticateToken, async (req, res) => {
  if (req.user.role !== 'OWNER') return res.status(403).json({ error: 'Only server owners can customize settings' });

  const { name, departments, statusCodes, penalCode, joinCode } = req.body;

  const updatedCad = await prisma.cadServer.update({
    where: { id: req.user.cadId },
    data: {
      ...(name && { name }),
      ...(joinCode && { joinCode }),
      ...(departments && { departments: JSON.stringify(departments) }),
      ...(statusCodes && { statusCodes: JSON.stringify(statusCodes) }),
      ...(penalCode && { penalCode: JSON.stringify(penalCode) })
    }
  });

  res.json({ message: 'CAD Customizations updated', cad: updatedCad });
});

// --- MDT / LEO / DISPATCH ROUTES ---

app.get('/api/mdt/search/person', authenticateToken, async (req, res) => {
  const { name } = req.query;
  const results = await prisma.civilian.findMany({
    where: {
      cadId: req.user.cadId,
      fullName: { contains: name }
    },
    include: { vehicles: true, firearms: true, records: true }
  });
  res.json(results);
});

app.post('/api/mdt/records', authenticateToken, async (req, res) => {
  const { civilianId, type, charges, fine } = req.body;
  
  const record = await prisma.record.create({
    data: {
      civilianId,
      type,
      charges: JSON.stringify(charges),
      fine: Number(fine),
      officer: req.user.username
    }
  });

  res.json({ message: 'Record created', record });
});

// Fallback Route: Serve index.html for unknown frontend routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// ========================================================
// SOCKET.IO REAL-TIME EVENT HANDLING
// ========================================================
io.on('connection', (socket) => {
  console.log(`[SOCKET connected] ID: ${socket.id}`);

  // Modular handlers
  try { registerWarrantSocketHandlers(io, socket); } catch (e) {}
  try { registerDispatchSocketHandlers(io, socket); } catch (e) {}

  // CAD Room Subscription
  socket.on('joinCadRoom', (cadId) => {
    socket.join(`cad_${cadId}`);
    console.log(`[Room] Socket ${socket.id} joined cad_${cadId}`);
  });

  // Call Creation
  socket.on('createCall', async (data) => {
    const { cadId, title, location, description } = data;
    try {
      const call = await prisma.call.create({
        data: { cadId, title, location, description, assignedUnits: JSON.stringify([]) }
      });
      io.to(`cad_${cadId}`).emit('callUpdated', call);
    } catch (e) {
      console.error('[Prisma Call Error]', e);
      // Fallback broadcast if DB is unmigrated
      io.to(`cad_${cadId}`).emit('callUpdated', { title, location, description });
    }
  });

  // Unit Status Changes
  socket.on('updateUnitStatus', (data) => {
    const { cadId, unitId, status, isPanic } = data;
    io.to(`cad_${cadId}`).emit('unitStatusChanged', {
      unitId,
      status,
      isPanic: isPanic || false,
      timestamp: new Date()
    });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET disconnected] ID: ${socket.id} | Reason: ${reason}`);
  });
});

// Track active units in-memory per CAD room (cadId -> Map(socketId -> unitData))
const activeCadUnits = new Map();

io.on('connection', (socket) => {
  console.log(`[SOCKET connected] ID: ${socket.id}`);

  // Modular handlers
  try { registerWarrantSocketHandlers(io, socket); } catch (e) {}
  try { registerDispatchSocketHandlers(io, socket); } catch (e) {}

  // CAD Room Subscription & On-Duty Tracking
  socket.on('joinCadRoom', (cadId) => {
    socket.join(`cad_${cadId}`);
    socket.cadId = cadId;
    console.log(`[Room] Socket ${socket.id} joined cad_${cadId}`);
  });

  // Handle Standard 911 Call Creation
  socket.on('createCall', async (data) => {
    const { cadId, title, location, description } = data;
    try {
      // Count total calls to generate a readable Call Number (e.g., #101)
      const callCount = await prisma.call.count({ where: { cadId: Number(cadId) || 0 } });
      const callNumber = `#${101 + callCount}`;

      const call = await prisma.call.create({
        data: {
          cadId: Number(cadId) || 0,
          title: `${callNumber} - ${title}`,
          location,
          description: description || 'No additional details.',
          assignedUnits: JSON.stringify([])
        }
      });

      io.to(`cad_${cadId}`).emit('callUpdated', call);
    } catch (e) {
      console.error('[Prisma Call Error]', e);
      // Fallback for unmigrated or temporary DB
      const fallbackCall = {
        id: Date.now(),
        title: `#${Math.floor(100 + Math.random() * 900)} - ${title}`,
        location,
        description,
        assignedUnits: JSON.stringify([])
      };
      io.to(`cad_${cadId}`).emit('callUpdated', fallbackCall);
    }
  });

  // Assign Officer/Unit to Call
  socket.on('assignUnitToCall', async (data) => {
    const { cadId, callId, unitId } = data;
    try {
      const existingCall = await prisma.call.findUnique({ where: { id: Number(callId) } });
      if (existingCall) {
        let assigned = JSON.parse(existingCall.assignedUnits || '[]');
        if (!assigned.includes(unitId)) {
          assigned.push(unitId);
        }
        const updated = await prisma.call.update({
          where: { id: Number(callId) },
          data: { assignedUnits: JSON.stringify(assigned) }
        });
        io.to(`cad_${cadId}`).emit('callUpdated', updated);
      }
    } catch (e) {
      console.error('[Assign Unit Error]', e);
    }
  });

  // Handle Unit Status & Emergency Panic Button Triggers
  socket.on('updateUnitStatus', async (data) => {
    const { cadId, unitId, status, isPanic } = data;

    // Register active unit in room memory
    if (!activeCadUnits.has(cadId)) activeCadUnits.set(cadId, new Map());
    activeCadUnits.get(cadId).set(socket.id, unitId);

    // Broadcast unit status change
    io.to(`cad_${cadId}`).emit('unitStatusChanged', {
      unitId,
      status: isPanic ? '🚨 PANIC / OFFICER IN DISTRESS' : status,
      isPanic: isPanic || false,
      timestamp: new Date()
    });

    // IF PANIC BUTTON PRESSED: Automatically create emergency call & attach ALL active units
    if (isPanic) {
      const allActiveUnits = Array.from(activeCadUnits.get(cadId).values());
      const uniqueUnits = [...new Set(allActiveUnits)];

      try {
        const callCount = await prisma.call.count({ where: { cadId: Number(cadId) || 0 } });
        const callNumber = `#${101 + callCount}`;

        const panicCall = await prisma.call.create({
          data: {
            cadId: Number(cadId) || 0,
            title: `🚨 EMERGENCY ${callNumber} - OFFICER PANIC ACTIVATED (${unitId})`,
            location: 'GPS Emergency Broadcast / Last Known Location',
            description: `OFFICER DOWN / PANIC BUTTON TRIGGERED BY ${unitId}. ALL ON-DUTY UNITS ATTACHED IMMEDIATELY.`,
            assignedUnits: JSON.stringify(uniqueUnits)
          }
        });

        io.to(`cad_${cadId}`).emit('callUpdated', panicCall);
      } catch (e) {
        console.error('[Panic Call Creation Error]', e);
        // Fallback emergency call broadcast
        io.to(`cad_${cadId}`).emit('callUpdated', {
          id: Date.now(),
          title: `🚨 EMERGENCY #${Math.floor(100 + Math.random() * 900)} - OFFICER PANIC (${unitId})`,
          location: 'GPS Emergency Broadcast',
          description: `OFFICER PANIC TRIGGERED BY ${unitId}. ALL UNITS ATTACHED.`,
          assignedUnits: JSON.stringify(uniqueUnits)
        });
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.cadId && activeCadUnits.has(socket.cadId)) {
      activeCadUnits.get(socket.cadId).delete(socket.id);
    }
    console.log(`[SOCKET disconnected] ID: ${socket.id}`);
  });
});

// ========================================================
// SERVER STARTUP
// ========================================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 CAD Engine running on port ${PORT}`));
