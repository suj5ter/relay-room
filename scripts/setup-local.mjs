import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (process.env.ROOM_PASSWORD && process.env.SESSION_SECRET) {
  process.stdout.write('Using room credentials from the host environment.\n');
  process.exit(0);
}

if (existsSync('.env')) {
  process.stdout.write('Using existing .env. Run `npm run show-password` to view the room password.\n');
  process.exit(0);
}

const password = randomBytes(18).toString('base64url');
const sessionSecret = randomBytes(48).toString('base64url');
const contents = [
  `ROOM_PASSWORD=${password}`,
  `SESSION_SECRET=${sessionSecret}`,
  'PORT=3000',
  'TRUST_PROXY=0',
  ''
].join('\n');

writeFileSync('.env', contents, { mode: 0o600, flag: 'wx' });
process.stdout.write(`Created private .env. Room password: ${password}\nSave this password and share it only with the computer joining your room.\n`);
