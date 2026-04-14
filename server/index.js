const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const connectDB = require('./config/db');

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());

connectDB();

app.use('/api/auth', require('./routes/auth'));

const { initSocket } = require('./socket');
initSocket(io);

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
