const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require("dotenv").config({ path: path.join(__dirname, `../${envFile}`) });
const connectDB = require("./config/db");

const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["polling", "websocket"],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json());

connectDB();

app.use("/api/auth", require("./routes/auth"));

const { initSocket } = require("./socket");
initSocket(io);

app.get("/health", (_req, res) => res.json({ status: "ok", ts: new Date() }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
