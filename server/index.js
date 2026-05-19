const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require("dotenv").config({ path: path.join(__dirname, `../${envFile}`) });
const connectDB = require("./config/db");

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
// Render / Netlify / Cloudflare etc. terminate TLS in front of us. Trust the
// first proxy hop so `req.ip` reflects the real client (used for IP-geo on
// signup). One hop is conservative; bump if you stack proxies later.
app.set('trust proxy', 1);
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
  transports: ["polling", "websocket"],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Security headers (X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security
// in prod, Referrer-Policy, etc). CSP is disabled because we serve JSON-only — CSP
// applies to HTML responses, not API JSON.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '100kb' }));

connectDB();

app.use("/api/auth", require("./routes/auth"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/friends", require("./routes/friends"));
app.use("/api/messages", require("./routes/messages"));

// Expose the io instance to routes (e.g. friends.js emits friend_request_received
// to the recipient's user room). Reach via `req.app.get('io')`.
app.set('io', io);

const { initSocket } = require("./socket");
initSocket(io);

app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date() }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
