# Notifications

The evidence behind the acceptance cases of `specs/notifications.md`.

## Runs

| Run | Date | Commit | Level | Environment |
| --- | --- | --- | --- | --- |
| R1 | 2026-11-22 | `aa8b2fc` | unit, local | An Agora execution, not g4: Node 24.22.3, PostgreSQL 17.12 (the `@embedded-postgres/linux-x64` 17.12.0 binaries), each test on a database of its own, Playwright 1.63.0's Chromium headless shell 153 with the DejaVu and Liberation fonts. N1 to N9 and N11 on the lab — FakeKube, real bridges, the mock agent —; the push services standing in as the engine's `Send`, each request recorded and answered as the case scripts; each payload decrypted by the test's own RFC 8291 `aes128gcm`, each VAPID token verified with `jose` against the server's public key. N10 against the server's own process as well. N12 to N14 in the browser against the server's process with its VAPID keys: the headless shell reaches no push service, asks no permission and shows no notification, so the page's `PushManager` and `Notification.permission`, the service worker's `showNotification` and `setAppBadge`, and the page's `getNotifications` stand in; a push reaches the real service worker through the DevTools protocol's `ServiceWorker.deliverPushMessage`. |

## Cases

| Case | Failure | Level | Run | Verdict | Observed |
| --- | --- | --- | --- | --- | --- |
| N1 | — | local | R1 | proven | Two subscriptions, Apple's and FCM's; the mock agent's `/question`: one notification `form` at the view's `request`, `sent`. To each endpoint one request: `TTL` between 86,390 and 86,400, `Urgency` `high`, `Topic` the id without hyphens, `Content-Encoding` `aes128gcm`; `vapid t=…, k=` the server's key, the token verified, `aud` the endpoint's origin, `sub` `mailto:operator@example.org`, `exp` within 12 hours. Decrypted: `web_push` 8030, the Workstream's title, `Question · Which database should the service use?`, `navigate` `https://agora.example/w/<id>`, `tag` the id, `data` its Workstream, position and `form`, `app_badge` `1`. |
| N2 | — | local | R1 | proven | A delegate's `/question`, its view's `request` set; another delegate's `/sub {"form":true}`, its native sub-stream `waiting` with a pending `elicitation`; a root's `/permission`, its view's `request` set; a root's `/form secret`, declined by Agora. One notification in all, the native sub-stream's, its position the form's, `sent`; one request, its `navigate` the native sub-stream's address. |
| N3 | simulated: forced-state, the engine stopped while the cards were answered or expired, then started | local | R1 | proven | `Approval · Start a dev on the parser`, `sent`, `TTL` between 50 and 60 for an expiry a minute ahead. Answered while stopped: `dropped`; expired after 1.5 s while stopped: `dropped`; still one request in all. |
| N4 | — | local | R1 | proven | `propose_merge` through `Merges`, GitHub standing in: `merge`, `sent`, `Merge · Add the parser` in the row and decrypted; `TTL` between 86,390 and 86,400. |
| N5 | simulated: forced-state, the engine stopped before sending; the lab halted and started again on the same database, then stopped cleanly and started again | local | R1 | proven | Before the restart: one notification `pending`, no request. After it: `sent`, one request. After the second restart and a rebuild of the projection: still one request, one row, `sent`. |
| N6 | — | local | R1 | proven | Three requests, `app_badge` `1`, `2`, `2`; their `Topic`s the first Workstream's, the second's, the first's. |
| N7 | simulated: stub, the push services' answers scripted | local | R1 | proven | Requests: 1, 1, 1, 2, 2, 1; the 429's second 8 s after its first at least; `sent`. Left: the 201's, the 429's, the 500's and the 400's subscriptions; the 410's and the 404's removed. A `push` line with `"status":410` and `"host":"web.push.apple.com"`; no line holds an endpoint's path or an `auth`. |
| N8 | — | local | R1 | proven | `http`, another host, port 8443, a `p256dh` of 64 bytes, an `auth` of 8: 400 `invalid_subscription` each, nothing stored. The same endpoint twice: one row, the second's `p256dh`. Ten held: the eleventh 409 `too_many_subscriptions`. `DELETE`: 200, nine left; of an endpoint nobody holds: 200, nine left. |
| N9 | — | local | R1 | proven | Each subscription's one request names its owner's Workstream; `GET /api/push/pending` with each owner: that owner's card alone, its position, `approval`. |
| N10 | real: the server's process exiting | local | R1 | partial: the client showing no switch is not asserted | The lab without keys: `GET /api/push` and `POST /api/push/subscriptions` 404 `push_unavailable`; an approval writes no notification. The server's process with three of the four variables: it exits before it is ready; with the four: `GET /api/push` 200, its key. |
| N11 | — | unit, local | R1 | proven | 150 crabs then a second line: 119 crabs and `…`; a blank line then `  Short one  `: `Short one`; an approval titled with 150 `x`: `Approval · `, 119 `x` and `…`. |
| N12 | simulated: stub, the browser's push service and permission prompt | local | R1 | partial: `PushManager` and the permission are stand-ins in the page, not the browser's | `Notifications: off`; clicked: the permission asked, then `subscribe` with `userVisibleOnly` true, `Notifications: on`, one row for the person's owner, an FCM endpoint. The server started again with another key on the same address, the page reloaded: `unsubscribe` then `subscribe`, one row, another endpoint. Clicked again: off, no row. The permission denied: `Notifications are blocked in this browser’s settings`, disabled, no row. |
| N13 | simulated: stub, the service worker's display and badge | local | R1 | partial: what the browser would display is the stand-in's record | A push delivered: the badge `1`, then `Pick a database`, `Question · Which database should the service use?`, its tag, its data with `navigate`. A push `{"hello":"world"}`: one titled `Agora`, nothing more. |
| N14 | simulated: stub, the notifications the page reads | local | R1 | partial: the notifications shown are the stand-in's | Two forms pending, their two notifications shown: none closed at start. The first form declined by a command: once the client is opened again, that one closed alone, the badge `1`. |
| N15 | — | live | — | not verified | — |

## Not covered

| Failure | Issue |
| --- | --- |
| Safari showing the declarative message by itself, its badge, and a tap opening `navigate`, on an iPhone's Home Screen: no run on iOS (N15) | — |
| A tap on a notification in a desktop browser: the service worker's `notificationclick` runs in no case (N15) | — |
| Apple's push service refusing the VAPID token or the payload: no request has reached a real push service | — |
