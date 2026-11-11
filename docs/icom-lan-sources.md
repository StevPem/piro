# Icom LAN sources

The network packet builders and credential substitution table adapt
[AetherSDR](https://github.com/aethersdr/AetherSDR/tree/e8548d7ed5a410f0d4b7faf94a7b5e932d64104f)
at `e8548d7ed5a410f0d4b7faf94a7b5e932d64104f`, especially
`src/core/backends/icom/IcomProtocol.{h,cpp}`, `IcomSession.cpp`,
`IcomStream.cpp` and `IcomAudio.{h,cpp}`. Credit: AetherSDR contributors.
AetherSDR also credits nonoo/kappanhang for the transport grounding and wfview
for protocol field evidence.

[wfview](https://github.com/wf-group/wfview/tree/098568546731aff25c7e9ea93c0f009eeee19137)
at `098568546731aff25c7e9ea93c0f009eeee19137` provides a second reference:
`include/packettypes.h`, the `icomudp*` headers/sources and
`rigs/IC-7300MK2.rig`. Its Icom UDP sources credit Phil Taylor M0VSE and
Kappanhang authors HA2NON, ES1AKOS and W6EL.

The Icom LAN server (`src/server/icom-lan-server.js`) follows wfview's
network server at the same revision: `src/radio/icomserver.cpp` (the order
of a session, the login, token, capabilities, connection and status
packets, retransmits) and `include/packettypes.h` (the layouts), with the
audio codec numbers from `include/audioconverter.h`. The code is written
for PiRO and carries the GPL notice.

These references are GPLv3; the adapted primitives retain their GPL notice and
the [license text](../third_party/icom-lan/GPL-3.0.txt). PiRO remains
AGPL-3.0-only. The reference applications are not runtime dependencies.

Official model documentation:

- [IC-7300MK2 CI-V Reference Guide](https://www.icomjapan.com/support/manual/4486/):
  page 7, timeout parameter `0032`, values `00..05`;
  page 9, LAN AF/SQL/modulation parameters `0079`, `0080`, `0083..0085`;
  page 24, one-division LAN scope waveform and 475 samples.
- [Basic Manual](https://www.icomjapan.com/support/manual/4459/): page 52,
  CI-V timeout OFF/3/5/10/20/30 minutes and its documented coverage; pages
  59–60, Network Control, UDP ports and network users.

The tests use literal wire expectations and a separately encoded localhost
peer. They establish software contracts, not interoperability with every
firmware revision or radio-side stop timing during physical link failure.
