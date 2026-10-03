# GhostSignal hackathon guide

“Emergency buttons protect a location. Our system protects the person as they move.”

## Scope

Build for the uncertain moment when someone feels unsafe while walking: start a temporary session, share it with a trusted person, keep moving, and silently request help if needed. The guardian needs the current location and its freshness, not just the starting point.

This prototype updates an open guardian dashboard. It does not dispatch responders, send SMS or push notifications, contact 911, assess threats, or connect to Illini-Alert.

## Two-minute demonstration

1. Open the student page. Start the clearly labeled simulated walk for a predictable demonstration without collecting anyone's actual location.
2. Copy the guardian link and open it in a second browser window, preferably on another display. Explain that the link grants access to the session and should only be shared with a trusted person.
3. Show the changing current marker, movement trail, location timestamp, and accuracy radius. The simulated walk should be labeled in both views.
4. Use the map's **+** and **−** buttons to zoom. Show that incoming positions preserve the selected zoom.
5. Press **I need help** on the student page. Show the guardian status changing while the student keeps moving. Explain that the status appears in the guardian's open dashboard.
6. Choose **Retract help request** to return to an active walk. The guardian's help status clears while the same private link, route, and location sharing continue. The student can request help again.
7. End the session with **I'm safe**. Show that location sharing stops and the guardian view removes the coordinates and trail.

For a real walking demonstration, use a supported phone browser with location permission and a trusted HTTPS origin. Keep the student page open and screen unlocked. A phone visiting a laptop's plain HTTP LAN address generally cannot use browser geolocation; desktop localhost is treated differently.

## Acceptance checks

- Start a real session only after the student chooses to share their location; explain the permission request and show an actionable denial state.
- Use the same backend from independent clients. Browser-local storage is not the source of shared location data.
- Show live and simulated sessions distinctly. Never silently replace failed GPS with simulated movement.
- A guardian can view their linked session but cannot update location, request help, or end it.
- Missing or incorrect tokens cannot read session data. Do not expose a public list of sessions.
- Show the age of the captured location. Receiving an old point again must not make the point look freshly captured.
- A failed location update or disconnected dashboard must have a visible error or stale state.
- A help request is shown as delivered to the server only after the server acknowledges it. Retry must be available when it fails.
- Ended and expired sessions cannot accept more location updates. Remove their coordinates and movement trails.
- The interface makes no unsupported claim that a person is watching or that help is on the way.
- Check the student view at phone width and the guardian view at laptop width.
- Test denied location permission, network interruption, page reload, session end, and session expiry.

## Team ownership for the remaining 24 hours

| Person | Responsibility | Completion checkpoint |
| --- | --- | --- |
| Student frontend | Consent, GPS, share link, silent help, end session | Student can finish a complete session on a real phone |
| Backend | Access control, validation, session lifecycle, persistence | Independent devices see the same session; sensitive state is cleared on end |
| Guardian dashboard | Map, trail, accuracy, freshness, help state | Movement and escalation are understandable without explanation |
| Integration and presentation | HTTPS deployment choice, real-device testing, backup recording, pitch | A rehearsed demonstration and a documented list of limits |

Integrate the complete flow by hour 8. Freeze features by hour 20. Add destination and ETA only after the core path passes the checks above.

## Decisions still needed before a hosted pilot

- Choose a host and a stable HTTPS origin that both student and guardian can access.
- Decide whether a guardian is expected to keep the dashboard open or whether a separate notification feature is needed.
- Validate actual phone behavior when the page is hidden or the screen locks; a browser prototype cannot promise continuous background tracking.
- Define account identity, guardian verification, location retention, abuse controls, and operational ownership before public use.

## Repository workflow

The project owner requested approval before committing anything. Keep changes local and uncommitted until they review and approve a concrete commit. Do not push or create a pull request without authorization.

## Browser references

- [Geolocation watchPosition](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition): secure context and permission requirements, continuous callbacks, and watch cleanup.
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API): visibility changes and browser background throttling.
- [Leaflet reference](https://leafletjs.com/reference.html): maps, markers, polylines, and accuracy circles.
