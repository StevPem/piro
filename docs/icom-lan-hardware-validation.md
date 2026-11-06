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
completed before that last patch. Full upstream validation remains required
after integration with current upstream.

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
- Integrate with current upstream before opening the PR. This branch predates
  37 upstream commits, including Origin checks, PTT-owner/heartbeat safeguards,
  queue ordering, backpressure, CW keyline/paddle, JS8, STT, and DeepCW worker
  changes. Preserve those changes when resolving the shared files.

The LAN test entry in `npm test` now uses `node test/icom-lan.test.js`, which
preserves the command form required by upstream's `test/run-all.js`.
