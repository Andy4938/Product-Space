# MVP verification

Verified on October 2, 2026 in the local Windows development environment with Node.js 24.21.0.

## Build and automated checks

- Final `npm run build` passed after implementation and review fixes: TypeScript checks and Vite production bundling succeeded.
- `npm test` passed all three grouped API tests. They exercise separate owner/guardian access, invalid credentials, live updates, end and help retries, location removal, persistence, fixed expiry, timestamp validation, and update ordering/rate limits.
- `git diff --check` found no whitespace errors. At initial verification, the application changes were uncommitted and the branch still pointed to the repository's initial commit.

## Browser verification

Using the actual local frontend and backend, with simulated coordinates only:

1. Started a simulated walk and confirmed its demo label, rendered campus map, changing marker, route, and accuracy.
2. Opened the app's guardian link in a separate browser tab and verified shared location and status.
3. Requested help from the student view and confirmed the guardian displayed the help state.
4. Ended the walk and confirmed the guardian removed the location and map trail.
5. Inspected the narrow layout and moved help/end controls ahead of the map and sharing card.
6. Stopped the development server, attempted help, and verified the student did not display a successful request. Both views reported a connection interruption and the captured-location timestamp aged.
7. Restarted the server. The persisted session reconnected, and retrying help succeeded in both views.
8. Ended the test session and returned the student preview to the start screen.

## Review fixes

- Prevented older polling results from reversing help or ended state.
- Kept GPS/upload errors separate from successful status polling.
- Distinguished automatic expiry from the student's safe-end action.
- Removed terminal maps and misleading retained-path text after redaction.
- Bounded requests to ten seconds so failed help/end operations remain retryable.
- Gated restored sessions until the backend verifies them.
- Used captured timestamps for location freshness and filtered old GPS samples.
- Corrected the OpenStreetMap tile URL and referrer policy after observing blocked tiles in the browser.
- Added a direct guardian-view link and kept action failures near the controls.
- Reset scroll position when starting or resetting a walk.

## Still requires a real-device test

Actual phone GPS and permission behavior were not exercised. There is no verified background tracking. Cross-device real GPS needs a selected HTTPS deployment and testing on the team's phones. Public hosting, notification delivery, and emergency-service integration are outside this local MVP.

## Zoom and help-retraction follow-up

- Production build, TypeScript checks, and all three expanded API test groups passed.
- Browser verification exercised zoom in and zoom out in both views. The student retained zoom level 17 and the guardian retained level 15 through incoming movement updates and help retraction.
- Help activation, retraction, continued movement, and a second help request were verified with a student tab and its guardian tab. The private link stayed the same and the route remained visible.
- API tests verify owner-only retraction, retry behavior, persisted active state, preserved location/trail/expiry, continued location updates, repeat help requests, and rejection after end or expiry.
- Logical update timestamps advance for every state change, including changes occurring in the same millisecond, so older polling responses cannot restore a retracted alert.

## Location latency follow-up

- Replaced the coarse upload interval with a serialized, latest-position queue. Tests cover the 1.1-second gap, slow requests, newest-position selection, retries, stale/duplicate samples, and teardown.
- Added fresh-position recovery after ten seconds of stalled capture, with tests for foreground recovery, permission denial, stalled requests, original timestamps, late callbacks, and cleanup.
- Guardian polling runs every second, with immediate refresh on foreground, focus, or network reconnection. The view now distinguishes location receipt from the last successful dashboard refresh.
- Initial location upload completes before continuous tracking starts; help/retraction no longer restarts the live GPS watcher.
- Production build and all 14 tests pass. Local browser checks confirmed continuing simulated movement, guardian help/retraction, and the new freshness fields.
- The reported two-phone Cloudflare delay has not been reproduced here. Actual phone GPS and tunnel latency still need a device retest; no fixed GPS update rate is promised.

## Emergency receipt and status follow-up

- Started from the latest GitHub main, `a1603ad`.
- All 42 tests and the production build pass. The five rendered-status tests were rerun after refining the closed-incident location text and also pass.
- Tests cover the three-second undo window, failed/unconfirmed sends, lost responses, cancellation failures, missing location, restored status, dispatcher stages, cancellation metadata, and a deliberate new signal after closure. Cancellation metadata persists without exposing private dispatcher notes.
- Used an isolated localhost server with an in-memory database and silent notifications for browser checks. A simulated walk received fixture-driven incident and dispatcher transitions; actual hold timing was covered by the deterministic hold-flow tests.
- Verified that delivery replaces the send button, acknowledgement and dispatch update automatically, cancellation remains pending through reload, stopping live location requires confirmation, the incident remains visible after stopping/reloading, and closure displays the recorded outcome.
- Inspected the status view at a 390-pixel phone width and restored the normal viewport afterward. Closed the isolated preview and stopped its server after testing.
- Actual phone GPS and external notification delivery were not exercised.
