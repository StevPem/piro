# IC-7300MK2 hardware validation

Tested on 2026-11-06 using a physical IC-7300MK2 and a Raspberry Pi running
64-bit Debian/Raspberry Pi OS with Node 22.23.4. The Pi boots from NFS.
The operator confirmed a dummy load and authorized brief low-power transmit
tests. Radio firmware was not recorded.

The running LAN branch was `2b3bd33d6b15cd1dfcae7230e67450d09121eaf0`.
The advertised-address discovery change was tested separately against that
radio using the candidate driver, without changing the running checkout.
The authenticated radio advertised CI-V address `B6`, and the identity reply
independently confirmed an IC-7300MK2 at that address.

## Observed results

| Function | Result | Evidence and limits |
|---|---|---|
| Login and model identity | Pass | Real credentials; native LAN; model ID B6. Credentials remain on the Pi and are absent from these artifacts. |
| Discovery | Pass with candidate fix | Initial broadcast discovery failed on hardware. Using the authenticated session's advertised address succeeds without an explicit override. Explicit B6 works on the deployed branch. |
| Frequency | Pass | Read, change by 1 kHz, read back, observe a second WebSocket client, restore. |
| Modes | Pass | LSB, USB, AM, FM, RTTY, CW; each read back. |
| Filters | Pass | FIL1, FIL2, FIL3 in USB. Original active mode/filter restored. Other modes' stored filter preferences were not preserved by this sweep. |
| DATA mode | Pass | Set/read on and off; original DATA state restored. |
| Receive controls | Pass | NR, NB, notch, preamp 0/1/2, RX gain set/read; original values restored and read back. |
| Meters and tuner state | Pass for reads | S-meter, SWR, ALC, TX power, RX gain, tuner. Receive-side zero SWR/ALC is not a transmit calibration. No ATU tuning cycle was initiated. |
| Scope | Pass | Sustained 475-point lines; Center spans 25/50/100 kHz; original span restored and observed. |
| Receive audio | Pass | Native 48-kHz mono PCM; nonzero sample amplitude, no clipped samples in the short capture. Operator also confirmed audible browser playback. This does not measure end-to-end latency. |
| Low-power setting | Pass | Set/read 5 W before transmission; original 100 W setting restored and read back afterward. |
| Voice audio/PTT | Pass at protocol/control level | 600 ms of 700-Hz PCM, low amplitude, with PTT acknowledgement; SWR raw 0, ALC raw 6; PTT released afterward. No independent RF power/spectrum measurement. |
| DATA audio/PTT | Pass at protocol/control level | Same brief PCM test with DATA mode on; radio acknowledged route/key/release operations. No independent digital decoder. |
| Typed CW | Pass at protocol/control level | One `E` at 20 WPM reached `sent`. A separate `EEEE` transmission was aborted while active and reached `aborted`. No independent over-air/keying waveform measurement. |
| Stop and restoration | Pass for checked state | CW stop, PTT off, current mode/filter, DATA state, frequency, NR/NB/notch, preamp, RX gain, scope span and power. Driver identity check also read actual radio receive state after the earlier tests. |
| Clean service restart | Pass after startup settled | Authenticated again, receive state reported, scope enabled, sustained audio and scope frames. An early connection during a previous restart exposed the cached-scope-status defect described below. |

Machine-readable observations are in
[`icom-lan-hardware-results/`](icom-lan-hardware-results/).
The controls-only record predates the added centralized restoration readbacks;
the final dummy-load record includes them. Timestamped snapshots describe each
test run, not the operator's subsequent tuning.

## Automated validation and candidate fixes

- Full `npm test` passed in a separate RAM-backed checkout on the Pi, with
  the advertised-address discovery change. This leaves the deployed checkout
  and radio service unchanged.
- Final `npm run test:lan` passed **59/59** tests, including custom advertised
  addresses, explicit overrides, invalid-address fallback, model rejection,
  and initial scope failure followed by reconnect and a fresh browser.
- `node test/icom-lan.test.js` passed before the final added regressions; its
  command format also passed the exact parser rule used by upstream CI.
- The discovery regression failed with a CI-V identity timeout before the
  driver fix. The scope regression failed with `false !== true` before the
  reconnect-status fix. Both passed afterward.
- Syntax checks on changed JavaScript and `git diff --check` passed. This
  branch does not define separate lint or typecheck commands.

The scope fix updates the cached scope-enabled state when reconnect startup
succeeds or fails. Previously, a transient initial failure could leave fresh
browsers reporting scope disabled even after scope data recovered. The
regression checks the fresh-browser snapshot; it does not certify every
already-open browser transition.

The final scope-status patch was covered by the full LAN suite and server
integration tests; the computationally expensive full baseline suite was
completed before that last patch. The subsequent upstream integration and its validation are recorded below.

## Reproduction

Run the manual harness on a host with this checkout and its installed `ws`
dependency. It connects to an already configured PiRO server; it never takes
radio credentials as command-line arguments.

For a read-only observation, omit both control flags. For the receive-control
sweep, use an actual WebSocket URL, for example:

```sh
PIRO_TEST_URL=wss://localhost:8080 \
PIRO_TEST_SELF_SIGNED=1 \
PIRO_TEST_OUTPUT=/tmp/icom-lan-controls.json \
  node test/manual-lan-hardware.js --controls
```

Playback is disabled in the harness. In a browser, click **Speaker: on** to
permit playback. Coordinate tuning changes with other operators first.
`--controls` changes receive settings and restores the original active state.
Mode cycling selects filter 1 in the other modes; it does not restore their
per-mode stored filter preferences.

Only with a suitable dummy load and explicit operator authorization:

```sh
PIRO_TEST_URL=wss://localhost:8080 \
PIRO_TEST_SELF_SIGNED=1 \
PIRO_TEST_OUTPUT=/tmp/icom-lan-dummy-load.json \
  node test/manual-lan-hardware.js --tx-dummy-load
```

The transmit option also runs the control sweep, checks the 5-W readback,
sends brief PCM in voice/DATA modes, checks short typed CW and active abort,
then attempts restoration with readback. A software cleanup cannot guarantee
radio release if the network or process fails; this harness does not certify
failure behavior. The PCM duration is not a measurement of RF key-down time.

## Remaining acceptance work

- Record radio firmware; test a non-default address and custom UDP ports on
  physical hardware. The synthetic peer covers these configurations.
- Validate actual front-panel changes, scope Fixed/Scroll modes, and audio
  latency with an independent observation.
- Measure RF power, modulation quality and successful independent decode for
  FT8/FT4/WSPR, keyboard, picture and FreeDV transmit routes.
- Test last-browser close, network loss, server termination and radio restart
  during transmission on a dummy load, with physical supervision and an
  independently observed radio timeout. Clean restart is a separate check.
- Run the documented receive soak longer than two hours and controlled
  packet-loss/VPN tests. Short successful sessions do not replace this.
- Repeat the hardware sweep after deploying the integrated build. The physical
  observations above belong to the earlier LAN build and candidate discovery
  driver, not to the later upstream integration.

The LAN test entry in `npm test` now uses `node test/icom-lan.test.js`, which
preserves the command form required by upstream's `test/run-all.js`.


## Upstream integration (build v135)

Integrated `StevPem/piro:main` at `da2d962fd8cf5a900e8511afaa4a6132cd634c79`,
including all 37 commits previously absent from the LAN branch. The merge
preserves upstream Origin checking, browser heartbeat and PTT-owner release,
backpressure, CI-V stale-reply guard and queue ordering/limits, CW keyline and
paddle support, JS8, STT and DeepCW worker execution.

Integration changes preserve USB CW keyline configuration through the new
radio factory, cancel pending paddle elements on LAN radio loss, discard
stale asynchronous JS8 encode results, drain LAN JS8 playback before unkeying,
and keep PTT unknown when a LAN watchdog release cannot be confirmed.
The service's USB-disconnect exit path does not terminate a LAN reconnect.
These paths are tested with isolated fixtures and do not transmit on hardware.

The working Pi installation was not changed by the merge. Hardware evidence
above must not be presented as a hardware test of the integrated build.


### Existing deployment observation during integration

At 20:44 UTC on 2026-11-06, the unchanged deployed `2b3bd33` build crashed
with an unhandled `EPIPE` from `RadePipeline.write` in the optional
FreeDV/RADE path. Systemd retried startup and recovered. The integration
fixtures use isolated localhost peers and did not replace the running
service or connect those peers to the real radio. This live optional-codec
failure is not resolved or hardware-certified by the upstream merge;
FreeDV requires a separate runtime investigation before claiming it works.


### Integrated automated result

On the Pi, the final integrated tree passed `TEST_RETRIES=0 npm run test:ci`:
**65/65 test-file groups passed in 338 seconds**, with **68/68 LAN subtests**.
Changed JavaScript syntax and both staged/working diff checks passed. No
separate lint or typecheck command is defined. The first full run identified
a key-line test that still scanned the old serial-factory location; adding
`src/server/radio-connection.js` to that scan fixed it, and the fresh complete
run passed without retries. No integration code was deployed by this check.


## Subsequent RADE broken-pipe fix

The optional-codec crash observed above was reproduced and fixed separately
from the upstream merge. Child stdin/stdout/stderr failures and synchronous
spawn/write failures now stop the pipeline before notification. Late callbacks
from stopped children cannot affect a new pipeline. TX failure flushes playback
and requests PTT off while keeping raw microphone playback muted until release
is confirmed; a failed release is reported instead of exposing raw audio.

The pipeline and bridge test files passed **30 + 61 checks** on both the local
machine and Linux/Pi, with failures reproduced before the fix. Those two files
also passed against the original deployed LAN source before restart. The full
65-group integration run above preceded this bounded fix; its four changed
source/test files were verified separately rather than rerunning unrelated
signal-processing suites.

Only this four-file fix was applied to the working Pi, on branch
`fix/rade-pipe-crash`; the integrated upstream build remains undeployed. A live
receive-only check selected RADE with the native tools still absent: PiRO
reported the codec error, retained MainPID 3079631 with zero restarts, and after
FreeDV was disabled delivered 76 RX audio frames and 48 scope frames during the
short check. The result is in `icom-lan-hardware-results/rade-crash-fix.json`.
No RF transmission was made for this check. The missing native RADE tools
still prevent actual FreeDV encoding/decoding; that remains separate setup work.


## Shared radio manager (build v136)

The final candidate passed `TEST_RETRIES=0 npm run test:ci`: **65/65 groups in
340 seconds**, including **79/79 LAN subtests**. Eleven new lifecycle cases
cover shared browser status, native-only management, repeated reopening and
raw PCM recovery, retry/handshake cancellation, receive-setting rollback
before session release, delayed parameter-write ACKs, rapid caller intents,
restored automatic retry, and discarding mock transmission/audio on close.
Existing reconnect snapshot coverage still verifies that a confirmed driver
tune between initialization reads wins over an older read; browser mutations
are deliberately gated until the managed session is ready.

Chrome checks verified Connect/Disconnect without losing the browser link,
disabled tuning/PTT while offline, recovery on reconnect, keyboard operation,
and no browser errors. At 375/414/768/1024/1440px there was no horizontal
scrolling, the panel stayed in the viewport, and summary/action touch targets
measured44px. Visual review passed at95/100 against the existing page style.
Observations are in `icom-lan-hardware-results/radio-manager-browser.json`.
No RF transmission was made for this feature's fixture/browser checks.


### Physical manager acceptance after deployment

Build v136 (`0308ffa`) was deployed to the Pi on 2026-11-06 and tested against
the physical IC-7300MK2 in receive. Two WebSocket clients retained their
browser connections while one disconnected the radio; a newly opened third
client also saw the deliberate disconnected state. All three radio UDP sockets
were released, and no RX audio or scope frames arrived during the off interval.
Connect reopened all three sockets and restored99 audio frames and60 scope
frames over the short capture. Frequency remained10,120,710Hz, CW/FIL2 before
and after. The process remained PID3083076 with zero restarts. Measured local
operations were23ms to disconnect and83ms to reconnect; these are one LAN
observation, not general latency guarantees. The test left the radio connected.
No RF transmission was made. Full observations are in
`icom-lan-hardware-results/radio-manager-live.json`.

This deployment supersedes the earlier note that only the RADE hotfix had
been deployed: the Pi now runs the integrated upstream build plus RADE fix
and the shared radio manager. The native RADE tools are still absent.


## Native RADE installation and software acceptance

On 2026-11-06, native ARM64 tools from `freedv/rade_c` commit
`c8a3dc156045cae2cd251e1a4be0c304c9ddf2f9` were built on the Pi5 with its
pinned Opus/FARGAN dependency (`940d4e5af64351ca8ba8390df3f555484c567fbb`).
Installed `radae_tx`, `radae_rx`, `lpcnet_demo`, WAV helpers and `real2iq` in
`/usr/local/bin`, with `librade.so.0.1` and its symlink in `/usr/local/lib`.
The runtime library path explicitly uses that persistent directory and was
checked after deleting the temporary RAM build. Build sources, licenses,
manifest/checksums, log and sample decoded speech are retained under
`/usr/local/share/piro-native-tools/rade/`.

RADE V1 native feature/encode/decode/synthesis and WAV round trips passed on
9.82seconds of supplied test speech; the upstream V1 text tests passed6/6.
PiRO's actual `RadeBridge` receive path, using installed native subprocesses,
decoded9.43seconds of generated modem audio without codec errors. No radio or
RF output was attached to that test. JSON observations and installed binary
hashes are in `icom-lan-hardware-results/native-rade-*.json`.

The operator had deliberately disconnected the real radio, so that state was
preserved. PiRO remained PID3083076 with zero restarts; no restart or radio
connection was required for installation. This supersedes earlier historical
notes that the native RADE tools were absent. Actual on-air RADE audio and RF
performance are not certified by software loopback tests.

Other optional-tool audit: Whisper server/model is still absent for STT;
RNNoise is absent but hidden in the current UI. DeepCW/ONNX, HamNoise WASM,
VARA/Xara WASM, JS8 data and the other bundled modes are present. Neither
Whisper nor RNNoise is required for radio control or RADE.


## Mode-aware reconnect acceptance (build v137)

The physical MK2 in USB/FIL2 rejected CI-V CW-stop17FF with FA while already
receiving. Unconditional keyer stop therefore prevented Connect. Startup now
releases PTT in every mode, reads the selected mode, requires keyer stop in
CW/CW_R, and requires actual receive-state value0 before readiness. It does
not change mode. Safety cleanup finishes before a manual cancellation releases
an authenticated session. Model/read failures, rejected CW stop in CW, failed
PTT release and non-receive readback remain fatal.

Regressions failed before the fix; afterward all96 LAN subtests, the existing
CI-V driver suite, version, syntax and diff checks passed. A timer-phase-sensitive
packet-loss test was corrected to use the normal80ms reorder window instead
of10ms, shorter than its20ms tick. The reconnect snapshot test still injects a
confirmed tune between the state reads, after the added safety-mode query.

Deployed code77dd9d8 was tested in USB/FIL2 at14,083,750Hz without changing
mode or frequency. All3 radio UDP sockets closed and reopened. Receive audio
and scope recovered (98 audio and60 scope frames in the short observation),
with the same PID3098861 and zero restarts. Disconnect took24ms and Connect
106ms in this single LAN observation. No RF was transmitted. The radio was
left connected. See `icom-lan-hardware-results/usb-reconnect-fix.json`.
