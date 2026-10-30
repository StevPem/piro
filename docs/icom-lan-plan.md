# Native Icom LAN implementation

Target: IC-7300MK2 over its built-in Ethernet/RS-BA1 UDP interface.
Branch: `feat/icom-lan`. Hardware is unavailable. Nothing is tested on air.

## Work plan

- [x] Record official manual and pinned implementation evidence.
- [x] Stage 1: packet codec, reliable UDP streams, session lifecycle, CI-V integration and configuration.
- [x] Stage 2: CW, urgent commands, cancellation and reconnect isolation.
- [x] Stage 3: bounded RX PCM jitter buffer and existing spectrum pipeline.
- [x] Stage 4: paced TX PCM, model-specific LAN modulation and common audio backend.
- [x] Independent localhost peer, packet vectors, lifecycle/fault/audio/CW/scope integration tests.
- [x] Full suite, USB regression verification, setup instructions and hardware acceptance checklist.
- [x] Review changes and create feature-branch commits.

## Completion criteria

All four stages must run through normal server startup. No runtime reference
application, virtual serial port, virtual sound card or ALSA hardware is needed
in LAN mode. USB stays the default. Offline tests must use real UDP sockets
and independent packet expectations, exercise reconnect/session renewal,
sequence boundaries, packet faults, CW abort, scope, RX/TX PCM and PTT order.
Document uncertainties rather than treating simulation as hardware proof.

## Evidence log

- Initial tree: clean `main`, matching `origin/main`; `origin` is s53zo/piro,
  `upstream` is StevPem/piro. Read `CLAUDE.md` project conventions.
- Existing seams: `CivDriver` accepts a serial-like injected transport but
  still requires `path`; `AudioBridge` accepts capture/playback injections.
  Server startup and several radio settings currently assume USB.
- Reference checkouts are under `/tmp/piro-icom-reference`, outside this tree.
- Baseline initially stopped at missing `serialport`; installed locked npm
  dependencies with `npm ci`. The installed baseline stopped at an existing
  SSTV spectrum timing race. An isolated rerun reproduced it. Repaired the
  asynchronous test wait without relaxing its picture or spectrum assertions.
- Read and rendered Icom's CI-V routing table; downloaded Basic and Advanced
  manuals too. Pinned source revisions, exact fields, page numbers and PDF
  hashes are in `icom-lan-sources.md`.
- Implemented protocol/stream/session/audio/driver modules and normal startup
  configuration. LAN mode starts all existing decoder/TX bridges with injected
  PCM adapters, without ALSA. Only verified MK2 identity enables audio routing.
- Independent peer imports no production codec. Literal byte tests pin mixed
  endianness, credential encoding, stream negotiation and full scope lengths.
- Localhost tests cover authentication, token boundaries/expiry, stale sessions,
  packet faults, urgent stops, CW, PCM pacing/limits, routing/restoration and
  existing FT8 bridge output. Normal-process test covers actual WebSocket
  control, microphone PCM, RX PCM and scope, and graceful settings restoration.
- Compiled and ran AetherSDR's own standalone `icom_protocol_test.cpp` with
  clang++ against the pinned `IcomProtocol.cpp`; all checks passed.
- Complete `npm test` after implementation passed. The final full run after
  lifecycle, queue-cap and audio startup review also passed (exit 0).
- Existing `manual-tty-ui.js` passed using isolated Playwright and Google
  Chrome. One concurrent run exposed its existing JTTY spectrum timing race;
  a subsequent isolated full run passed without changing that assertion.
- Added and ran `manual-lan-ui.js`: connected status, radio release/reconnect,
  360-pixel layout and no browser page errors passed. Visually inspected the
  screenshot and moved radio status to its own header row to preserve title
  readability on a narrow phone.
- Actual `npm run demo:lan` started on localhost and supplied PCM plus a
  487-byte scope frame (12-byte browser header + 475 points) to a WebSocket
  client. Ctrl-C stopped the listener and child process; verified no process
  or listening socket remained.
- Final source review added a serialized PTT transition queue, bounded audio
  buffering during route preparation, and a priority reservation at the CI-V
  queue cap. Tests cover release/new-key races, pre-key audio cancellation,
  and Stop while 256 polling jobs are queued.
- The normal-server test now also verifies last-browser CW abort, a fresh
  client's PTT=false snapshot, loss during CW, no resumed chunks, token
  deauthentication and all three stream disconnect packets on shutdown.
- Latest focused LAN suite: 28 tests passed, including the normal process
  and CW-loss lifecycle checks. Final full suite: passed, including all 28
  LAN tests and every existing package test. Both existing browser checks
  and the native LAN browser check passed; no physical radio was contacted.
- Delivery commits: `6966e06` isolates the existing SSTV test race repair.
  The following feature commit contains the native implementation, tests,
  source/license evidence, setup guide, acceptance checklist and this ledger.
  No implementation work remains from the four offline stages. Physical
  firmware/RF/timing confirmation stays pending by design, not a completion
  claim made by this offline implementation.

## Original v120 verification commands

Host: macOS arm64, Node v26.12.1. USB hardware and Raspberry Pi hardware
were not attached; existing USB behavior is covered by the unchanged
serial-transport tests. Reference clones and browser dependencies are outside
the tracked tree under `/tmp/piro-icom-reference`.

| Command | Result |
|---|---|
| `npm run test:lan` | 28 passed, 0 failed. |
| `npm test` | Exit 0; complete existing suite plus 28 LAN tests. |
| `node test/civ-driver.test.js` | All serial-driver checks passed. |
| `NODE_PATH=/tmp/piro-icom-reference/browser/node_modules CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node test/manual-tty-ui.js` | All UI checks passed; no page errors. |
| Same environment, `node test/manual-lan-ui.js` | LAN status, release/reconnect, 360px layout, no page errors: passed. Screenshots inspected. |
| `npm run demo:lan` | Normal service started; WebSocket client received PCM and 475-point scope; stopped and verified no listener remained. |
| `git diff --check` | No whitespace errors. |
| `clang++ -std=c++20 -I src src/core/backends/icom/IcomProtocol.cpp tests/icom_protocol_test.cpp -o /tmp/piro-icom-reference/reference-protocol-test` followed by that executable, in the pinned AetherSDR checkout | Reference protocol checks all passed. |

## Audit corrections and v121 verification

Three independent SWE auditors reviewed `a571ea6`. Ten reproducible defects
were confirmed and fixed. The finding-to-fix matrix and regression evidence
are in [icom-lan-audit-fixes.md](icom-lan-audit-fixes.md).

The same auditors rechecked their findings after the fixes. Their original
reproductions now pass, including delayed token replies, exhausted CI-V retry
budgets, partial RADE chunks, RX callback stalls, restoration NG replies and
VARA state recovery. They reported no further actionable regression.

| Command or check | Result |
|---|---|
| `npm run test:lan` | 41 passed, 0 failed, including the new audit regressions and normal-process fault tests. |
| `npm test` | Exit 0; complete existing suite and all LAN regressions passed. |
| `node test/vara.test.js` | Passed. |
| `NODE_PATH=/tmp/piro-icom-reference/browser/node_modules CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node test/manual-tty-ui.js` | All UI checks passed; no page errors. |
| Same environment, `node test/manual-lan-ui.js` | Connected status, release/reconnect and 360px layout passed; no page errors. |
| Independent UDP/CPU-stall reproduction | All 192,000 input PCM bytes preserved; zero dropped bytes. |
| Real RADE conversion chunks | Thirty 10-ms chunks produced exactly 28,800 PCM bytes with no padding. |
| `git diff --check` | No whitespace errors. |

These checks remain offline. Physical IC-7300MK2 firmware, LAN timing and RF
behavior still require the hardware acceptance checklist. Not tested on air.
