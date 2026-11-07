# Independent IC-7300MK2 review

Four independent SWE review lanes examined the LAN implementation at
`09f8db3`: protocol/stream handling, transmit safety, connection/UI lifecycle,
and security/PR readiness. Native Icom LAN transport uses UDP, although the
feature is sometimes described as a TCP connection. Fixes are in `6f590d4`.

| Finding | Resolution | Evidence |
|---|---|---|
| P1: old SSTV, EasyPal or TTY cleanup could change DATA routing or release PTT in a new connection | Capture the session object and generation; fence asynchronous setup, retries, playback and restoration; preserve ownership of newer producers | Original three localhost UDP reproductions no longer issue stale writes; 15 generation regressions pass |
| P2: canonical `CW_R`/`RTTY_R` names bypassed mode guards | Recognize canonical reverse modes and retain hyphen aliases | 12 mode-guard tests; physical CW_R typed/paddle completion and RTTY_R audio-PTT rejection |
| P2: connection/activity updates enabled Send without modem capability | Share availability logic between connection, TTY, JS8 and VARA renderers | Eight UI-state regressions, plus browser check |

The protocol lane found no confirmed blocker. Additional grant validation now
requires the expected grant format, authenticated/requested state, requested
radio GUID and success flag. It permits authentication-token rotation. A
redacted physical grant probe established the MK2 field layout; nine grant
regressions and the protocol/audio suites pass. The protocol reviewer checked
the patch independently. The security lane found no substantiated blocker;
credentials remain server-side, dependencies are unchanged, and protocol
provenance/licenses are documented.

An initial suspected stale-waveform replay was withdrawn after reproducing the
production central abort hooks. The distinct stale-cleanup finding above was
confirmed with those hooks present and fixed. The transmit reviewer reran all
three original reproductions after the fix and found no remaining blocker.

## Verification

- Raspberry Pi, Node 22.23.4: `TEST_RETRIES=0 npm run test:ci`, **65/65 groups**
  passed, including **158 LAN checks**. Native dependencies ran on the target.
- Chrome against normal PiRO startup with a localhost synthetic radio:
  unavailable JS8 and VARA Send remained disabled after frequency/activity
  updates; zero console errors. See [browser results](icom-lan-hardware-results/independent-audit-browser.json).
- Physical IC-7300MK2, build v139 (`6f590d4`): **42 checks** passed and all
  **11 restoration checks** passed. Receive PCM was nonzero without clipping;
  475-point scope lines were received. Controls included frequency, eight modes,
  filters, DATA, receive controls, meters and scope spans.
- With the operator-authorized dummy load, set/read **1 W**, sent **200 ms**
  PCM in voice and DATA modes, one `E` in CW and CW_R, aborted an active CW
  message, and keyed a **60 ms** reverse-CW paddle element. PTT released;
  original active mode/filter, DATA, frequency, receive controls, scope span
  and power were restored. See [raw results](icom-lan-hardware-results/independent-audit-v139.json).

These checks establish transport/control behavior, not measured RF power,
spectral quality or successful independent decoding. The mode sweep restores
the active mode/filter but can change other modes' stored filter preferences.
No prolonged soak or deliberate physical network failure during RF was tested.
