import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server.js';
import { io as createClient } from 'socket.io-client';

const password = 'test-room-password-42';
const sessionSecret = 'test-session-secret-which-is-long-enough';

async function startRelay(t) {
  const relay = createRelay({ password, sessionSecret, port: 0 });
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  return { relay, origin: `http://127.0.0.1:${relay.server.address().port}` };
}

async function join(origin, deviceName) {
  const response = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, deviceName })
  });
  const cookie = response.headers.getSetCookie()[0].split(';', 1)[0];
  return { response, cookie, result: await response.json() };
}

function connect(origin, cookie) {
  return new Promise((resolve, reject) => {
    const socket = createClient(origin, { extraHeaders: { cookie }, reconnection: false, timeout: 2500 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

test('password creates an HTTP-only room session and protects room info', async (t) => {
  const { origin } = await startRelay(t);
  const denied = await fetch(`${origin}/api/info`);
  assert.equal(denied.status, 401);

  const invalid = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong', deviceName: 'Laptop' })
  });
  assert.equal(invalid.status, 401);

  const { response, cookie, result } = await join(origin, 'Laptop');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(result.deviceName, 'Laptop');

  const info = await fetch(`${origin}/api/info`, { headers: { cookie } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).port, Number(new URL(origin).port));
});

test('malformed session cookies are treated as unauthenticated', async (t) => {
  const { origin } = await startRelay(t);
  const response = await fetch(`${origin}/api/session`, { headers: { cookie: 'relay_session=%' } });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Join with the room password/);
});

test('authenticated computers relay messages live without duplicating the sender', async (t) => {
  const { origin } = await startRelay(t);
  const first = await join(origin, 'Studio Mac');
  const second = await join(origin, 'Windows PC');
  const sender = await connect(origin, first.cookie);
  const receiver = await connect(origin, second.cookie);
  t.after(() => { sender.close(); receiver.close(); });

  const arrived = new Promise((resolve) => receiver.once('message:new', resolve));
  const accepted = new Promise((resolve) => {
    sender.timeout(2500).emit('message:send', { kind: 'command', body: 'git status --short' }, (error, response) => {
      assert.ifError(error);
      resolve(response);
    });
  });
  const [receiverMessage, senderAck] = await Promise.all([arrived, accepted]);
  assert.equal(senderAck.message.id, receiverMessage.id);
  assert.equal(receiverMessage.body, 'git status --short');
  assert.equal(receiverMessage.sender, 'Studio Mac');
  assert.equal(receiverMessage.kind, 'command');
  assert.notEqual(receiverMessage.senderId, second.result.deviceId);
  assert.equal((await fetch(`${origin}/api/session`, { headers: { cookie: first.cookie } })).status, 200);
});

test('message validation rejects blank and oversized content', async (t) => {
  const { origin } = await startRelay(t);
  const { cookie } = await join(origin, 'Laptop');
  const socket = await connect(origin, cookie);
  t.after(() => socket.close());

  const send = (body) => new Promise((resolve, reject) => {
    socket.timeout(2500).emit('message:send', { body }, (error, response) => error ? reject(error) : resolve(response));
  });
  assert.match((await send('   ')).error, /Enter a message/);
  assert.match((await send('x'.repeat(6001))).error, /limited to/);
});

test('messages preserve intentional whitespace and normalize line endings', async (t) => {
  const { origin } = await startRelay(t);
  const { cookie } = await join(origin, 'Laptop');
  const socket = await connect(origin, cookie);
  t.after(() => socket.close());

  const result = await new Promise((resolve, reject) => {
    socket.timeout(2500).emit('message:send', { body: '  echo ready\r\n    nested  ' }, (error, response) => error ? reject(error) : resolve(response));
  });
  assert.equal(result.message.body, '  echo ready\n    nested  ');
});

test('successful joins do not consume the failed-password limit', async (t) => {
  const { origin } = await startRelay(t);
  for (let index = 0; index < 9; index += 1) {
    const { response } = await join(origin, `Computer ${index}`);
    assert.equal(response.status, 200);
  }
});
