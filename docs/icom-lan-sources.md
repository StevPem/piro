# Icom LAN protocol evidence

Research date: 2026-10-30. Target: IC-7300MK2. No physical radio or on-air
test was used. The localhost peer and all packet fixtures are synthetic.

## Official model documentation

Downloaded from Icom's product support links, extracted with Poppler, and
visually checked the CI-V routing table (printed page 9). Manuals remain
outside the repository; they are not redistributed.

- [IC-7300MK2 product/support](https://www.icomjapan.com/lineup/products/IC-7300MK2/).
- [CI-V Reference Guide, IC-7300MK2_ENG_CI-V_0](https://www.icomjapan.com/support/manual/4486/):
  page 9: SET identifiers 0079 (LAN AF/IF select), 0080 (LAN AF SQL),
  0083 (LAN MOD level), 0084 (DATA OFF MOD), 0085 (DATA MOD). Source 05
  is LAN. Level values are two BCD bytes, 0000 through 0255.
  Page 24: waveform data over LAN is one division, with a 15-byte
  first-division header and 475 samples; the out-of-range flag is present
  in Center mode too. The transport CI-V payload length must be a u16.
  Page 7: CI-V time-out setting 0032; its coverage is limited to the
  transmission initiators described by Icom.
- [Basic Manual, IC-7300MK2_ENG_Basic_2c](https://www.icomjapan.com/support/manual/4459/):
  page 52: CI-V timeout choices OFF/3/5/10/20/30 minutes, valid for
  CI-V-initiated TX and TRANSMIT-button TX. Page 59: Network Control
  and three UDP ports (50001, 50002, 50003). Page 60: Network User1/2,
  8-16 character password requirement, administrator role.
- [Advanced Manual, IC-7300MK2_ENG_Advanced_0](https://www.icomjapan.com/support/manual/4487/):
  cross-checked connection/audio context and preset behavior. The Basic
  Manual contains the Network and SET menu instructions.

SHA-256 of downloaded PDFs:

| Document | SHA-256 |
|---|---|
| CI-V | `e2ec76926a4738b38f5e69a9cb0b124ab1cf974a82c2b89852eaf880017ad1e1` |
| Basic | `89792515b29b07c61383f88779d21cb9fef1da5314ddd60d1b7fd43b5caa907b` |
| Advanced | `58d69c271a7307ebc5d42d2dc78ed0700721c90f2541ea02a49aac99481d9a78` |

## Network implementation references

Icom's CI-V manual documents the inner commands, not the complete RS-BA1
wire transport. These open-source implementations provide that evidence:

- [AetherSDR](https://github.com/aethersdr/AetherSDR/tree/e8548d7ed5a410f0d4b7faf94a7b5e932d64104f),
  commit `e8548d7ed5a410f0d4b7faf94a7b5e932d64104f`.
  `src/core/backends/icom/IcomProtocol.{h,cpp}` supplies field layouts,
  credential substitution, endian choices and packet shapes.
  `IcomStream.cpp` explains tracked sequence 1 at startup, wrapping FIFO
  replay, single-sequence retransmit requests, ping stamp echoing and
  no periodic idle packets on the audio stream.
  `IcomSession.cpp` explains first-auth plus token request, early renewal
  after reconnect, matching renewal replies and late teardown statuses.
  `IcomAudio.{h,cpp}` supplies codec 4 (LPCM mono S16LE) and the
  1920-byte/20-ms frame split into 1364 and 556 payload bytes.
  `IcomModels.cpp`, `IcomSettings.cpp` and `IcomScope.cpp` cross-check MK2
  identity, LAN input choice and scope geometry.
  Tests inspected include protocol, session lease, scheduler, audio and scope.
- [wfview](https://github.com/wf-group/wfview/tree/098568546731aff25c7e9ea93c0f009eeee19137),
  commit `098568546731aff25c7e9ea93c0f009eeee19137`.
  `include/packettypes.h`, `include/icomudp*.h`,
  `src/radio/icomudpbase.cpp`, `icomudphandler.cpp`,
  `icomudpcivdata.cpp`, `icomudpaudio.cpp`, and `rigs/IC-7300MK2.rig`.
  These cross-check authentication, token fields, serial open/retry,
  payload lengths and model-specific menu numbers.

The wire builders in `src/icom-lan/protocol.js` adapt AetherSDR protocol
primitives. Credit: AetherSDR contributors. AetherSDR credits nonoo/kappanhang
for its transport grounding and wfview for field layout evidence. wfview's
Icom UDP sources credit Phil Taylor M0VSE and Kappanhang authors HA2NON,
ES1AKOS and W6EL. Keep this provenance when moving or adapting the code.
Both reference repositories distribute their source under GPLv3. The GPLv3
text is included in `third_party/icom-lan/GPL-3.0.txt`; PiRO retains its
AGPL-3.0-only project license. No reference application is a runtime dependency.

## Resolved differences and conservative choices

- Inner control sequence is **BE u16 at 0x16**, not a shifted LE value
  at 0x17. AetherSDR records MK2 rejection at 255-to-256 with the shifted
  encoding; wfview's struct agrees with the BE field. Literal byte tests
  cover 256 and socket tests cover 255, 256, 65535 and 0.
- Serial payload length is **LE u16 at 0x11**. An 8-bit interpretation
  loses LAN spectrum sweeps. Tests use a full 475-sample scope packet.
- Single-sequence retransmission requests are used. The multi-range
  transmit form remains unverified in the references; received complete
  ranges are parsed with a strict per-request work budget.
- Session IDs are opaque random BE tokens. Compare both sender and receiver
  on every packet, including pings and grants, and use fresh sockets/IDs
  after reconnect. Do not trust the network nickname as a model ID.
- Control notifications are dispatched directly, as in both reference
  clients, and correlated/deduplicated by their inner request/session fields.
  Only media streams use ordered outer-sequence delivery. Tests also cover
  control peers that reuse outer sequence zero.
- Only **codec 4 at 48000 Hz mono** is negotiated. Audio already matches
  PiRO's PCM format, so no radio-side resampler or gain conversion is
  needed. Other configured rates/channels/codecs are rejected, not silently
  reinterpreted. Browser audio compression remains a separate layer.
- All command replies are serialized because CI-V ACKs have no request ID.
  Stop commands go ahead of queued polling. A LAN command timeout resets
  the session and rejects pending commands rather than attributing a late
  ACK to a new command. A transport reconnect never replays old commands.

## Independent verification and limits

`test/fixtures/icom-lan-peer.js` writes its own packet fields and never
imports production protocol builders. `test/icom-lan-protocol.test.js`
contains literal expected bytes, including the independently published
`beer` credential vector from AetherSDR's `testPasscode`. Four-character
fixture credentials are synthetic; real MK2 passwords must satisfy the
radio's documented 8-16 character rule.

Passing offline tests proves the tested code paths and the stated byte
contracts. It does not prove RF output, firmware timing, audio latency on
a real link, real radio buffer drain behavior, firewall traversal, or
interoperability with every firmware revision. Refer to the hardware
acceptance checklist before treating LAN transmission as validated.
