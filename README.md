# Relay

Relay is a small, password-protected live chat for moving terminal commands and short notes between computers. It runs as one Node server. Every connected browser sees new messages immediately, and each message has its own copy button. Relay only transfers text; it never runs commands.

## Start it

Requirements: Node.js 20 or newer.

```sh
npm install
npm run dev
```

On the first start, Relay creates a private `.env` file and prints a randomly generated room password once. Keep it and share it only with the other computer. To print it again on the host, run `npm run show-password`.

Open `http://localhost:3000` on the host computer. For a second computer on the same network, use the `On this network` address printed by the server (or copy the room link inside Relay), then enter the room password. If port 3000 is busy, set `PORT` in `.env` before starting Relay again.

Use `npm start` to run without the file watcher. The browser session lasts 12 hours; leaving the room ends that session.

## Security and storage

- The shared password and session secret stay in the ignored `.env` file. Do not commit it or share it in the chat.
- Login attempts are rate limited. Browser sessions use an HTTP-only, same-site cookie.
- Messages are held in server memory, up to the latest 160, and disappear when the server restarts. Relay does not write message content to disk.
- Local network addresses are served over HTTP by default. Use Relay on a trusted network. Before exposing it over the internet, put it behind an HTTPS reverse proxy, set `TRUST_PROXY=1` only when that proxy is trusted, and choose a new strong `ROOM_PASSWORD` and `SESSION_SECRET` in `.env`.
- Anyone who has both the room link and password can read and send messages in this room. Use **Leave room** on shared computers.

## Checks

```sh
npm test
```

## Deploy on Render

The `render.yaml` Blueprint runs Relay as one Node web service, so the room UI, password session, and live Socket.IO connection share the same HTTPS origin. The Blueprint generates `ROOM_PASSWORD` and `SESSION_SECRET`; it does not put them in this repository.

To deploy, push this repository to GitHub, create a new Blueprint in Render, and connect the repository. After the first deploy, copy `ROOM_PASSWORD` from the service's Environment settings and share it separately from the service URL.

Render's free web service sleeps after 15 minutes without incoming traffic and can take about a minute to wake. Service restarts clear Relay's in-memory messages and sessions, as described above. Use a paid always-on service if cold starts are not acceptable.
