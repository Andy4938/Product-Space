# GhostSignal

A mobile-first hackathon prototype for requesting help **without speaking or making a call**. The student holds **Emergency help** for three seconds and sees a clear delivery and response status. Their live location is shared with the prototype Campus Safety console and an optional trusted guardian. The student stays on one screen; maps are for the guardian and dispatcher. Preset messages and an optional clothing description help explain the situation without a conversation. Short vibrations accompany dispatcher acknowledgement and response updates.

> Emergency buttons protect a location. Our system protects the person as they move.

## Run locally

Requires **Node.js 24 or newer** and npm. SQLite is provided by Node; no database account or API key is required.

```sh
npm install
npm run dev
```

Open three windows:

1. [The student page](http://localhost:5173): choose **Try a simulated walk**.
2. The guardian link: copy it from the student page, then choose **Turn on notifications**.
3. [The Campus Safety console](http://localhost:5173/dispatch): enter the access code that the server prints when it starts (`Campus Safety console: /dispatch  access code: …`).

All three use the same backend.

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`; Vite proxies `/api` requests during development.
- Stop both development processes with Ctrl+C.

The demo route is simulated and labeled in both views. It does not request device location. To test actual GPS, choose **Start a live walk** and grant location permission when prompted.

### Emergency homepage

The circular **Emergency help** button is connected to the existing incident system. Hold it for **3 seconds** to create a live session (or reuse the current walk) and send a request to the prototype Campus Safety console. Location tracking starts with the session; permission denial or a slow GPS fix does not prevent the incident from being created. The page explicitly reports when no location is available. This does **not** call 911 or contact UIUC Police.

After the server confirms receipt, the button turns yellow for a **3-second cancellation window**. Hold **Cancel** for 3 seconds to retract the request. The window pauses during the cancellation hold and resumes its remaining time if you release early. Success is shown only after the server confirms the cancellation; failed or uncertain requests can be retried. Retrying reuses the same session and incident. Cancellation updates the guardian and dispatcher but does not erase the incident or stop location sharing.

Choose **Share guardian link** to open a dialog containing copy/share actions and a QR code. It never opens the student's own map or a second walk page. Location collection continues while the student keeps the page active. **Help responders find you** holds optional details, and **Stop sharing** asks for confirmation. A student can start sharing before requesting help, or request help directly from the homepage. For a GPS-free demonstration, start a simulated walk, then use the same emergency control; the incident remains clearly labelled as a demo.

### Running on a phone

A phone must reach the same frontend and backend through a **trusted HTTPS origin** for live geolocation. `http://localhost` is suitable on the computer running this project, but a phone's `localhost` points to the phone itself. Visiting the computer's plain HTTP LAN address is not enough for browser location access. The simulated route can be used for initial UI testing without GPS.

Keep the student page open and the screen unlocked. Browsers may suspend or throttle location work in background tabs or when the screen locks. Reliable background tracking is outside this web MVP.

For a two-phone test, the app can keep running locally on your **Windows PC or Mac** while a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) gives both phones a public HTTPS address. The phones can use different Wi-Fi networks or cellular data; they both connect through the tunnel to this one computer.

Install `cloudflared` once on the computer that will run the app:

- **Windows PowerShell:** `winget install --id Cloudflare.cloudflared --exact` ([WinGet package](https://github.com/microsoft/winget-pkgs/tree/master/manifests/c/Cloudflare/cloudflared)). Open a new terminal after installation. If WinGet is unavailable, use the installer from [Cloudflare's Windows downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/#windows).
- **Mac Terminal:** `brew install cloudflared` ([Cloudflare installation instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/#macos)).

From the project folder, run each command separately (requires Node.js 24 or newer):

```sh
npm install
npm run build
npm start
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` in place of `npm`; changing the execution policy is unnecessary. Save the Campus Safety access code printed by the server if you want to test the dispatcher.

Then:

1. Leave the app terminal open. It serves the built frontend and API together on port 3001.
2. In a second terminal, run `cloudflared tunnel --url http://localhost:3001`. Keep both terminals running.
3. On the student's phone, open the printed `https://…trycloudflare.com` address and start a walk.
4. Choose **Share guardian link**, then **Copy link** or share from your phone. You can also let your guardian scan the QR code with their phone. From the emergency status screen, the share action opens these same options.
5. On the guardian's phone, open that **full private link**, including everything after `#`. It opens the guardian view directly. They do not need an account, to start another walk, or to run another copy of the app.

Sharing the homepage address starts a separate student flow. Links created from `localhost` cannot open the computer's app on another phone; the sharing dialog explains this and hides its QR code. Open the student page through the Cloudflare address before starting and sharing a walk.

Both phones must use the same tunnel and running server. A Quick Tunnel gets a new address when restarted, so open the new address and share a fresh guardian link. After code changes, rebuild, restart the server, and reload both phones. QR codes are generated in the browser; the private guardian link is never sent to a QR-code service.

### Guardian versus dispatcher on the second phone

| Receiving role | What Phone 2 opens | What it can do |
| --- | --- | --- |
| Trusted guardian | The private `/watch/…#…` link from Phone 1 | Follow that walk, see help and response updates, and send information to the dispatcher |
| Test dispatcher | The same Cloudflare HTTPS address with `/dispatch` appended | Enter the server's access code, see incoming incidents and their locations, acknowledge, dispatch a unit, and close an incident |

For your friend's two-phone emergency test, use the dispatcher option. On Phone 1, allow location access and hold **Emergency help** for three seconds, then let the cancellation window expire. On Phone 2, open the incident, choose **Acknowledge**, then **Dispatch unit**. Phone 1 should update its status automatically. Keep Phone 1 open and unlocked, both terminals running, and the hosting computer awake. Send the access code only to the teammate playing the dispatcher. These actions stay within the prototype; they do not summon real emergency services.

The guardian checks for updates every second. New device positions are uploaded with a minimum 1.1-second gap after the previous upload completes; a slow connection keeps only the newest waiting position. If the browser's location watch stops providing fresh positions for ten seconds, the visible student page requests a fresh fix. The browser still controls how quickly and accurately a position is available; these intervals are not a GPS delivery guarantee.

To diagnose delays, compare **Updated** with **View refreshed** on the guardian. A recent view refresh with an old location means no fresh position has arrived; check the student's location or connection warning. An old view refresh indicates the guardian's connection is behind. Capture timestamps always remain the device's original timestamps.

Hosting is intentionally undecided; this version runs locally. Choose a host with persistent storage and HTTPS before demonstrating real GPS across devices.

## Check and build

```sh
npm test
npm run build
npm start
```

`npm test` runs backend lifecycle, access-control, location recovery, and upload timing checks. `npm run build` typechecks the project and creates the frontend in `dist/`. After a build, `npm start` serves both the built frontend and API at [http://localhost:3001](http://localhost:3001).

The server reads these optional environment variables from the process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API and built frontend port |
| `SESSION_DB_PATH` | `data/sessions.sqlite` | Persistent SQLite file path |
| `DISPATCH_ACCESS_CODE` | random per start | Shared code for the Campus Safety console; printed at startup when unset |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated | Web Push keys. When unset, a pair is generated once and saved as `vapid-keys.json` beside the database |
| `VAPID_SUBJECT` | `mailto:ghostsignal@example.invalid` | Contact URL sent to push services; set a real `mailto:` before hosting |
| `TWILIO_ACCOUNT_SID` | unset | Twilio account for guardian text alerts |
| `TWILIO_AUTH_TOKEN` | unset | Twilio auth token; keep it out of Git |
| `TWILIO_FROM_NUMBER` | unset | Twilio sending number, such as `+12175550100` |

Text alerts are sent through Twilio only when all three `TWILIO_*` variables are set. Otherwise the server prints each alert to its console as `[simulated SMS to •••0123]`, which is suitable for a labeled demo.

The Vite development proxy targets port 3001. Change the proxy too if you change the API port during development. Environment files are not automatically loaded by the backend.

## What is implemented

- **Emergency confirmation:** after the server accepts a homepage emergency signal and the three-second undo window finishes, the large send button becomes a persistent status card. It shows delivery, dispatcher acknowledgement, recorded dispatch, and closure with its outcome. Restoring the tab checks the server before showing the saved request.
- **Separate location and cancellation state:** the emergency card reports missing or delayed positions separately from successful signal delivery and offers a location retry. Cancellation stays pending while the incident is open. Stopping live location requires confirmation and leaves the request status visible; it does not close the incident. Private dispatcher notes are not shown to students.
- Mobile-friendly student flow with explicit location consent, simulated demo, guardian link sharing, help request, help retraction while the walk continues, and session end.
- Guardian and dispatcher maps with zoom controls, a moving marker, accuracy radius, capped movement trail, and delayed/stale location indicators. Location updates preserve the chosen zoom level. The student sees a compact sharing status instead of a map.
- A shared backend and SQLite persistence; browser storage is only used to resume the student's credentials within that tab.
- Separate random owner and guardian credentials. The guardian credential allows viewing, sending guardian notes, and registering alerts for that session, and travels in the URL fragment; API requests use an Authorization header.
- A fixed two-hour session lifetime. Ended and expired sessions remove coordinates and trails from session state and reject further location writes.
- **One student screen:** a deliberate three-second emergency hold opens an incident with a reference such as `GS-4F2A9C`. After the cancellation window, the same screen reports delivery, acknowledgement, and response. Guardian sharing opens only a private-link dialog. The three-second cancellation behavior, presets, location retries, and status vibrations remain available without an alternate walk view.
- **Campus Safety console (`/dispatch`):** a dispatcher console protected by a shared access code. It shows:
  - A queue of open signals, ordered so unacknowledged signals come first, each with a running timer, a nearby campus landmark, location freshness, and flags such as walker cancelled, walk ended, or demo.
  - A live map with every open signal. New signals pulse; the selected signal shows its trail and accuracy radius.
  - An incident panel with the live location, an approximate description relative to a campus landmark, copyable coordinates, accuracy, movement over the last minute, the walker's optional description of what they're wearing, notes from the guardian, and whether the guardian was notified. A banner reminds the dispatcher not to call or text the walker.
  - A workflow: **Acknowledge** → **Dispatch unit** → **Close with outcome** (each outcome is something a responder can confirm in person: escorted to safety, no threat on scene, accidental and confirmed in person, walker reached safety, unable to locate, escalated to police), plus notes and a full timeline.
  - A repeating alarm sound, a tab-title count, and a browser notification until each new signal is acknowledged.
- **Phone dispatcher navigation:** switch between **Signals**, **Details**, and **Map**. Selecting a signal opens its response details without scrolling past a large map. Alert sound can be muted, browser notifications are explicitly enabled, and connection errors provide a retry action. Desktop shows the three panels together.
- **Guardian priorities:** the map and location freshness appear before optional notification setup. Notification copy reflects whether alerts are enabled. Connection retry remains available after sharing ends, and incident status remains visible through closure even when the location has been removed.
- **Never contact the walker:** the guardian page, push notifications, and texts all tell the guardian not to call or text the walker. The guardian sees the full Campus Safety tracker and can **Share what you know** (destination, clothing, companions); this goes to the dispatcher, not the walker. If a cancellation or an ended walk may have been coerced, dispatchers are told to verify in person.
- **Location after a walk ends:** if a walk ends or expires while an incident is open, Campus Safety keeps the last known location and description. Closing the incident removes Campus Safety's access to both.
- **Guardian push notifications:** **Turn on notifications** on the guardian page registers a service worker for Web Push. The guardian is notified when help is requested or cancelled and when Campus Safety acknowledges, dispatches, or closes, even with the page closed. Tapping a notification reopens the guardian link.
- **Guardian text alerts:** optional texts for the same events through Twilio. Without Twilio keys, these become labeled console messages. Each session can send at most ten texts.
- **Help responders find you:** a folded section where the student can describe what they're wearing and add a guardian phone number for texts. The app never asks for the student's phone number, because calling them could be dangerous. Everything is deleted when the walk ends.
- **Mobile app layout:** the student has one help and sharing screen, with optional details folded away. The guardian has a map and response updates. Copy/share controls and a local QR work without an account; layouts wrap across all four interface languages. Dispatch adapts its three desktop panels into separate phone views.
- **Text-only guardian view:** an accessible view without map tiles for screen-reader, low-vision, and low-bandwidth use.
- Location validation, monotonic timestamps, bounded update frequency, no-store API responses, and a session-creation rate limit.

## Languages and nonverbal messages

Open **Settings** on the walker or guardian page to choose English, Spanish, Simplified Chinese, or Hindi. The choice is saved on that device. Switching languages preserves the current walk, location tracking, and selected preset message.

Before sending a help signal, optionally select one of four messages: “I think someone is following me,” “I cannot speak right now,” “I need medical help,” or “Please send someone to meet me.” Selecting alone does not send anything. The selected message is attached to the confirmed help request. During an active request, select a message and tap **Send message** to add an update. Confirmed messages appear on the walker, guardian, and dispatcher screens. Each dispatcher queue item shows a red message icon and unread count for new student messages or guardian notes. Opening that incident clears its badge on that dispatcher tab; a later message brings the badge back. Background polling does not mark messages read.

Messages use stable IDs so guardians see the same meaning in their chosen language. The dispatcher console, push/SMS notifications, and freeform notes remain in their original language. This feature does not automatically translate conversations. The latest 20 messages are displayed per incident; duplicate retries are deduplicated, and new messages are limited to one every two seconds. Messages cannot be sent after cancellation, closure, or the end of a walk.

The Settings dialog supports keyboard navigation and Escape. Phone layouts adapt the header, emergency control, maps, and message grid to the available width; long translations wrap and longer pages scroll vertically.

## Limits that matter

This is a hackathon prototype. **The Campus Safety console is not connected to UIUC Police, METCOM, or 911, and nobody monitors it.** The pages say this. A real deployment would need agreement with campus police on staffing, response policy, dispatcher accounts, and audit logging.

The console uses one shared access code instead of individual dispatcher accounts, and it does not record which dispatcher took each action. Phone numbers are stored in SQLite without encryption until the walk ends or the incident closes. Landmark descriptions use a short list of approximate campus coordinates. Web Push needs HTTPS (or localhost). On iPhone, push works only after the guardian adds the site to the Home Screen (iOS 16.4 or later). Stale-location warnings are shown in open pages but not pushed.

Anyone who receives a guardian link can view that session until sharing ends. Share links privately. There is no user account, individual guardian verification, or link rotation yet. Active coordinates are stored locally in SQLite without application-level encryption. End/expiry clears application-visible location state; it is not a guarantee of forensic erasure from disk or backups. OpenStreetMap supplies map tiles and attribution; map rendering needs connectivity to its tile service. Tile requests reveal the viewed map area and the site's origin to that provider, but do not send guardian tokens. The tile integration follows [OpenStreetMap's usage policy](https://operations.osmfoundation.org/policies/tiles/).

The system reports received data, not independently verified movement. GPS accuracy varies. Network loss, permission changes, and suspended pages can delay updates. Use one student tab per session: duplicated owner tabs may compete to publish location updates.

## Project layout

```text
src/App.tsx           Student and guardian views
src/Dispatch.tsx      Campus Safety console
src/landmarks.ts      Approximate campus landmarks for location descriptions
server/               Express routes, SQLite store (sessions, incidents, push subscriptions), notifier, tests
public/               Favicon, service worker for guardian push, web app manifest
docs/HACKATHON.md     Demo script, acceptance checks, and four-person ownership
data/                 Runtime database (ignored by Git)
```

Read [the hackathon guide](docs/HACKATHON.md) for the demo sequence, acceptance checklist, and remaining deployment decisions.

## Contribution rule

The repository owner requires approval before commits. Review the concrete local changes and ask before committing or pushing to GitHub.
