const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const { registerDispatchSocketHandlers } = require('./dispatch-handler');
const { registerWarrantSocketHandlers } = require('./warrants-handler');

io.on('connection', (socket) => {
  // Register UK Dispatch socket events
  registerDispatchSocketHandlers(io, socket);

  // Register PNC Warrants socket events
  registerWarrantSocketHandlers(io, socket);
});

// Fallback for DATABASE_URL if running locally with SQLite
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./dev.db";
}

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this';

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- MIDDLEWARE ---
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

// --- REAL-TIME SOCKET.IO ---

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('joinCadRoom', (cadId) => {
    socket.join(`cad_${cadId}`);
  });

  socket.on('createCall', async (data) => {
    const { cadId, title, location, description } = data;
    try {
      const call = await prisma.call.create({
        data: { cadId, title, location, description, assignedUnits: JSON.stringify([]) }
      });
      io.to(`cad_${cadId}`).emit('callUpdated', call);
    } catch (e) {
      console.error(e);
    }
  });

  socket.on('updateUnitStatus', (data) => {
    const { cadId, unitId, status, isPanic } = data;
    io.to(`cad_${cadId}`).emit('unitStatusChanged', {
      unitId,
      status,
      isPanic: isPanic || false,
      timestamp: new Date()
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`CAD Engine running on port ${PORT}`));
