import 'dotenv/config';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_NAME = 'relay_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MESSAGES = 160;
const MAX_MESSAGE_LENGTH = 6000;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readCookie(header = '', name = COOKIE_NAME) {
  for (const part of header.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(valueParts.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}

function normalizeDeviceName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
}

function lanAddresses() {
  const values = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) values.push(entry.address);
    }
  }
  return [...new Set(values)];
}

export function createRelay({ password, sessionSecret, port = 3000, trustProxy = false } = {}) {
  if (!password || !sessionSecret) throw new Error('ROOM_PASSWORD and SESSION_SECRET are required.');

  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '12kb' }));
  app.use(express.static(path.join(ROOT, 'public'), { etag: true, maxAge: '1h' }));

  const sessions = new Map();
  const messages = [];
  const loginAttempts = new Map();
  const expectedPasswordHash = crypto.scryptSync(password, sessionSecret, 32);
  const sessionCookieOptions = (req) => [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(req.secure ? ['Secure'] : []),
    'Max-Age=0'
  ].join('; ');

  const server = createServer(app);
  const io = new SocketServer(server, { serveClient: true, maxHttpBufferSize: 16_000 });

  function getSession(req) {
    const token = readCookie(req.headers.cookie);
    if (!token) return null;
    const key = digest(token);
    const session = sessions.get(key);
    if (!session || session.expiresAt < Date.now()) {
      sessions.delete(key);
      return null;
    }
    return { key, ...session };
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt < now) sessions.delete(key);
  }

  function attemptRecord(ip) {
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (!attempt || attempt.windowEndsAt < now) {
      loginAttempts.set(ip, { count: 0, windowEndsAt: now + 15 * 60 * 1000 });
    }
    return loginAttempts.get(ip);
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/session', (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Join with the room password to continue.' });
    return res.json({ deviceName: session.deviceName, deviceId: session.deviceId, expiresAt: session.expiresAt });
  });

  app.post('/api/session', (req, res) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (attemptRecord(ip).count >= 8) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });

    const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
    const submittedHash = crypto.scryptSync(submitted.slice(0, 256), sessionSecret, 32);
    const passwordMatches = crypto.timingSafeEqual(expectedPasswordHash, submittedHash);
    const deviceName = normalizeDeviceName(req.body?.deviceName) || 'My computer';
    if (!passwordMatches) {
      attemptRecord(ip).count += 1;
      return res.status(401).json({ error: 'That room password did not match.' });
    }

    loginAttempts.delete(ip);
    pruneSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    const key = digest(token);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const deviceId = crypto.randomUUID();
    sessions.set(key, { deviceName, deviceId, expiresAt });
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${req.secure ? '; Secure' : ''}`);
    return res.json({ deviceName, deviceId, expiresAt });
  });

  app.post('/api/logout', (req, res) => {
    const session = getSession(req);
    if (session) {
      sessions.delete(session.key);
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.sessionKey === session.key) socket.disconnect(true);
      }
    }
    res.setHeader('Set-Cookie', sessionCookieOptions(req));
    return res.json({ ok: true });
  });

  app.get('/api/info', (req, res) => {
    if (!getSession(req)) return res.status(401).json({ error: 'Join the room first.' });
    return res.json({ port: server.address()?.port ?? port, addresses: lanAddresses() });
  });

  io.use((socket, next) => {
    pruneSessions();
    const token = readCookie(socket.handshake.headers.cookie);
    const key = token ? digest(token) : '';
    const session = sessions.get(key);
    if (!session || session.expiresAt < Date.now()) return next(new Error('Session expired. Join again with the room password.'));
    socket.data.sessionKey = key;
    socket.data.deviceName = session.deviceName;
    socket.data.deviceId = session.deviceId;
    socket.data.connectedAt = Date.now();
    next();
  });

  function currentDevices() {
    return [...io.sockets.sockets.values()].map((socket) => ({
      id: socket.id,
      deviceId: socket.data.deviceId,
      name: socket.data.deviceName,
      connectedAt: socket.data.connectedAt
    })).sort((a, b) => a.connectedAt - b.connectedAt);
  }

  io.on('connection', (socket) => {
    socket.emit('history', messages);
    io.emit('presence', currentDevices());

    socket.on('message:send', (payload, acknowledge = () => {}) => {
      const session = sessions.get(socket.data.sessionKey);
      if (!session || session.expiresAt < Date.now()) {
        acknowledge({ error: 'Your room session expired. Join again.' });
        socket.disconnect(true);
        return;
      }
      if (typeof payload?.body !== 'string') return acknowledge({ error: 'Enter a message first.' });
      const body = payload.body.replace(/\r\n/g, '\n');
      if (!body.trim()) return acknowledge({ error: 'Enter a message first.' });
      if (body.length > MAX_MESSAGE_LENGTH) return acknowledge({ error: `Messages are limited to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.` });
      const kind = payload.kind === 'note' ? 'note' : 'command';
      const message = {
        id: crypto.randomUUID(),
        body,
        kind,
        sender: socket.data.deviceName,
        senderId: socket.data.deviceId,
        timestamp: new Date().toISOString()
      };
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.shift();
      socket.broadcast.emit('message:new', message);
      acknowledge({ message });
    });

    socket.on('disconnect', () => io.emit('presence', currentDevices()));
  });

  return { app, io, server, sessions, messages, close: () => new Promise((resolve) => io.close(resolve)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const relay = createRelay({
    password: process.env.ROOM_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET,
    port,
    trustProxy: process.env.TRUST_PROXY === '1'
  });
  relay.server.once('listening', () => {
    const actualPort = relay.server.address().port;
    process.stdout.write(`Relay is ready at http://localhost:${actualPort}\n`);
    const addresses = lanAddresses();
    if (addresses.length) process.stdout.write(`On this network: ${addresses.map((address) => `http://${address}:${actualPort}`).join('  |  ')}\n`);
    process.stdout.write('Open the same address on the other computer and join with the room password.\n');
  });
  relay.server.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
  relay.server.listen(port, '0.0.0.0');
}
