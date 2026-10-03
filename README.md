# GhostSignal

A browser-based hackathon prototype for temporary, moving safety sessions. A student starts a walk, shares a private guardian link, keeps moving, and can silently mark **I need help**. The guardian dashboard shows the latest location, movement trail, accuracy, and update freshness.

> Emergency buttons protect a location. Our system protects the person as they move.

## Run locally

Requires **Node.js 24 or newer** and npm. SQLite is provided by Node; no database account or API key is required.

```sh
npm install
npm run dev
```

Open [the student page](http://localhost:5173). Choose **Try a simulated walk**, copy the guardian link, and open it in a second browser window. Both views communicate with the same backend, so help status and position changes are shared across clients.

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`; Vite proxies `/api` requests during development.
- Stop both development processes with Ctrl+C.

The demo route is simulated and labeled in both views. It does not request device location. To test actual GPS, choose **Start a live walk** and grant location permission when prompted.

### Running on a phone

A phone must reach the same frontend and backend through a **trusted HTTPS origin** for live geolocation. `http://localhost` is suitable on the computer running this project, but a phone's `localhost` points to the phone itself. Visiting the computer's plain HTTP LAN address is not enough for browser location access. The simulated route can be used for initial UI testing without GPS.

Keep the student page open and the screen unlocked. Browsers may suspend or throttle location work in background tabs or when the screen locks. Reliable background tracking is outside this web MVP.

Hosting is intentionally undecided; this version runs locally. Choose a host with persistent storage and HTTPS before demonstrating real GPS across devices.

## Check and build

```sh
npm test
npm run build
npm start
```

`npm test` runs backend lifecycle and access-control checks. `npm run build` typechecks the project and creates the frontend in `dist/`. After a build, `npm start` serves both the built frontend and API at [http://localhost:3001](http://localhost:3001).

The server reads these optional environment variables from the process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API and built frontend port |
| `SESSION_DB_PATH` | `data/sessions.sqlite` | Persistent SQLite file path |

The Vite development proxy targets port 3001. Change the proxy too if you change the API port during development. Environment files are not automatically loaded by the backend.

## What is implemented

- Mobile-friendly student flow with explicit location consent, simulated demo, guardian link sharing, help request, help retraction while the walk continues, and session end.
- Student and guardian maps with zoom controls, a moving marker, accuracy radius, capped movement trail, and delayed/stale location indicators. Location updates preserve the chosen zoom level.
- A shared backend and SQLite persistence; browser storage is only used to resume the student's credentials within that tab.
- Separate random owner and guardian credentials. The guardian credential allows viewing only and travels in the URL fragment; API requests use an Authorization header.
- A fixed two-hour session lifetime. Ended and expired sessions remove coordinates and trails from session state and reject further location writes.
- Location validation, monotonic timestamps, bounded update frequency, no-store API responses, and a session-creation rate limit.

## Limits that matter

This is a hackathon prototype. The help button changes the open guardian dashboard; it does **not** send SMS or push notifications, contact emergency services, or confirm a guardian is watching. There is no police, Illini-Alert, or threat-detection integration.

Anyone who receives a guardian link can view that session until sharing ends. Share links privately. There is no user account, individual guardian verification, or link rotation yet. Active coordinates are stored locally in SQLite without application-level encryption. End/expiry clears application-visible location state; it is not a guarantee of forensic erasure from disk or backups. OpenStreetMap supplies map tiles and attribution; map rendering needs connectivity to its tile service. Tile requests reveal the viewed map area and the site's origin to that provider, but do not send guardian tokens. The tile integration follows [OpenStreetMap's usage policy](https://operations.osmfoundation.org/policies/tiles/).

The system reports received data, not independently verified movement. GPS accuracy varies. Network loss, permission changes, and suspended pages can delay updates. Use one student tab per session: duplicated owner tabs may compete to publish location updates. Destination and ETA remain optional follow-up work.

## Project layout

```text
src/                  Student and guardian React views, map, shared API types
server/               Express routes, SQLite session store, backend tests
public/               App favicon
docs/HACKATHON.md     Demo script, acceptance checks, and four-person ownership
data/                 Runtime database (ignored by Git)
```

Read [the hackathon guide](docs/HACKATHON.md) for the demo sequence, acceptance checklist, and remaining deployment decisions.

## Contribution rule

The repository owner requires approval before commits. Review the concrete local changes and ask before committing or pushing to GitHub.
