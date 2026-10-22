import 'dotenv/config';

if (!process.env.ROOM_PASSWORD) {
  process.stderr.write('No ROOM_PASSWORD found. Run `npm run dev` once to create a local .env file.\n');
  process.exit(1);
}

process.stdout.write(`${process.env.ROOM_PASSWORD}\n`);
