# PWA / HTTPS notes

## The secure-context constraint

Browsers gate several APIs behind a **secure context**: `https://`
origins, or `http://localhost` exactly. Plain
`http://<pi-hostname-or-ip>:8080` — how this app is normally reached on
the LAN — does **not** qualify, even though it's LAN-only and not
"insecure" in any practical sense here. Two different features are
affected, with different severity:

- **Service worker registration** (installability, offline support of
  the static shell) — degrades gracefully. `app.js` feature-detects via
  `window.isSecureContext` and simply skips registration over plain HTTP,
  logging a console note. The app still works completely normally as an
  ordinary web page either way.
- **`navigator.mediaDevices` / `getUserMedia` (microphone access)** —
  does **not** degrade gracefully. Outside a secure context,
  `navigator.mediaDevices` is `undefined` entirely, so PTT/TX audio is
  fundamentally unavailable, not just degraded. This is a real functional
  gap, not a cosmetic one — found in testing (see project history):
  pressing PTT over plain HTTP on a LAN address throws rather than
  prompting for mic permission.
- **`navigator.wakeLock` (Screen Wake Lock API)** — degrades gracefully,
  same as the service worker: `app.js` feature-detects with
  `'wakeLock' in navigator` and simply skips requesting it outside a
  secure context (or on a browser that doesn't implement it at all).
  Losing this over plain HTTP just means the phone's own screen timeout
  applies as normal — nothing else about the app is affected.

RX (speaker) audio is unaffected either way — playback via Web Audio
doesn't require a secure context, only *capturing* input does.

**Given the second point, TLS is no longer just "nice to have for
installability" — it's required for the microphone/PTT feature to work
at all from any device other than the Pi itself.** The server supports it
directly (see below); nothing forces you to add it, but PTT audio simply
won't work over plain HTTP from another machine on the LAN until you do.

## Enabling TLS

The server takes `TLS_CERT_PATH` and `TLS_KEY_PATH` env vars; when both
are set, it serves HTTPS/WSS instead of HTTP/WS (verified by
`test/tls-server.test.js`). The client (`rpc.js`) already picks `wss:` vs
`ws:` based on `location.protocol`, so no client-side config is needed —
just start the server with a cert and open the page via `https://`.

```bash
TLS_CERT_PATH=/path/to/cert.pem \
TLS_KEY_PATH=/path/to/key.pem \
CIV_SERIAL_PATH=/dev/ttyUSB0 \
AUDIO_RX_DEVICE=plughw:CODEC,0 \
npm start
```

### Option A: plain self-signed cert (openssl)

Simplest to generate, but every client browser will show a "not secure" /
certificate-warning interstitial on first visit per device, which you
have to click through (Chrome: "Advanced" → "Proceed"). Acceptable for a
small number of known devices you control.

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 825 -nodes -subj "/CN=<pi-hostname-or-ip>"
```

Use the Pi's actual LAN hostname or IP as the `CN` (or regenerate if it
changes) — browsers check the certificate against the hostname you
actually typed in the address bar.

### Option B: mkcert-generated local CA

Smoother experience — once the mkcert root CA is installed/trusted on a
device, certs it issues are trusted silently, no per-visit warning.
Requires an extra one-time step per client device (installing the root
CA), and `mkcert` itself needs to be installed on whatever machine
generates the cert (doesn't have to be the Pi). Not installed in this
project's sandbox at time of writing — see mkcert's own docs for
Raspberry Pi OS installation if you go this route.

### Option C: reverse proxy (Caddy, nginx, Traefik) terminating TLS

Caddy in particular can generate/manage a local CA automatically, giving
mkcert-like smoothness with less manual cert handling. This *is* an
actual additional component running on the Pi, though — a real trade-off
against the project's "single self-contained service" goal, not a free
win. Worth it if you want automatic cert renewal/management and don't
mind the extra moving part; not implemented here.

### Whichever option

Restart the server with the env vars set, then access it as
`https://<pi-hostname-or-ip>:8080` (note **https**, and the browser
warning on first visit for options A/C-self-signed). `http://` URLs will
no longer serve anything meaningful once `TLS_CERT_PATH`/`TLS_KEY_PATH`
are set, since the server switches entirely to HTTPS rather than serving
both.

## If you don't need TLS

If you only ever use PTT/TX audio from a browser running directly on the
Pi (`http://localhost:8080`), that counts as a secure context and
microphone access works without any TLS setup — this only matters for
other devices on the LAN. RX-only (listening, no transmitting) also works
fine over plain HTTP from anywhere on the LAN, if that's all you need for
now.

## Service worker cache versioning — bump this on every client change

`src/client/sw.js` precaches the whole app shell (`index.html`,
`styles.css`, `app.js`, and the rest of `SHELL_ASSETS`) and serves it
**cache-first** on every subsequent load — deliberately, so the PWA
still opens when the Pi is unreachable. The cache is keyed by
`CACHE_NAME`, a plain version string at the top of `sw.js`.

Browsers only discover a service worker update by comparing the service
worker *script's own bytes* against what they last installed — not by
noticing that `app.js` or `styles.css` changed. If `sw.js` itself is
byte-identical to what a browser already installed, that browser has no
way to know anything changed and will keep serving the old cached shell
**indefinitely**, even after the server is fully updated. This bit once
already (an FT8 UI change shipped without bumping `CACHE_NAME` — a
browser with an already-installed service worker kept showing the old
UI, while a phone/fresh browser profile that had never installed it
fetched the new files directly and looked fine, which is a confusing
symptom to debug from the client side alone).

**So: bump `CACHE_NAME` (e.g. `-v23` -> `-v24`) any time `index.html`,
`styles.css`, `app.js`, or any other file in `SHELL_ASSETS` changes.**
This number doubles as the on-screen app version next to the title (see
docs/ui-notes.md's "App version, next to the title" — `src/server/
index.js` reads it straight out of this file), so bumping it here also
updates what the operator sees on screen; there's no separate version
number to remember. Once bumped, `skipWaiting()`/`clients.claim()` in `sw.js` mean the new
version takes over on the very next page load (or the current one, if
the browser re-checks mid-session) — no need to unregister anything by
hand. If a user reports "I updated the server but the browser still
shows the old thing," this is the first thing to check, both for
whether `CACHE_NAME` was bumped in the delivered code and, as a
workaround for anyone stuck on an old cached version already, via the
browser's DevTools -> Application/Storage -> Service Workers -> Unregister
(then hard-reload).
