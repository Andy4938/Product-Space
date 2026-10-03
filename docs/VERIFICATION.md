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
