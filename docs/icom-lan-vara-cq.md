# VARA CQ release on native LAN (v140)

[Issue #1](https://github.com/s53zo/piro/issues/1) tracks the receive-waterfall
report after a VARA/VarAC CQ. The confirmed release defect is specific to the
fork's native LAN playback path; original upstream VARA does not drain it.

The VARA worker produces an output block for every RX input, including silence
after the CQ. Waiting for an empty playback queue can therefore keep PTT on
until the 30-second VARA watchdog. `LanPlayback.drain()` now captures the audio
already queued at release, waits for that watermark and the radio buffer tail,
and ignores future silence. Queue flushes still cancel the drain.

A second race could clear the local key latch/watchdog when PTT-off arrived
before LAN PTT-on preparation completed. Normal release now awaits pending
key preparation. Immediate abort can still cancel it promptly, and old-session
completion cannot release a new radio association.

## Evidence

- A deterministic continuous-silence regression failed before the drain change
  and passes afterward. The remaining six audio tests cover bounded queues,
  padding, cancellation, paced sample preservation and asynchronous keying.
- Four pending-key regressions cover release, deactivation, key failure and
  session replacement. The release/deactivation cases use the real LAN driver,
  playback and localhost UDP peer with a delayed CI-V response.
- Normal PiRO startup, Chrome and the real Xara modem against localhost IcomPeer:
  before the fix, CQ held PTT for **29,997 ms**, until the watchdog. With the
  playback fix it released after **6,268 ms**, returned to `listening`, and
  delivered **336 PCM / 33 scope frames** afterward. The waterfall canvas
  contained pixels. No physical RF was used in these reproductions.
- Integration fixture teardown now allows ten seconds to observe the server's
  existing eight-second shutdown deadline; the old six-second fixture budget
  caused teardown failures even when the functional assertions passed.
- Target-platform verification: the full run passed 64/65 groups, with the LAN
  group failing on process shutdown observation. After correcting both shutdown
  wait budgets, the complete LAN group passed **163/163** checks in a serial
  rerun. Three instrumented server runs also passed: JavaScript shutdown and
  worker termination completed within 23–37 ms, while process exit could take
  additional time in uninterruptible kernel I/O. The exact kernel cause was
  not established; the Pi uses an NFS root filesystem.
- Deployed v140 receive check: PTT off, authenticated IC-7300MK2 connected,
  **174 PCM frames and 105 scope frames** in 3.5 seconds. Station identity,
  locator and the 60-minute idle preference were retained.

Physical post-fix CQ transmission has not been tested. The initial physical
report and later receive-stream checks do not by themselves prove that every
waterfall interruption has this cause.
