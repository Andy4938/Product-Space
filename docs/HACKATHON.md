# PhanTomSignal hackathon guide

“Emergency buttons protect a location. Our system protects the person as they move.”

## Scope

Build for the uncertain moment when someone feels unsafe while walking: start a temporary session, share it with a trusted person, keep moving, and silently request help if needed. The guardian needs the current location and its freshness, not just the starting point.

Campus emergency phones only help if you can reach one. PhanTomSignal moves the help button to the student's phone. A help signal opens an incident on a Campus Safety console with live location, and notifies an optional guardian by push notification and text. The console is a prototype and is not connected to UIUC Police, 911, or Illini-Alert.

## Two-minute demonstration

Set up three windows before you start: the student page (phone-sized), the guardian link, and the Campus Safety console at `/dispatch`, preferably on the big screen. Set `DISPATCH_ACCESS_CODE` beforehand so the code doesn't change.

1. On the student page (phone-sized window), start the clearly labeled simulated walk. Open **Help responders find you** and enter "red jacket, black backpack."
2. Open the guardian link and choose **Turn on notifications**. Explain that this replaces "hoping someone is watching a dashboard."
3. Show the empty console: "Monitoring. No open signals."
4. On the student page, **hold "Emergency help" for three seconds**, then let the cancellation window expire. The same page confirms receipt and shows dispatcher progress. The console sounds an enabled alarm and shows an incident with location and "Look for: red jacket, black backpack." The guardian's phone shows "Don't call or text them." The student's **Share guardian link** opens only the sharing dialog; it never opens a map of their own walk.
5. On the guardian page, use **Share what you know** to send "Walking from Grainger to ISR." The incident shows a red unread-message badge in the dispatcher queue. Opening it clears the badge; a later student message or guardian note brings it back.
6. In the console, choose **Acknowledge**, then dispatch "Patrol 2." The student feels a vibration and sees "Responder dispatched," without a call or text. Point out that a blue-light phone can't do this quietly.
7. Show the marker and trail moving on the console while the student keeps walking.
8. Close the incident with "Responder reached walker and escorted them to safety." Show that the console loses the location and description once the incident is closed.
9. Show the safeguards: a cancelled signal stays open as "possibly coerced, verify in person," and ending the walk keeps the last known location for Campus Safety.

Without Twilio keys, guardian texts appear as labeled `[simulated SMS]` lines in the server console. Say that they are simulated.

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
- Check the student and guardian views at phone width. The student has no map or alternate walk view; sharing opens the private-link dialog and tracking continues. The guardian retains its map, including zoom controls.
- On a phone, dispatcher Signals/Details/Map navigation works without sideways scrolling. Verify alert sound can be muted and manual connection retry does not reset the selected incident.
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
- Choose an SMS provider account and sending number, and decide whether guardians must opt in before receiving texts.
- Validate actual phone behavior when the page is hidden or the screen locks; a browser prototype cannot promise continuous background tracking.
- Define account identity, guardian verification, location retention, abuse controls, and operational ownership before public use.

## Repository workflow

The project owner requested approval before committing anything. Keep changes local and uncommitted until they review and approve a concrete commit. Do not push or create a pull request without authorization.

## Browser references

- [Geolocation watchPosition](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition): secure context and permission requirements, continuous callbacks, and watch cleanup.
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API): visibility changes and browser background throttling.
- [Leaflet reference](https://leafletjs.com/reference.html): maps, markers, polylines, and accuracy circles.
