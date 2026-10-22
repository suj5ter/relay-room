const $ = (selector) => document.querySelector(selector);
const state = { deviceName: '', deviceId: '', socket: null, kind: 'command', devices: [], messages: new Map(), inviteUrl: '', toastTimer: null };
const loginView = $('#loginView');
const relayView = $('#relayView');
const loginForm = $('#loginForm');
const loginError = $('#loginError');
const loginButton = $('#joinButton');
const passwordInput = $('#roomPassword');
const deviceNameInput = $('#deviceName');
const feed = $('#messageFeed');
const composer = $('#composerForm');
const input = $('#messageInput');
const sendButton = $('#sendButton');
const emptyState = $('#emptyState');
const jumpButton = $('#jumpToLatest');

function setLoginError(message = '') {
  loginError.textContent = message;
  loginError.hidden = !message;
}

function showLogin(message = '') {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  state.deviceName = '';
  state.deviceId = '';
  relayView.hidden = true;
  loginView.hidden = false;
  setLoginError(message);
  passwordInput.value = '';
  passwordInput.focus();
}

function showRelay(session) {
  state.deviceName = session.deviceName || 'My computer';
  state.deviceId = session.deviceId || '';
  loginView.hidden = true;
  relayView.hidden = false;
  renderDevices(state.devices);
  loadRoomInfo();
  connectSocket();
  refreshComposer();
}

async function checkSession() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) return showLogin();
    showRelay(await response.json());
  } catch {
    showLogin('The room server could not be reached. Refresh when it is available.');
  }
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const socket = window.io({ autoConnect: true, reconnection: true, reconnectionDelayMax: 4000, timeout: 7000 });
  state.socket = socket;
  setConnection('connecting', 'Connecting');
  socket.on('connect', () => {
    setConnection('connected', 'Live');
    refreshComposer();
    $('#messageInput').focus({ preventScroll: true });
  });
  socket.on('disconnect', (reason) => {
    if (state.socket !== socket) return;
    setConnection('reconnecting', reason === 'io client disconnect' ? 'Offline' : 'Reconnecting');
    refreshComposer();
  });
  socket.on('connect_error', async (error) => {
    if (state.socket !== socket) return;
    setConnection('reconnecting', 'Reconnecting');
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin' });
      if (response.status === 401) showLogin('Your room session expired. Join again with the room password.');
    } catch { /* keep retrying if the network is temporarily unavailable */ }
    if (error.message?.includes('Session expired')) showLogin('Your room session expired. Join again with the room password.');
  });
  socket.on('history', (messages) => {
    state.messages.clear();
    feed.querySelectorAll('.message-row,.day-divider').forEach((node) => node.remove());
    for (const message of messages) appendMessage(message, false);
    updateEmptyState();
    scrollToBottom();
  });
  socket.on('message:new', (message) => appendMessage(message, true));
  socket.on('presence', (devices) => {
    state.devices = devices;
    renderDevices(devices);
  });
}

function setConnection(status, label) {
  const badge = $('#connectionBadge');
  badge.className = `connection-badge is-${status}`;
  $('#connectionLabel').textContent = label;
  refreshComposer();
}

function renderDevices(devices = []) {
  const list = $('#deviceList');
  list.replaceChildren();
  const ordered = [...devices].sort((a, b) => (a.deviceId === state.deviceId ? -1 : b.deviceId === state.deviceId ? 1 : a.connectedAt - b.connectedAt));
  for (const device of ordered) {
    const entry = document.createElement('div');
    entry.className = `device-entry${device.deviceId === state.deviceId ? ' is-current' : ''}`;
    const avatar = document.createElement('span');
    avatar.className = 'device-avatar';
    avatar.textContent = initials(device.name);
    const meta = document.createElement('div');
    meta.className = 'device-meta';
    const name = document.createElement('div');
    name.className = 'device-name';
    name.textContent = device.name;
    const status = document.createElement('div');
    status.className = 'device-state';
    status.textContent = device.deviceId === state.deviceId ? 'This computer' : 'Connected now';
    meta.append(name, status);
    entry.append(avatar, meta);
    if (device.deviceId === state.deviceId) {
      const you = document.createElement('span');
      you.className = 'you-label';
      you.textContent = 'YOU';
      entry.append(you);
    }
    list.append(entry);
  }
  $('#onlineCount').textContent = String(devices.length || 1);
}

async function loadRoomInfo() {
  try {
    const response = await fetch('/api/info', { credentials: 'same-origin' });
    if (!response.ok) return;
    const info = await response.json();
    const current = new URL(window.location.href);
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(current.hostname);
    if (isLocalHost && info.addresses?.length) {
      current.hostname = info.addresses[0];
    }
    if (isLocalHost && info.port) current.port = String(info.port);
    current.pathname = '/';
    current.search = '';
    current.hash = '';
    state.inviteUrl = current.href;
    $('#shareAddress').textContent = state.inviteUrl.replace(/^https?:\/\//, '');
  } catch { /* invite URL remains available from the address bar */ }
}

function initials(value = '') {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words.at(-1)[0] : value.slice(0, 2)).toUpperCase() || 'PC';
}

function formatTime(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function appendMessage(message, incoming) {
  if (!message?.id || state.messages.has(message.id)) return;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  state.messages.set(message.id, message);
  emptyState.hidden = true;
  const row = document.createElement('article');
  row.className = `message-row${message.senderId === state.deviceId ? ' is-own' : ''}`;
  row.dataset.messageId = message.id;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const sender = document.createElement('span');
  sender.className = 'message-sender';
  sender.textContent = message.sender || 'Computer';
  const time = document.createElement('time');
  time.className = 'message-time';
  time.dateTime = message.timestamp;
  time.textContent = formatTime(message.timestamp);
  time.title = new Date(message.timestamp).toLocaleString();
  const kind = document.createElement('span');
  kind.className = `message-kind${message.kind === 'note' ? ' note-kind' : ''}`;
  kind.textContent = message.kind === 'note' ? 'NOTE' : 'COMMAND';
  meta.append(sender, time, kind);

  const card = document.createElement('div');
  card.className = `message-card${message.kind === 'note' ? ' note-card' : ''}`;
  card.textContent = message.body;
  const copy = document.createElement('button');
  copy.className = 'copy-message';
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Copy message');
  copy.title = 'Copy message';
  copy.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10.5 5V3.5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1V11a1 1 0 0 0 1 1h1"/></svg>';
  copy.addEventListener('click', async () => {
    const success = await copyText(message.body);
    showToast(success ? 'Message copied to clipboard' : 'Could not access clipboard');
  });
  card.append(copy);
  row.append(meta, card);
  feed.append(row);
  updateEmptyState();
  if (nearBottom || !incoming) {
    scrollToBottom();
    jumpButton.hidden = true;
  } else if (incoming) {
    jumpButton.hidden = false;
  }
}

function updateEmptyState() {
  emptyState.hidden = state.messages.size > 0;
}

function scrollToBottom() {
  requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

function refreshComposer() {
  const connected = state.socket?.connected ?? false;
  sendButton.disabled = !connected || !input.value.trim();
  input.disabled = false;
  if (!connected) input.placeholder = 'Waiting for the room connection…';
  else input.placeholder = state.kind === 'command' ? 'Type a command to send…' : 'Write a quick note…';
}

function setMode(kind) {
  state.kind = kind;
  const command = kind === 'command';
  $('#commandMode').classList.toggle('active', command);
  $('#commandMode').setAttribute('aria-selected', String(command));
  $('#noteMode').classList.toggle('active', !command);
  $('#noteMode').setAttribute('aria-selected', String(!command));
  refreshComposer();
  input.focus();
}

async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.className = 'clipboard-helper';
    document.body.append(helper);
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    const success = document.execCommand('copy');
    helper.remove();
    return success;
  } catch {
    return false;
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setLoginError();
  loginButton.disabled = true;
  loginButton.firstElementChild.textContent = 'Joining…';
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value, deviceName: deviceNameInput.value })
    });
    const result = await response.json();
    if (!response.ok) {
      setLoginError(result.error || 'Could not join this room.');
      return;
    }
    passwordInput.value = '';
    showRelay(result);
  } catch {
    setLoginError('Could not reach the room server. Check the address and try again.');
  } finally {
    loginButton.disabled = false;
    loginButton.firstElementChild.textContent = 'Join room';
  }
});

$('#togglePassword').addEventListener('click', (event) => {
  const reveal = passwordInput.type === 'password';
  passwordInput.type = reveal ? 'text' : 'password';
  event.currentTarget.textContent = reveal ? 'HIDE' : 'SHOW';
  event.currentTarget.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
});

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const body = input.value;
  if (!body.trim() || !state.socket?.connected) return;
  sendButton.disabled = true;
  state.socket.timeout(5000).emit('message:send', { body, kind: state.kind }, (error, result) => {
    if (error) {
      showToast('Message did not send. Check the connection and retry.');
      refreshComposer();
      return;
    }
    if (result?.error) {
      showToast(result.error);
      refreshComposer();
      return;
    }
    appendMessage(result.message, false);
    input.value = '';
    updateCount();
    refreshComposer();
    input.focus({ preventScroll: true });
  });
});

function updateCount() {
  $('#charCount').textContent = `${input.value.length.toLocaleString()} / 6,000`;
  refreshComposer();
}

input.addEventListener('input', updateCount);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

$('#commandMode').addEventListener('click', () => setMode('command'));
$('#noteMode').addEventListener('click', () => setMode('note'));
$('#shareButton').addEventListener('click', shareInvite);
$('#shareButtonSide').addEventListener('click', shareInvite);
async function shareInvite() {
  const url = state.inviteUrl || window.location.href;
  if (await copyText(url)) showToast('Room link copied');
  else showToast('Could not access clipboard');
}

$('#logoutButton').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* local state still clears */ }
  showLogin();
});

jumpButton.addEventListener('click', () => {
  scrollToBottom();
  jumpButton.hidden = true;
});
feed.addEventListener('scroll', () => {
  if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40) jumpButton.hidden = true;
});

checkSession();
