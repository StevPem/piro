# VarAC formats (from hfmodem)

VarAC is closed source and its formats are not published. hfmodem, by
Saul St John (W9SSJ), works them out from recordings of stock VarAC on air
and implements them. PiRO's `src/server/varac.js` is a JavaScript port of
the parts PiRO uses.

| | |
|---|---|
| Upstream | hfmodem, commit `a340f5c` (2026-10-26), https://github.com/sstjohn/hfmodem; site https://hfmodem.ssj.lol/ |
| Upstream file | `packages/hfmodem/hfmodem/contact/varac.py` |
| Upstream licence | AGPL-3.0-only (code); CC BY 4.0 (protocol descriptions and site) |
| PiRO licence | AGPL-3.0-only, the same |
| Copyright | 2026 Saul St John (W9SSJ) |

## What was ported

| PiRO (`src/server/varac.js`) | hfmodem (`contact/varac.py`) |
|---|---|
| `decodeCqCall()` | `SlotCodec.decode()` and `offset_hz()`: a CQ's callsign suffix is its slot. -1 to -5 are 750 to 3750 Hz below the calling frequency, -11 to -15 750 to 3750 Hz above, -9 a beacon on the calling frequency |
| `frameMessage()` | `frame_message()`: each message is its UTF-8 length in bytes (ASCII digits), a space, the text |
| `MessageParser` | `MessageParser`, including the VMail length quirk (the closing `>` not counted). PiRO adds a fall-back: a stream that isn't framed is shown as plain text (VARA Chat) |
| `openingMessage()` | the opening report in `opening_steps()`: `de CALL <R+05>`, the S/N clamped to ±99 |
| `renderMessage()` | PiRO's own: puts the tags hfmodem lists (`TAGS`, `VALUE_TAGS`, `BARE_TAGS`, `<R±NN>`, `<QSYF>…</QSYF>`) into words |
| `qsyTarget()`, `qsyRequest()`, `isOpening()` | `received_qsy_target()` (`<QSYF>` 12 digits, `<QF:Hz>`, `<Q:n>` in tens of Hz), the opening-report match. PiRO sends `<Q:n>`, not hfmodem's `<QSYF>`: every QSY request heard from stock VarAC on air (KiwiSDR, 2026-10-28) was `<Q:n>` |
| `decodeBeacon()` | `BEACON_TEXT`, `services()`: the advanced beacon (KISS command 2) and its status letter |
| `decodeUi()` | the addressed notices (`mail_collection.py`): an AX.25 UI frame, `<SMP>` meaning VMail waiting |
| `CALLING_HZ` | `CALLING_HZ` (with PiRO's 160 m frequency) |

`src/server/vara-bridge.js` follows hfmodem's QSY handshake:
`request_qsy_steps()` (wait for `<Q>` or `<AWQ>`, send the request, move once
it has been delivered, `<TL>`, wait for `<QSYR>`, opening report) and
`answer_qsy_steps()` (our modem acknowledges, then move, wait for `<TL>`,
`<QSYR>`, their report, ours). On the calling frequency the answering
station sends only `<Q>`, and the reports wait for the slot (REL V11.4 in
hfmodem's notes).

PiRO also uses hfmodem's findings that VarAC waits on its slot about
2 minutes after a CQ (`SLOT_WAIT_S`), that profile tags follow the opening
report (`<NAME:…>`, `<QTH:…>`, `<LOC:…>`), and that `<DISC>` comes before
the link is closed.

Not ported yet: calling CQ on a slot, choosing a free slot, sending
beacons, VMail, BBS and file transfer.

## How it was checked

`test/vara.test.js` checks the formats against hfmodem's descriptions, and
runs two PiRO stations through a simulated channel using them, including a
QSY from the calling frequency to a slot. The beacon and VMail-notice
decoders are checked with frames PiRO's modem decoded from KiwiSDR
recordings of 14.105 MHz (2026-10-28): beacons from DL4QB, OH8XAT, OZ9EEE
and DH7LK, and OH8XAT's VMail notice to HB9FIH. Later recordings that day
added N4SDN, K5CG and R9SFG's beacons, OE5RPP's broadcast to ALL, and a
whole QSY: DL4QB, called on 14.105, sent `<Q>`; the caller's request
followed; on the slot 750 Hz down DL4QB sent `<QSYR>` and then
`de DL4QB <R-16> <S:VEAB>`. That is hfmodem's sequence, and PiRO's. The
QSY requests heard were all `<Q:n>` (`<Q:225>`, `<Q:-375>`, `<Q:75>`),
so PiRO sends that form. Not yet tested with VarAC itself, and not tested
on air.
