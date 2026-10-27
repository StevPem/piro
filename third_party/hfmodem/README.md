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

PiRO also uses hfmodem's findings that VarAC waits on its slot about
2 minutes after a CQ (`SLOT_WAIT_S`), that profile tags follow the opening
report (`<NAME:…>`, `<QTH:…>`, `<LOC:…>`), and that `<DISC>` comes before
the link is closed.

Not ported yet: calling CQ on a slot, the QSY handshake in a QSO
(`<QSYF>`, `<TL>`, `<QSYR>`), beacons, VMail, file transfer.

## How it was checked

`test/vara.test.js` checks the formats against hfmodem's descriptions, and
runs two PiRO stations through a simulated channel using them. Not yet
tested with VarAC itself, and not tested on air.
