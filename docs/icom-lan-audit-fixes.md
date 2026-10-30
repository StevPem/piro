# LAN audit fixes (v121)

The independent review of `a571ea6` found ten reproducible defects. Each
has a code fix and regression coverage. These checks use synthetic radios,
local processes and native-pipe samples. Nothing is tested on a physical
IC-7300MK2 or on air.

| Finding | Change | Regression evidence |
|---|---|---|
| 1. Malformed audio crashed the service while keyed | Catch invalid PCM and playback failures at the browser audio boundary, reset queued audio and request PTT release. | Normal-process WebSocket test sends the original `[1, 0]` packet while keyed, checks radio PTT off and verifies another request succeeds. A separate test injects a playback exception. |
| 2. VARA QSY ran before unkey | Wait for drain and confirmed PTT-off before retuning. Reject QSY when release fails or the radio is still keyed. | USB and LAN tests defer PTT acknowledgment and assert no tuning occurs before confirmation. Failure test asserts no retune. |
| 3. Short chunks added silence to TX | Accumulate full 20-ms frames, preserve sample-clock phase and pad only an explicitly finalized tail. | Thirty real RADE conversion chunks of 10 ms yield exactly 28,800 PCM bytes with no padding. A separate final tail is padded once. |
| 4. Renewal flooded while ACK was pending | Pending requests use the ACK grace deadline; scheduled renewal applies only without a pending request. | A real UDP peer delays token ACKs by 600 ms; the session accepts them and stays connected without request flooding. |
| 5. UDP success reset the retry budget too soon | LAN driver confirms readiness only after CI-V identification, setup and state reads succeed. | Working UDP with a dead CI-V endpoint exhausts a retry budget of one and stays failed. |
| 6. RX missed samples during coalesced callbacks | Drain frames according to elapsed sample-clock time, with bounded catch-up after long pauses. | Continuous 48-kHz input with callbacks coalesced into 60-ms intervals preserves all samples. The original independent UDP/CPU-stall test preserves 192,000 bytes with zero drops. |
| 7. Reconnect left tuning/mode stale | Read frequency, mode and DATA mode during initialization; publish them through the ordinary driver events and client state. | Change the disconnected peer to 14.100 MHz/CW/DATA on and assert server state and decoder listeners receive the new values. |
| 8. Restore failure discarded old settings and left false PTT-on state | Keep each restoration record until it succeeds or the operator has changed that setting. Report a restore error separately from an acknowledged PTT-off. | Inject NG during restoration, assert actual and cached PTT off, retain the saved setting and restore it on the next release. |
| 9. Failed startup kept changed RX settings | Roll back completed RX changes while the association is still reachable, before closing the session. | Reject the second initialization setting and verify the first setting returns to its original value before close. |
| 10. VARA stayed selected after its modem stopped | Disable VARA through shared server state and broadcast the app-mode change on radio loss. Automatic reconnect does not restart its transmitter. | Normal PiRO process selects VARA, loses the radio, publishes VARA off, reconnects and accepts explicit VARA activation/CQ again. |

Run `npm run test:lan` for the focused tests, including
`test/icom-lan-audit.test.js`, or `npm test` for the complete suite.
`test/manual-lan-ui.js` and `test/manual-tty-ui.js` check the browser with
Playwright/Chrome. Exact final results are recorded in `icom-lan-plan.md`.

Saved settings remain available for another restoration attempt after a
recoverable failure. An unreachable radio still cannot be forced to stop or
restore settings; the existing hardware acceptance checklist remains required.
