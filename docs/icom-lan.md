# IC-7300MK2 native LAN

PiRO can use the IC-7300MK2's native Icom UDP protocol for CI-V control,
48 kHz mono receive/transmit PCM and the radio's spectrum scope. USB remains
the default. No virtual serial/audio device or separate radio application is
required. Other radio models are rejected before model-specific settings are
changed.

## Setup

1. Enable **Network Control** on the radio and configure a network user with
   control permission. The radio requires an 8–16 character network password.
2. Enable the radio's **CI-V time-out**. OFF is its default. The available
   limits are 3, 5, 10, 20 and 30 minutes; select a finite limit suitable for
   your operation. PiRO reads this setting but never changes it automatically.
3. Add these settings to PiRO's environment (for systemd,
   `/etc/piro/piro.env`), using the radio's IP, not the Pi's:

   ```ini
   CIV_CONNECTION=lan
   ICOM_LAN_HOST=192.168.1.100
   ICOM_LAN_USERNAME=your-user
   ICOM_LAN_PASSWORD=your-password
   CIV_SCOPE_ENABLED=true
   ```

   Keep the credentials in a private environment file, outside the repository.
   Existing USB audio device settings are ignored in LAN mode. Native audio
   requires `AUDIO_SAMPLE_RATE=48000` and `AUDIO_CHANNELS=1` if explicitly set.
4. Restart PiRO: `sudo systemctl restart piro`.

Optional settings:

| Variable | Default | Purpose |
|---|---|---|
| `ICOM_LAN_CONTROL_PORT` | `50001` | Radio control UDP port |
| `ICOM_LAN_CIV_PORT` | `50002` | CI-V UDP port |
| `ICOM_LAN_AUDIO_PORT` | `50003` | Audio UDP port |
| `ICOM_LAN_BIND_ADDRESS` | automatic | Local interface address on a multihomed Pi |
| `ICOM_LAN_TIMEOUT_MS` | `15000` | Session/stream liveness timeout |
| `ICOM_LAN_JITTER_MS` | `60` | RX audio prebuffer, 20–200 ms |
| `ICOM_LAN_MOD_LEVEL` | unchanged | Optional LAN modulation level, 0–255 |
| `CIV_RADIO_ADDR` | advertised, then verified | Optional hexadecimal CI-V address override |

The adapter verifies the actual model identity, selects LAN AF audio and the
appropriate LAN modulation source, and restores settings on orderly shutdown
where the link remains usable. USB DTR/RTS keying is unavailable over LAN;
the existing paddle uses CI-V PTT. Existing upstream reverse-CW mode limits
still apply.

## Link loss and transmit safety

Loss of the control/media association, token expiry or a CI-V reply timeout
closes the connection and runs PiRO's existing shutdown path with a non-zero
exit. `Restart=on-failure` in the supplied systemd unit starts a fresh process.
There is no in-place reconnect, connection menu, idle timer or saved connection
state in this implementation. Unattended WSPR follows upstream behavior.

The CI-V time-out setting (`1A 05 00 32`) is checked at startup and before
native transmissions. OFF, an invalid value or a rejected read allows RX but
disables software-initiated TX. Every current/new browser receives the existing
rig-error warning. PTT-off, CW stop and tuner stop remain available. A wire
timeout follows the link-loss exit policy instead of assuming the radio is safe.

An unreachable radio cannot be unkeyed over LAN. Process restart does not
replace the radio-side timeout, whose minimum enabled value is three minutes.
Icom documents its coverage for CI-V-initiated TX and the front TRANSMIT
button; do not assume it covers every VOX, break-in, keyer or external-key path.
Verify the intended failure behavior with a suitable dummy load before remote
transmission.

## Tests

`npm run test:lan` exercises the independent localhost UDP peer, strict timeout
decoding/TX gating, playback tail/abort behavior, warnings to multiple browsers,
and process exit/restart on link loss. These tests do not emit RF. `npm run
test:ci` also runs the upstream USB and modem suites. Tests of shared transmit
bridges remain upstream's, and their implementation is unchanged by this PR.

Process lifecycle tests wait for the real optional CW model's startup to settle
using test-only telemetry. The separate upstream [DeepCW close-during-load
crash](https://github.com/VK3TR/piro/issues/81) can interrupt the shared shutdown
path; this LAN patch does not fix it or change decoder code.

The native protocol/audio path was exercised previously on an IC-7300MK2;
that earlier full-featured fork is not a hardware certification of this smaller
integration or of network-failure RF stop timing. Source references and license
information are in [protocol sources](icom-lan-sources.md).
