# IC-7300MK2 over Ethernet

PiRO can use the MK2's built-in LAN interface for CI-V control, typed CW,
scope, receive audio and transmit audio. This implementation is verified
against an independent localhost peer and reference wire contracts. Physical
IC-7300MK2 LAN receive, controls and brief operator-authorized dummy-load
transmit checks were also performed. See the [hardware validation record](icom-lan-hardware-validation.md)
for exact observations, restoration checks and remaining RF/failure/soak tests.

The connection is browser ↔ PiRO server ↔ radio Ethernet. PiRO still runs
on a computer. LAN mode needs no USB cable, ALSA device, virtual serial
port, virtual sound card, RS-BA1 installation or other radio application.
The existing USB connection remains the default.

## Radio setup

Use the IC-7300MK2 Basic Manual, Network pages 59-60:

1. Connect Ethernet and note the radio's address under SET > Network.
   A DHCP reservation makes subsequent connections easier.
2. Under SET > Network > Remote Settings, enable Network Control.
   Create a Network User1 or User2 ID and password. The radio requires an
   8-16 character password. Restart when the radio marks a changed setting
   as requiring a restart.
3. Match the configured control, serial and audio UDP ports to PiRO.
   Defaults are 50001, 50002 and 50003; custom ports can be independent.
4. Enable CI-V Transceive for front-panel frequency/mode updates. Keep
   other remote clients disconnected while validating PiRO.
5. Review SET > Function > Time-Out Timer (CI-V), described on page 52.
   It defaults to OFF. Icom documents its coverage for CI-V-initiated TX
   and the TRANSMIT button; do not assume it covers every CW/break-in case.

PiRO uses the LAN session's advertised CI-V address for the identity request,
then verifies the model using CI-V rather than trusting the network nickname.
An explicit `CIV_RADIO_ADDR` overrides the advertised address. Only the MK2 is enabled for native LAN operation in this
version. Other Icoms are rejected before model-specific settings are written.

## Run PiRO

Install the existing project dependencies, then configure the server. For
example, put these values in a private service environment file:

```sh
CIV_CONNECTION=lan
ICOM_LAN_HOST=192.168.1.100
ICOM_LAN_USERNAME=your-radio-user
ICOM_LAN_PASSWORD=your-radio-password
ICOM_LAN_CONTROL_PORT=50001
ICOM_LAN_CIV_PORT=50002
ICOM_LAN_AUDIO_PORT=50003
CIV_SCOPE_ENABLED=1
SOURCE_CODE_URL=https://github.com/s53zo/piro/tree/feat/icom-lan
```

These are environment-file assignments, not an exported shell script.
Load them through your service manager, or export them in the launching
shell, then run `npm start`. Password values must follow the radio's actual
length/character rules; the placeholder above must be replaced.

For an interactive shell, use `read -rs ICOM_LAN_PASSWORD` and export the
variable rather than putting the password into shell history. Credentials
stay on the server. They are not included in browser snapshots or logs.
Icom's credential encoding is reversible obfuscation, not encryption.
Keep the existing PiRO firewall/VPN boundary when operating remotely.

Do not set `AUDIO_RX_DEVICE` or `AUDIO_TX_DEVICE` for LAN. Network audio is
always mono S16LE at 48000 Hz, codec 4 on the radio connection. If set,
`AUDIO_SAMPLE_RATE` must be 48000 and `AUDIO_CHANNELS` must be 1. Browser
PCM/Opus/ADPCM choices are independent of the radio's negotiated format.

| Variable | Default | Meaning |
|---|---|---|
| `CIV_CONNECTION` | `usb` | `usb` or `lan`. |
| `ICOM_LAN_HOST` | required | Radio IPv4 address or resolving hostname. |
| `ICOM_LAN_USERNAME` | required | Radio network user ID. |
| `ICOM_LAN_PASSWORD` | required | Radio network password. |
| `ICOM_LAN_CONTROL_PORT` | `50001` | Radio control UDP port. |
| `ICOM_LAN_CIV_PORT` | `50002` | Radio serial/CI-V UDP port. |
| `ICOM_LAN_AUDIO_PORT` | `50003` | Radio audio UDP port. |
| `ICOM_LAN_BIND_ADDRESS` | `0.0.0.0` | Optional local IPv4 interface address. |
| `ICOM_LAN_TIMEOUT_MS` | `15000` | Inactive stream and startup deadline. |
| `ICOM_LAN_RECONNECT_ATTEMPTS` | `5` | Retry budget per connection loss; `0` disables retries. |
| `ICOM_LAN_JITTER_MS` | `60` | RX prebuffer, 20-200 ms. RX queue cap is 300 ms. |
| `ICOM_LAN_MOD_LEVEL` | unchanged | Optional LAN modulation level, 0-255. Restored after TX where reachable. |
| `CIV_RADIO_ADDR` | auto | Optional hexadecimal target address, for example `B6` or `0xB6`. Identity is still checked. Also supported over USB. |

The three radio ports must be distinct. Local media sockets use ephemeral
ports and advertise their actual bound ports in the authenticated request.
This version targets IPv4 and an ordinary LAN/VPN path; routed/NAT behavior
still needs physical validation.

## Connect and disconnect from the browser

Open **Radio connected** beside **Connected (1)** in the top-right header.
Choose **Disconnect** to release the radio, or **Connect** to use the configured
radio again. The browser remains connected to PiRO, so the page, speaker
setting and operator notes remain available.

This is one shared radio connection: a change from any browser is reflected
in every other browser. While disconnected or changing connection, tuning,
radio settings and transmit controls are disabled. Disconnect stops local
transmit work, attempts CW/PTT release and restores saved routing settings
while the radio is reachable, then releases the LAN streams and cancels
retrying. Connect starts a fresh authenticated session and restores receive
audio and scope; queued transmissions are never resumed.

A deliberate disconnect pauses automatic reconnect until Connect is selected.
This choice lasts for the running server process; normal automatic connection
at server startup is unchanged. The manager is available for native LAN;
USB behavior is unchanged. Radio address, credentials and ports remain in
the private server configuration rather than the browser.

The browser RPC is `setRadioConnected` with `{connected: boolean}`. It
acknowledges the requested operation immediately; `radio-connection` events
and fresh-client snapshots carry the resulting state, `managed` capability
and `manual` flag. Errors and connection progress appear in the dropdown.

## What happens during operation

The header shows radio connection status separately from browser connection
status. Status events and new-client snapshots include `radioConnection`
without credentials. A failed initial connection reports an error after the
configured retry budget; restart the service after fixing settings. An
established link retries at 1, 2, 4, 8 and 10 seconds by default.
The budget resets only after CI-V initialization succeeds, not just when
UDP streams open. Reconnect reads current frequency, mode and DATA state
and updates the existing browsers and decoder listeners.
Front-panel updates received during these reads remain current; readiness
does not replay an older tuning snapshot.

The last browser's departure cancels queued FT8/text/CW transmission and
releases browser-driven PTT. WSPR's existing explicitly configured unattended
receive behavior remains available; a network loss disables pending WSPR TX.
Radio loss also disables VARA in the shared app state. After reconnect,
select VARA again to restart the modem; it does not resume a prior call.

The transport uses fresh sockets and session IDs on reconnect. It rejects
old-session packets and pending CI-V jobs. Reconnect never resumes CW, PTT
or buffered audio. It identifies the radio and confirms CW stop/PTT off
before accepting new transmissions. Routine polling cannot get ahead of a
queued PTT-off or CW-stop command; the current CI-V transaction is allowed
to finish because CI-V ACKs have no transaction IDs. A LAN command timeout
resets the association to avoid attributing a late ACK to a new request.

Session tokens receive an initial renewal after 30 seconds, then renew every
60 seconds. Missing replies are retried after 3 seconds; an 80-second
unacknowledged lease fails the session. These are reference-derived defaults,
not measured MK2 timing guarantees.

On connect, PiRO selects LAN AF output and open AF squelch, preserving the
previous values for best-effort restoration on controlled shutdown. It does
not apply the original IC-7300's USB-level startup commands. Before audio
TX, PiRO selects and confirms LAN in DATA OFF MOD or DATA MOD according to
the current data-mode state. It restores changed TX settings after release
if the operator has not changed them meanwhile. Abrupt network loss can
prevent restoration; verify radio settings after a failed session.
Recoverable restoration errors leave saved settings available for retry.
A confirmed PTT-off is reported independently from any restoration error.
If the connection disappears during that restoration, the request fails
and PTT remains unknown. A newer operator source or level selection becomes
the baseline for the next transmission. Failed initial and reconnect setup
both attempt RX rollback before closing a reachable, verified radio.

Receive audio feeds the existing raw capture stream, including CW/digital
decoders. The receive buffer drops old backlog above 300 ms and inserts
silence for underflow after it has started. Audio processing selected by the
browser is downstream of the raw decoder feed.
The RX clock catches up after coalesced callbacks while samples still fit
in the buffer, preserving the decoder's 48-kHz sample stream.

Transmit audio is paced as 20-ms frames, split into 1364- and 556-byte
payloads. Voice backlog is capped at 500 ms. A finite modem waveform is
preserved up to nine minutes; longer queues fail explicitly. Normal finite
TX completion drains PiRO's queue and allows for the negotiated 300-ms radio
buffer before PTT release. Stop/disconnect discards pending audio and
invalidates retained audio/keying packets. No audio resampler is needed
between the radio and PiRO because their PCM format matches exactly.
Partial native-pipe chunks accumulate without padding. Only final drain
pads an incomplete tail. Malformed browser PCM is rejected with an audio
error and a release request rather than an uncaught process exception.

Audio produced while a PTT request is still preparing its route waits in a
bounded pre-key queue. It cannot be sent until the radio confirms PTT, and
is discarded if preparation is cancelled. Radio key/release transitions are
serialized so one transmission's restored source cannot overwrite the next
transmission's LAN routing.
Reconnect initialization uses the same queue, so it cannot overlap another
settings restoration. Confirmed external PTT-off also clears VARA's local
key latch if it interrupts a drain; the next modem burst can key normally.

If the link disappears during TX, the radio's actual state is unknown.
PiRO can stop local producers and attempt cleanup but cannot make an
unreachable radio stop. Use the radio-side timeout where applicable and
verify failure behavior on a dummy load before remote operation.

## Offline commands

```sh
npm run test:lan
npm test
npm run demo:lan
```

The demo starts normal PiRO against a synthetic radio on localhost, prints
a browser URL, and supplies a 600-Hz test tone and scope trace. It uses no
physical radio and makes no RF transmission. Ctrl-C stops both processes.
It uses intentionally simplified fixture credentials, not a real MK2 setup.

Tests cover byte contracts, independent socket negotiation, rejected login,
identity, renewal/expiry, rollover, packet faults, stale ACKs, bounded queues,
CW and abort, scope, PCM sample values, TX pacing, routing/restoration,
reconnect and normal-process browser-protocol integration. See
[source evidence](icom-lan-sources.md) for independent vectors and provenance.

## Hardware acceptance checklist

Keep the radio on a dummy load for initial transmit and failure checks.
Record radio firmware, PiRO commit, settings and observed results.

- [ ] Confirm login with real credentials, identity, custom CI-V address,
  configured ports, wrong-password error and a clean immediate reconnect.
- [ ] Read/set frequency, mode, filter and meters. Check that front-panel
  changes update all browsers and both USB/default behavior and LAN status
  still work as intended.
- [ ] Confirm a 475-point scope trace, Center/Fixed/Scroll modes and span
  changes with no misplaced flag byte or corrupted sweep.
- [ ] Listen to RX speech and tones. Measure sample rate, amplitude, latency
  and clipping. Confirm CW and digital decoders use raw receive audio.
- [ ] Send short CW at several speeds. Check break-in, WPM restoration,
  buffer-full handling, Stop and last-browser departure. Verify whether the
  radio's configured timeout covers this keyer path.
- [ ] Verify voice PTT, DATA OFF MOD=LAN, configured LAN modulation level,
  receive recovery, audio tail and restoration of the original setting.
- [ ] Verify FT8/FT4, WSPR, text, picture and FreeDV TX routes, DATA MOD=LAN,
  signal continuity, timing, final symbols and Stop. Confirm actual RF power
  and successful decoding using an independent receiver.
- [ ] Run a receive session longer than two hours to cover token sequence
  255→256; inspect renewals, memory use and audio continuity. Test sustained
  TX audio sequence wrapping with appropriate local test arrangements.
- [ ] During CW and audio TX, disconnect Ethernet, stop the server and close
  the last browser separately. Measure the radio's stop behavior and timeout.
  Restore the network; confirm no queued transmission resumes.
- [ ] Exercise packet delay/loss on a test path, stream release by the radio,
  radio restart, bad ports and a VPN path. Confirm bounded reconnect and
  understandable status without stale or falsely confirmed PTT state.
