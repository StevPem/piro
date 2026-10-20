# PiRO: notes for Claude

PiRO is a remote control web app for an Icom IC-7300 (and similar Icom
radios), run on a Raspberry Pi. A Node.js server talks to the radio over
CI-V (USB serial) and to its USB audio codec through ALSA. Browsers
(usually phones) connect over a WebSocket. Users are Australian amateur
operators, so frequency tables follow the WIA band plans.

## Layout
- `src/civ/`: CI-V driver (`driver.js`), command bytes (`commands.js`),
  framing, DATA mode guard (`data-mode-guard.js`)
- `src/server/`: `ws-server.js` (ControlServer: requests, broadcasts,
  shared state), `protocol.js` (every request/event, documented inline),
  `index.js` (env vars, wiring), one `*-bridge.js` per feature
- `src/audio/`: encoders/decoders (FT8, RTTY, JTTY, Olivia, Feld-Hell,
  SSTV, CW), ALSA wrappers, workers
- `src/client/`: the PWA. Plain ES modules, no build step; `app.js` is
  the whole UI
- `docs/`: `civ-notes.md` (radio command history and corrections),
  `ui-notes.md` (one dated section per build), `audio-notes.md`,
  `pwa-notes.md`, `install-debian.md`

## Testing
- `npm test` runs everything that needs no hardware. It must pass before
  a commit.
- `test/manual-tty-ui.js` drives the real client in headless Chromium
  against a real ControlServer with a stub radio, with several browsers
  at once. It isn't in `npm test`; run it for any UI change. It needs
  Playwright (`NODE_PATH` to a Playwright install) and `CHROMIUM_PATH`.
- Other `test/manual-*.js` files talk to a real radio. Only the user can
  run those.
- Nothing has been tested on air unless the user says so. Say "not
  tested on air" for anything that transmits.

## Every change to the app
- Bump the build: `CACHE_NAME` in `src/client/sw.js` and the
  "**Current build: vN.**" line in `README.md` together
  (`test/readme-version.test.js` checks they match).
- Add a "### <title> (vN)" section at the end of `docs/ui-notes.md`:
  what changed, any real bug and its cause, the tests.
- Update the README where it applies: feature text, the protocol
  section, the test file list, env vars, troubleshooting.
- Write docs and UI text in plain, short sentences.

## Git
- Commit as Steve Pemberton <spemberton@gmail.com>.
- Branch from an up-to-date `main`; open every PR against `main`. A
  PR based on another branch merges into that branch, not main.
- Create PRs with `gh api repos/stevpem/piro/pulls`.

## Radio facts that cost real time (see docs/civ-notes.md)
- DATA mode is `1A 06` (`[01, filter]` on, `[00, 00]` off). It is not
  `1A 05 00 63`, which is an ACC/USB setting. The plain mode command
  (`06`) turns DATA mode off, so set DATA mode after the mode, and
  restore it after a filter change.
- Before keying audio, confirm DATA mode with `ensureDataMode()`
  (read back, retry, settle). PTT straight after the command could
  transmit from the microphone.
- The IC-7300's RTTY mode is FSK and ignores USB audio. PiRO sends RTTY
  as AFSK on LSB-D below 10 MHz and USB-D above, with mark the higher
  RF tone.
- CI-V CW text (`17`) takes 30 characters per command, answers NG when
  its buffer is full, and only transmits with break-in on.
- Australian class licence: remotely controlled transmissions stop after
  10 minutes (the PTT watchdog in ws-server.js). Anything that transmits
  without PTT needs its own limit.

## Design rules
- Canonical state: the transceiver is the source of truth for radio
  settings (frequency, mode, filter, DATA mode, power, preamp, NR and
  the rest), including changes made on its front panel. The server is
  the source of truth for its own settings: the app-level modes (FT8/FT4,
  FreeDV, JTTY, Olivia, Feld-Hell, SSTV) and their frequencies, the
  decoder and filter options, the notes. All clients must stay
  synchronised to these sources. A client never treats its own copy as
  the truth: it shows what the radio or the server reports, by event
  or by polling.
- Server settings go in `ControlServer.state` (the connect snapshot) and
  are broadcast on change. The browser that made a change must not
  re-send radio commands when it hears the broadcast.
- Phones disconnect and reconnect often. Don't rely on a client being
  there: stop transmissions and receivers when the last browser leaves.
- Long jobs (encoding, decoding) run in worker threads; the Pi also
  serves CI-V, audio and the WebSocket.
- Put back any radio setting a feature changes (mode, DATA mode, power,
  key speed, break-in), including on Stop and on errors.
- Third-party code keeps its licence notice (`third_party/`, `models/`).
  Parts are AGPL-3.0, so `SOURCE_CODE_URL` matters.
