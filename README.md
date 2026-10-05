# PiRO

PiRO is a web app for remote control of an Icom transceiver. It runs as one
Node.js service on a Raspberry Pi (or any small Linux machine) that is
connected to the radio by USB. You open it in a browser on your network and
get frequency, mode and PTT control, RX/TX audio, a spectrum scope and
waterfall, and a set of digital-mode and noise-reduction tools. It needs no
Hamlib, no separate audio server and no extra apps. It is loosely modelled on
RigPi, and installs to a phone's home screen as a PWA.

Written by VK3TR. Licensed AGPL-3.0-only (see
[Licence](#licence)).

## Credits
Several of the cooler features in this app are built on the work of others:
- FreeDV support = https://github.com/freedv/rade_c
- FT8/FT4 support = https://github.com/e04/ft8ts
- CW 2 decoder = https://github.com/dawsonjon/HamFist
- CW 3 decoder = https://github.com/e04/web-deep-cw-decoder
- HamNoise denser = https://github.com/e04/HamNoise
- RNnoise denoiser = https://jmvalin.ca/demo/rnnoise/

## Features

- **Rig control** over CI-V: frequency, mode, band, filter, PTT, TX power,
  S-meter, SWR and more.
- **Audio** both ways in the browser, using the radio's built-in USB sound
  codec through ALSA.
- **Spectrum scope and waterfall** from the radio's CI-V scope data (opt-in).
- **CW decoders**, including "CW 3" (DeepCW, a neural decoder) and an RTTY decoder.
- **FT8**: band-activity decoding, manual TX, and a guided QSO sequence that
  suggests each reply (you still send every message yourself). Optional PSK
  Reporter spotting.
- **FreeDV RADE** digital voice, with optional reporting to the
  [FreeDV Reporter](https://qso.freedv.org) map.
- **Two noise reducers for received audio**: "RNN" (RNNoise) and "HamNoise"
  (a neural denoiser trained on HF signals).

PiRO is made for Icom radios with a USB CI-V port and USB audio codec. The
CI-V address table covers the IC-7300, IC-7610, IC-9700, IC-705, IC-7100,
IC-7850 and IC-7851, and `IC-7300` is the default model. Spectrum-scope
behaviour varies by radio and firmware (see `docs/civ-notes.md`).

## Contents

1. [What you need](#what-you-need)
2. [Installing PiRO](#installing-piro)
3. [Optional components](#optional-components) (RNNoise, HamNoise, DeepCW, FreeDV RADE)
4. [Running PiRO as a systemd service](#running-piro-as-a-systemd-service)
5. [Configuration reference](#configuration-reference)
6. [Updating](#updating)
7. [Troubleshooting](#troubleshooting)
8. [Hardware diagnostics](#hardware-diagnostics)
9. [Project layout](#project-layout) and the rest of the developer reference
10. [Licence](#licence)

## What you need

| | |
|---|---|
| Computer | A Raspberry Pi 3, 4, 5 or Zero 2 W, or any Linux machine. Use a **64-bit** OS: the CW 3 decoder needs `onnxruntime-node`, which has no 32-bit ARM build. |
| OS | Raspberry Pi OS or Debian 12 "Bookworm" or newer. Other distributions work if you adjust the package names. |
| Node.js | 18 or newer. 20 or 22 is recommended. |
| Radio | An Icom transceiver connected by USB. The one cable gives a CI-V serial port and, on most models, a USB audio codec. |
| System packages | `alsa-utils` (audio), `git`. `build-essential` and `python3` are only needed if `npm install` has to compile the serial-port module itself. |
| Accurate clock | FT8 works in UTC 15-second slots, so the clock must be right. Raspberry Pi OS runs `systemd-timesyncd` by default. A Pi has no battery clock, so it needs the network at boot. |

## Installing PiRO

These steps take a fresh Raspberry Pi OS or Debian install as far as the app
running in a browser. `docs/install-debian.md` has the same steps with more
explanation.

**1. Update the system and install the packages.**

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git alsa-utils build-essential python3
```

**2. Install Node.js 18 or newer.** Debian's own package is often too old.
NodeSource gives a current version on both ARM and x86:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # must print v18 or higher
```

**3. Get PiRO and install its Node dependencies.**

```bash
git clone https://github.com/YOUR-USER/PiRO.git ~/PiRO
cd ~/PiRO
npm install
npm test            # optional: runs the unit tests, no radio needed
```

**4. Let your user open the serial port and audio device.** Log out and back
in afterwards. (The systemd service in the next section does not need this,
because it adds the groups itself. You need it to run PiRO by hand.)

```bash
sudo usermod -a -G dialout,audio $USER
```

**5. Set up the radio.** In the radio's menu:

- Note the **CI-V USB Baud Rate**. PiRO's `CIV_BAUD_RATE` must match it. The
  default is 19200. Scope use usually needs 115200.
- Turn **CI-V Transceive** ON.
- Note the **CI-V Address** (0x94 is the IC-7300 factory default).

**6. Connect the radio and find its devices.**

```bash
ls /dev/ttyUSB* /dev/ttyACM*     # CI-V serial port, usually /dev/ttyUSB0
arecord -l                       # the radio's USB audio codec, e.g. "card 1: CODEC"
```

The audio device name for PiRO is `plughw:<card name>,0`, for example
`plughw:CODEC,0`.

**7. Start it.**

```bash
CIV_SERIAL_PATH=/dev/ttyUSB0 \
CIV_RADIO_MODEL=IC-7300 \
CIV_BAUD_RATE=19200 \
AUDIO_RX_DEVICE=plughw:CODEC,0 \
npm start
```

**8. Open `http://<pi-hostname-or-ip>:8080`** in a browser on the same
network. You should see the frequency display filled in and the status light
showing "Connected". Press Ctrl+C to stop it, then continue to
[Running PiRO as a systemd service](#running-piro-as-a-systemd-service) to
make it start at boot.

Leave out `AUDIO_RX_DEVICE` if you only want CI-V control. Audio, and the
decoders that use it, are then switched off.

**Microphone access from other devices.** Browsers only allow the microphone
on HTTPS pages (or `localhost`). To transmit from a phone or laptop, serve
PiRO over HTTPS with `TLS_CERT_PATH` and `TLS_KEY_PATH`. For a quick
self-signed certificate:

```bash
sudo mkdir -p /etc/piro
sudo openssl req -x509 -newkey rsa:2048 -keyout /etc/piro/key.pem -out /etc/piro/cert.pem \
  -days 825 -nodes -subj "/CN=$(hostname).local"
sudo chown $USER /etc/piro/key.pem /etc/piro/cert.pem && sudo chmod 600 /etc/piro/key.pem   # the service runs as you
```

Browsers show a warning for self-signed certificates the first time. See
`docs/pwa-notes.md` for alternatives (mkcert, a reverse proxy) and for
installing PiRO to a home screen.

## Optional components

PiRO works with just the steps above. Each feature in this section needs
something extra, and each one switches itself off cleanly (the button does
nothing and an error is shown) if its part is missing.

| Feature | What it needs | Where |
|---|---|---|
| CW decoders, RTTY, FT8, scope, "HamNoise" button | Nothing extra: they are bundled and installed by `npm install` | |
| "CW 3" decoder (DeepCW) | The bundled model and `onnxruntime-node` (installed by `npm install`) | [DeepCW](#deepcw-cw-3-decoder) |
| "RNN" button | A patched `rnnoise_demo` that you build | [RNNoise](#rnnoise-rnn-button) |
| FreeDV RADE mode | `rade_c` built and installed | [FreeDV RADE](#freedv-rade) |

### RNNoise ("RNN" button)

[RNNoise](https://github.com/xiph/rnnoise) is a small neural network that
removes noise from speech. PiRO runs RNNoise's example program,
`rnnoise_demo`, as a background process and sends the received audio through
it. It is not installed by `npm install`, and **PiRO needs a modified copy of
`rnnoise_demo`**.

**Why it is modified.** Stock `rnnoise_demo` always writes fully denoised
audio. On weak HF signals that tends to mute the signal along with the noise.
The patched copy in [`third_party/rnnoise/rnnoise_demo.c`](third_party/rnnoise/rnnoise_demo.c)
takes an optional third argument, `wet`, and writes
`wet × denoised + (1 − wet) × original`. PiRO's "RNN" button steps through
several `wet` levels (by default 25%, 50%, 75% and 100%), so you can choose how
hard to filter. With `wet` left out the patched program behaves exactly like
stock RNNoise. PiRO always passes `wet`, so an unpatched build will not work.

**Build and install it** (a Pi 4 takes a few minutes):

```bash
sudo apt install -y build-essential autoconf automake libtool pkg-config curl
git clone https://github.com/xiph/rnnoise.git ~/rnnoise
cd ~/rnnoise
cp ~/PiRO/third_party/rnnoise/rnnoise_demo.c examples/rnnoise_demo.c   # the patch
./autogen.sh          # this also downloads RNNoise's trained model
./configure
make
sudo install -m 755 examples/rnnoise_demo /usr/local/bin/rnnoise_demo
```

`autogen.sh` downloads the model file from the RNNoise project, so the Pi
needs internet access for that step. The patched file was written against
RNNoise's current example, which calls `rnnoise_create(NULL)` to use the built-in
model. If a future RNNoise release changes `examples/rnnoise_demo.c`
substantially, re-apply the small change by hand: add the optional `wet`
argument and the blend line shown in the patched file.

**Check it.** This should create `/tmp/out.raw`, the same size as the input
minus one frame, with no error:

```bash
head -c 960000 /dev/zero > /tmp/in.raw     # 10 s of silence, 48 kHz 16-bit mono
rnnoise_demo /tmp/in.raw /tmp/out.raw 0.5 && ls -l /tmp/out.raw
```

**Tell PiRO where it is.** If it is on the `PATH` (`/usr/local/bin` is, even
under systemd) you need nothing. Otherwise set `RNNOISE_BIN=/full/path`. To
change the blend levels set `RNNOISE_WET`, a comma-separated list such as
`RNNOISE_WET=0.3,0.6,1.0`. The number of values sets the number of button
levels.

RNNoise only changes the audio you hear in the browser. The CW, RTTY, FT8
and FreeDV decoders always read the raw audio. It requires
`AUDIO_RX_DEVICE`.

### HamNoise ("HamNoise" button)

[HamNoise](https://github.com/e04/HamNoise) is a neural denoiser trained on HF
signals, with separate CW and voice models. Its WebAssembly models are
bundled in `models/hamnoise/`, so there is nothing to install. PiRO picks the
CW or voice model to match the radio's mode. It is switched on with the
"HamNoise" button under "RNN", and the two are mutually exclusive.

HamNoise has two model generations. PiRO defaults to `classic`, which is light
enough for a Raspberry Pi. HamNoise's own newer `v2` models use roughly 36 to
53% of real time on a fast PC, and a Pi cannot keep up with them: the server
pins at 100% CPU. Set `HAMNOISE_QUALITY=v2` only on hardware that you have
tested.

In the author's testing, HamNoise helps on moderate signals (around S4 and up) where
RNNoise, which was trained on general speech noise rather than HF noise, is
more likely to mute them.

### DeepCW ("CW 3" decoder)

The model is bundled in `models/deepcw/` and runs in Node through
`onnxruntime-node`, which `npm install` fetches. It needs a 64-bit OS on a Pi.
If `onnxruntime-node` cannot load, only the "CW 3" decoder is unavailable. The
other CW decoders still work.

### FreeDV RADE

FreeDV mode needs the compiled tools from
[rade_c](https://github.com/freedv/rade_c): `radae_tx`, `radae_rx` and
`lpcnet_demo`, plus `librade.so`. Follow rade_c's own README to build it (it
uses CMake), then install the three programs and the shared library where
PiRO can find them:

```bash
cd ~/rade_c      # wherever you built it
find . \( -name radae_tx -o -name radae_rx -o -name lpcnet_demo -o -name 'librade.so*' \) -type f   # locate the build outputs
sudo install -m 755 <path>/radae_tx <path>/radae_rx <path>/lpcnet_demo /usr/local/bin/
sudo cp -a <path>/librade.so* /usr/local/lib/ && sudo ldconfig
```

PiRO finds the tools through the `PATH`, or through `RADE_TX_BIN`,
`RADE_RX_BIN` and `LPCNET_DEMO_BIN`. It also uses `stdbuf` from GNU coreutils,
which is already present on Debian and Raspberry Pi OS. `docs/ui-notes.md`
("The RADE codec bridge") describes the pipeline, and `RADE_TX_GAIN` (default
`4`) sets the TX drive. Adjust it by ear and by your radio's power meter or ALC
if the transmit level seems low or distorted. RADE is installed separately,
and nothing else in PiRO needs it.

## Running PiRO as a systemd service

A service starts PiRO at boot, restarts it if it stops, and keeps its log in
the journal. Two files in [`deploy/`](deploy/) do the work: `piro.service` (the
unit) and `piro.env.example` (all your settings).

**1. Put your settings in `/etc/piro/piro.env`.**

```bash
cd ~/PiRO
sudo install -D -m 644 deploy/piro.env.example /etc/piro/piro.env
sudo nano /etc/piro/piro.env      # set CIV_SERIAL_PATH, CIV_RADIO_MODEL, CIV_BAUD_RATE,
                                  # AUDIO_RX_DEVICE, STATION_CALLSIGN, ... and save
```

**2. Install the unit.** This fills in your username, the PiRO folder and the
path to Node:

```bash
sed -e "s|@USER@|$USER|" -e "s|@DIR@|$PWD|" -e "s|@NODE@|$(command -v node)|" \
  deploy/piro.service | sudo tee /etc/systemd/system/piro.service > /dev/null
```

The unit runs PiRO as your user, adds the `dialout` and `audio` groups for it,
and reads `/etc/piro/piro.env`.

**3. Enable and start it.**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now piro
systemctl status piro               # should say "active (running)"
journalctl -u piro -f               # live log; Ctrl+C to leave
```

**Everyday commands.**

```bash
sudo systemctl restart piro         # after editing /etc/piro/piro.env
sudo systemctl stop piro            # frees the serial port (only one program can hold it)
sudo systemctl disable piro         # stop it starting at boot
```

**Notes.**

- Only one program can use the CI-V serial port at a time. Stop the service
  before running a manual diagnostic script or another CAT program.
- Under systemd the `PATH` is minimal but includes `/usr/local/bin`, which is
  where the instructions above put `rnnoise_demo` and the RADE tools. If you
  installed them elsewhere, set `RNNOISE_BIN` and the `RADE_*_BIN` variables
  to full paths in `/etc/piro/piro.env`.
- USB devices can appear a moment after boot. If the radio is switched on
  later than the Pi, `Restart=on-failure` brings PiRO back up when it exits.
  For a device name that never changes, write a udev rule for the radio's
  serial number and point `CIV_SERIAL_PATH` at it.
- If you already run an older install under another unit name (for example
  `icom-rig-pwa`), keep using that name in the commands above, or disable it
  and install this one. Do not run two services on the same port.

## Configuration reference

All settings are environment variables. For the systemd service they go in
`/etc/piro/piro.env`. A line that is missing means the default shown.

| Variable | Default | What it does |
|---|---|---|
| `CIV_SERIAL_PATH` | `/dev/ttyUSB0` | The radio's CI-V serial port. |
| `CIV_RADIO_MODEL` | none | Radio model, such as `IC-7300`. Picks the CI-V address. |
| `CIV_BAUD_RATE` | `19200` | Must equal the radio's "CI-V USB Baud Rate" menu setting. |
| `CIV_SCOPE_ENABLED` | off | `true` turns on the spectrum scope and waterfall. |
| `CIV_MAXIMIZE_USB_LEVELS` | on | At start-up, sets the radio's USB audio levels to maximum. `0` or `false` leaves them alone. |
| `WS_PORT` | `8080` | Port for the web app and its WebSocket. |
| `AUDIO_RX_DEVICE` | none | ALSA capture device, such as `plughw:CODEC,0`. Audio and all decoders are off without it. |
| `AUDIO_TX_DEVICE` | same as RX | ALSA playback device for transmit audio. |
| `AUDIO_SAMPLE_RATE` | `48000` | Audio sample rate. |
| `AUDIO_CHANNELS` | `1` | Number of audio channels. |
| `AUDIO_CODEC` | `pcm` | `pcm` or `opus`. The shipped web app uses `pcm`. |
| `SCREEN_TITLE` | `SPARC PiRO` | Title shown in the browser tab and on the page. |
| `STATION_CALLSIGN`, `STATION_GRID` | none | Your callsign and Maidenhead grid. They set the FT8 default message and guided QSO, and the FreeDV Reporter report. |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | none | Set both to serve HTTPS and WSS. Needed for the microphone from other devices. |
| `SOURCE_CODE_URL` | none | Link shown in the page footer. The AGPL asks you to offer the source to people who use your instance (see [Licence](#licence)). |
| `STATIC_DIR` | `src/client` | Folder the web app is served from. |
| `RNNOISE_BIN` | `rnnoise_demo` | Path to the patched `rnnoise_demo`. |
| `RNNOISE_WET` | `0.25,0.5,0.75,1.0` | Blend ratio for each level of the "RNN" button. |
| `HAMNOISE_QUALITY` | `classic` | `classic` or `v2`. See [HamNoise](#hamnoise-hamnoise-button). |
| `RADE_TX_BIN`, `RADE_RX_BIN`, `LPCNET_DEMO_BIN` | `radae_tx`, `radae_rx`, `lpcnet_demo` | Locations of the FreeDV RADE programs. |
| `RADE_VERSION` | `v1` | `v1` (stable) or `v2` (under development; both ends must match). |
| `RADE_TX_GAIN` | `4` | Transmit drive multiplier for RADE. |
| `FREEDV_REPORTER_ENABLED` | on | `0` or `false` stops any reporting to the FreeDV Reporter. Reporting also needs the "FDV Spot" box ticked in the UI. |
| `FREEDV_REPORTER_HOST` | public service | Only for testing against your own Reporter server. |

The long-form description of each variable, with the reasoning behind the
defaults, follows the diagnostics section below.

## Updating

```bash
cd ~/PiRO
git pull
npm install
sudo systemctl restart piro
```

The web app caches itself in the browser through a service worker. That cache
is renamed (the version number in `src/client/sw.js`) whenever the client
files change, so a normal refresh picks up an update. If you edit the client
files yourself, bump that version number too. If a page still looks old, do
one hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on a Mac).

## Troubleshooting

- **Permission denied on the serial port.** Running by hand: add yourself to
  `dialout`, then log out and in. Under systemd the unit adds the group, so
  check `CIV_SERIAL_PATH` instead.
- **`npm install` fails with `node-gyp` or compiler errors.** Install
  `build-essential` and `python3`, and check that Node is version 18 or newer.
- **Every CI-V command times out.** The baud rate must match the radio's menu
  setting exactly, CI-V Transceive must be on, and nothing else (another CAT
  program, or a second PiRO) may hold the port.
- **No audio devices.** Install `alsa-utils` and check `arecord -l` shows the
  radio's codec. Some radios use a second USB cable for audio.
- **A noise-reduction button does nothing.** Look at `journalctl -u piro`. For
  "RNN", `rnnoise_demo` is probably not on the `PATH`, or is the unpatched
  build. Re-do the check in [RNNoise](#rnnoise-rnn-button).
- **The server runs at 100% CPU after turning HamNoise on.** Make sure
  `HAMNOISE_QUALITY` is not set to `v2` on a Raspberry Pi.
- **FT8 decodes nothing or at the wrong times.** Check the system clock with
  `timedatectl`. It must show "System clock synchronized: yes".
- **The microphone is blocked in the browser.** Use HTTPS (see
  [Installing PiRO](#installing-piro)).

## Hardware diagnostics

The `test/manual-*.js` scripts talk to a real radio. Stop the service first,
because they need the serial port. None of them transmits.

```bash
node test/manual-civ-test.js /dev/ttyUSB0            # basic CI-V check (optionally add the address: 0x94)
node test/manual-scope-test.js /dev/ttyUSB0          # does your radio deliver scope data? (may need CIV_BAUD_RATE=115200)
node test/manual-scope-span-diagnostics.js /dev/ttyUSB0   # scope span slider rejected ("Radio rejected request")
node test/manual-smeter-diagnostics.js /dev/ttyUSB0       # S-meter shows wrong values; prints the raw reply bytes
node test/manual-txpower-diagnostics.js /dev/ttyUSB0      # TX power setting rejected (NG)
node test/manual-ws-test.js ws://<pi-hostname-or-ip>:8080 # talk to a running server's WebSocket
```

If you open an issue about one of these, include the script's full output and
what the radio's front panel showed. `docs/civ-notes.md` explains the common
causes.

## Configuration reference (long form)

Environment variables the server reads: `CIV_SERIAL_PATH`,
`CIV_RADIO_MODEL`, `CIV_BAUD_RATE` (default 19200 — must match the
radio's own CI-V USB Baud Rate menu setting exactly; spectrum scope use
often needs this raised, e.g. to 115200), `WS_PORT` (default 8080),
`AUDIO_RX_DEVICE` (audio is
disabled entirely if unset — this also disables the CW decoder, which
has no separate env var of its own and activates automatically off the
same RX audio whenever mode is CW), `AUDIO_TX_DEVICE` (defaults to
`AUDIO_RX_DEVICE` — usually the same USB codec handles both directions),
`AUDIO_SAMPLE_RATE` (default 48000), `AUDIO_CHANNELS` (default 1),
`AUDIO_CODEC` (`pcm` default, used by the PWA client; `opus` available
but not used by the shipped client — see `docs/audio-notes.md`),
`CIV_SCOPE_ENABLED` (`false`/unset by default — spectrum scope is opt-in;
set to `true` to enable, see `docs/civ-notes.md`),
`STATIC_DIR` (defaults to `src/client`), `TLS_CERT_PATH`/`TLS_KEY_PATH`
(both unset by default — serves plain HTTP/WS; set both to serve
HTTPS/WSS instead, needed for microphone access from non-localhost
origins — see `docs/pwa-notes.md`), `SCREEN_TITLE` (default `"SPARC
PiRO"` — shown as both the browser tab title and the on-screen heading;
sent to clients at connect time, not baked into the static HTML, so it
reflects the *running* server's environment even if you never rebuild
anything — see `docs/ui-notes.md`; shown in the UI alongside a small
app-version number, read straight from `package.json`, in text the same
size/color as the "Connected" status — see `docs/ui-notes.md`),
`STATION_CALLSIGN`/`STATION_GRID`
(both unset/`null` by default — your own callsign and Maidenhead grid
locator, e.g. `STATION_CALLSIGN=VK2IO STATION_GRID=QF56MC`; used to build
the FT8 composer's default "CQ {CALLSIGN} {MAIDENHEAD}" message and to
drive the guided FT8 QSO sequence — see the FT8 section below and
`docs/ui-notes.md`; with either unset, the FT8 composer simply starts
empty and the guided sequence stays inactive, exactly as before this
feature existed), `CIV_MAXIMIZE_USB_LEVELS` (`true`/unset by default —
at startup, best-effort sets the radio's own internal "AF output level
to ACC/USB" and "MOD input level from USB" CI-V settings to maximum;
distinct from, and in addition to, the ALSA-side `amixer` maximization
below — see `docs/civ-notes.md`; set to `0`/`false` to leave the radio's
own levels as found), `RADE_TX_BIN`/`RADE_RX_BIN`/`LPCNET_DEMO_BIN` (all
default to the bare command name, i.e. resolved via PATH — the compiled
rade_c binaries (`radae_tx`, `radae_rx`, `lpcnet_demo`) used for the
FreeDV mode button's RADE V1 codec (its only mode now — see
`docs/ui-notes.md`'s "700E was removed" note); see `docs/ui-notes.md` for what each
one does and how to build/install them — rade_c also builds a fourth
tool, `real2iq`, but this app deliberately doesn't use it, so there's no
env var for it), `RADE_VERSION` (`v1` default — the stable, undeprecated waveform
per rade_c's own README; set to `v2` only if you specifically want to
experiment with the newer V2 waveform, which upstream itself currently
describes as "under active development" and says "on-air use is not
recommended at this stage" — both ends of a link must agree on this,
same as any modem), `RADE_TX_GAIN` (`4` default — linear multiplier
applied to the real part extracted from `radae_tx`'s complex IQ output
before it reaches the radio on TX; not `1`/no-extra-gain, because a
remote station reported only ~20% modulation at that level — `4` is a
real-world-informed correction, not an independently confirmed "correct"
value, so treat it as an adjust-by-ear/power-meter knob if RADE TX drive
still seems too low or now clips/distorts on your own radio/audio chain —
see `docs/ui-notes.md`'s "The RADE codec bridge" for the full pipeline
and its "Real bug found: only ~20% modulation" note for why 4), `FREEDV_REPORTER_ENABLED` (`true`/unset by
default — the ops-level switch for reporting this station to the live
FreeDV Reporter activity map at https://qso.freedv.org, reusing
`STATION_CALLSIGN`/`STATION_GRID` above; set to `0`/`false` to opt out
without unsetting those two, which are also used elsewhere; even with
this on, reporting only actually happens once the UI's own "FDV Spot"
checkbox — below the Filter button, shown only while FreeDV mode is
active, unchecked by default — is also checked *and* the FreeDV mode chip
is armed — see `docs/ui-notes.md`),
`FREEDV_REPORTER_HOST` (unset by default — connects to the real public
service; only for testing against a self-hosted FreeDV Reporter
instance). Once armed and spotting, the UI also shows a status-message
field ("Looking for contacts", etc.) below the FDV Spot checkbox — see
`docs/ui-notes.md`'s "Status message (`message_update`)" section.

`RNNOISE_BIN` (defaults to the bare command name `rnnoise_demo`, i.e.
resolved via PATH — the compiled RNNoise demo binary from
[github.com/xiph/rnnoise](https://github.com/xiph/rnnoise)'s `examples/`
directory, used by the "RNN" toggle button (which replaced the old Noise
Blanker/"NB" button) to denoise the RX audio actually sent to clients;
off by
default, spawned lazily only once the toggle is switched on; requires
`AUDIO_RX_DEVICE`, since it filters that same audio pipeline; deliberately
scoped to client-audio/STT only — it never touches the raw audio CW/RTTY/
FT8/FreeDV decode from, since RNNoise is a speech-denoiser and none of
those are actually speech; if the binary isn't installed/on PATH, or it
exits unexpectedly, the toggle no-ops back to unfiltered passthrough and
an `AUDIO_ERROR` is broadcast — see `docs/ui-notes.md`'s "RNN noise
reduction" section and `src/audio/rnnoise-filter.js`).

A second, mutually-exclusive RX denoiser is also built in: the "HamNoise"
toggle button, directly beneath "RNN", runs
[HamNoise](https://github.com/e04/HamNoise)'s own neural denoiser — a
band-split RNN model, architecturally unrelated to both RNNoise above and
this project's own CW3/DeepCW decoder — over the same client-audio/STT-only
RX path RNNoise occupies (see the paragraph above for exactly what that
means and doesn't mean). Unlike RNNoise, it needs no separate binary
install or env var: the two prebuilt WASM models it uses (CW and voice)
are bundled under `models/hamnoise/` (see that directory's own
`NOTICE.md` for provenance and licensing) and run in-process via Node's
built-in WebAssembly support. Switching it on forces "RNN" off and vice
versa — the operator asked for them to never run at once — but either one
is fine to combine with the radio's own hardware NR button, which is a
completely separate stage upstream in the actual RF/analog signal chain.
HamNoise automatically picks its CW-trained or voice-trained model to
match the radio's current mode, with no separate control for that; off by
default; a load/processing failure falls back to unfiltered passthrough
and broadcasts `AUDIO_ERROR`, the same posture as RNNoise — see
`docs/ui-notes.md`'s "HamNoise noise reduction" section and
`src/audio/hamnoise-filter.js`.

`HAMNOISE_QUALITY` (`classic` by default, or `v2`) picks which generation
of HamNoise's bundled models is used. This defaults to `classic` (the
older, much cheaper single-GRU models) rather than HamNoise's own
newer/default "v2" band-split-RNN models, because of a real-world
performance finding: measured directly against the bundled binaries, v2
costs roughly 36-53% of the real-time budget per hop of audio — on a fast
x86 development machine, single-threaded and synchronous on this app's
one event-loop thread — which a Raspberry Pi's far weaker single-core
performance can easily push over 100%, meaning it falls further and
further behind in a growing backlog rather than ever catching up, pinning
the whole server at 100% CPU (starving CI-V control and every other
WebSocket feature along with it) with nothing actually failing or logging
an error. `classic` measured roughly 100x cheaper, leaving comfortable
headroom even on a Pi. Only set `HAMNOISE_QUALITY=v2` on hardware you've
confirmed can actually keep up with it in real time — see
`src/audio/hamnoise-filter.js`'s own doc comment on its `quality` option
for the full numbers and reasoning.

## Project layout

```
src/
  civ/            CI-V driver: framing, BCD encoding, rig control,
                   spectrum scope decoding (all phases 1 & 6 — done)
  audio/          ALSA capture/playback, PCM framing, Opus codec (phase 3 — done);
                   also FT8 support: slot-clock (UTC 15s boundaries),
                   resampler (48k<->12k with anti-aliasing), the RX/TX
                   bridge, and its decode worker-thread — see docs/ui-notes.md
  server/         WebSocket control layer (phase 2 — done), audio bridge
                   (phase 3 — done), scope bridge (phase 6 — done), static
                   file server (phase 4 — done), CW decoder bridge, FT8 protocol wiring
  client/         PWA app shell + rig control UI + spectrum scope display
                   (phases 4-6 — done): manifest, service worker, icons,
                   VFO/mode/band/PTT/S-meter controls, Web Audio RX/TX
                   pipeline, canvas spectrum trace + waterfall; also the
                   FT8 panel (band-activity table + manual composer),
                   FT8 mode's auto-tune-per-band logic, and the guided
                   FT8 QSO sequencer (ft8-qso.js)
test/
  frame.test.js           unit tests for CI-V framing/BCD, no hardware needed
  scope.test.js           unit tests for scope waveform decoding/reassembly,
                           synthetic frames, no hardware needed
  civ-driver.test.js      CivDriver integration tests against a fake serial
                           transport: request/reply matching (incl. the
                           subCmd disambiguation fix), scope-line wiring,
                           and scope span/mode/band-range commands
  ws-server.test.js       integration test for the control layer, stubbed
                           CivDriver, no hardware needed
  pcm-framer.test.js      unit tests for PCM frame accumulation
  opus-codec.test.js      real Opus encode/decode round-trip tests (WASM,
                           no hardware needed)
  mixer.test.js           unit tests for the ALSA mixer helper against an
                           injected fake execFile, no real amixer needed
  audio-bridge.test.js    integration test for the audio bridge, both pcm
                           (default) and opus codec modes, and the
                           startup volume-maximizing behavior: real
                           WebSocket, fake ALSA I/O, tagged binary frame format
  scope-bridge.test.js    integration test for the scope bridge: real
                           WebSocket, tagged binary frame encode/decode
                           round-trip, coexistence with audio frames
  static-server.test.js   static file server tests: content types, 404s,
                           path-traversal protection
  tls-server.test.js      confirms the server actually works over
                           HTTPS/WSS when TLS_CERT_PATH/TLS_KEY_PATH are set
  scope-display.test.mjs  unit tests for the client's waterfall color
                           mapping, tuning marker, click-to-tune math
                           (including the nearest-kHz snapping applied to
                           both the click and its hover-tooltip preview),
                           and 50kHz division ticks — genuinely executes
                           src/client/scope.js in Node (see docs/ui-notes.md)
  smeter.test.mjs         unit tests for the S-meter bucket logic —
                           genuinely executes src/client/smeter.js in Node
  vswr.test.mjs           unit tests for the VSWR raw-value conversion
                           and color zones — genuinely executes
                           src/client/vswr.js in Node, including a full
                           monotonicity sweep across all 256 raw values
  cw-decoder.test.js      unit tests for the CW decoder's DSP/timing —
                           Goertzel tone detection, morse lookup, full
                           end-to-end decoding of synthetic generated
                           audio (clean, noisy at fixed deterministic
                           seeds, and a sudden speed change), and the
                           self-calibrating auto pitch-detection feature
                           (locks onto the actual tone frequency from a
                           wrong starting pitch, ignores broadband noise,
                           can be disabled, and clears its state on
                           reset()) — including regression tests for the
                           real bugs found while building all of it
  hamfist-cw-decoder.test.js
                           unit tests for "CW2", the alternative FFT
                           multi-channel/beam-search CW decoder ported
                           from Jonathan Dawson's "Hamfist" project —
                           morse binary-tree lookup, dictionary
                           autocorrect/callsign validation, the element/
                           gap pre-filter, and full end-to-end decoding
                           of synthetic generated audio
  deepcw-decoder.test.js  unit tests for "CW3", the neural-network/CTC
                           CW decoder ported from e04/deepcw-engine —
                           bundled model/metadata load correctly, the
                           5-20s windowSeconds clamp, full end-to-end
                           decoding of a synthetic "PARIS" signal through
                           the real ONNX model, silence producing no
                           output, reset() clearing buffered state
                           without reloading the model, and API parity
                           (setPitch()/estimatedWpm) with CW1/CW2
  cw-decoder-bridge.test.js
                           unit tests for the server-side bridge's
                           mode/PTT-driven attach-to-PCM-stream logic,
                           its RIG_ERROR broadcast on a failed CW-pitch
                           read, and CW1/CW2/CW3 decoder-variant switching
                           (only the active decoder is fed PCM/
                           broadcasts, switching resets the newly-active
                           one, and CW3's 'error' event — e.g. a missing
                           onnxruntime-node binary — only broadcasts
                           AUDIO_ERROR while CW3 is the active variant),
                           using stub civ/controlServer/audioBridge/
                           decoder(s) — the DSP/model itself is covered
                           above, this only tests the wiring around it
  slot-clock.test.js      unit tests for FT8's UTC 15-second slot-boundary
                           arithmetic and the SlotClock event-firing
                           behavior, against an injected fake scheduler
  resample.test.js        unit tests for the FT8 resampler: FIR filter
                           design/application, linear resampling, and the
                           real RX/TX paths — including an anti-aliasing
                           regression (a would-alias 9kHz tone vs a
                           genuine in-band reference) and a full
                           12k->48k->12k round trip
  fft.test.js             unit tests for the from-scratch radix-2 FFT
                           behind the FT8 audio-spectrum display
                           (src/audio/fft.js): power-of-two validation,
                           DC-signal energy concentration, Hann window
                           shape, bin-width/peak-location correctness for
                           a known tone, short-input zero-padding, and
                           silent-input edge cases
  ft8-bridge.test.js      integration tests for the FT8 RX/TX bridge:
                           attach/detach around active-state and PTT,
                           slot-boundary decode requests to a stub
                           worker, cross-slot callsign-memory carry-over,
                           the TX send/replace/error paths (including an
                           explicit freqHz targeting a specific TX
                           frequency instead of the bridge's own default,
                           and the {message, freqHz} 'ft8-send' payload
                           shape — see the guided QSO sequencer below),
                           and the audio-spectrum timer/framing/noise
                           -floor-relative color-scaling logic (via an
                           injected computeSpectrumFn stub — see
                           docs/ui-notes.md), using stub
                           civ/controlServer/audioBridge/slotClock/worker
                           — the actual DSP/codec is covered above, and
                           the real @e04/ft8ts calls are exercised
                           manually against real hardware, not unit-tested
  ft8-qso.test.mjs        unit tests for the guided FT8 QSO sequencer
                           (src/client/ft8-qso.js): parsing the standard
                           FT8 message set (CQ, reply-with-grid, signal
                           report, acknowledged report, RRR/RR73, 73),
                           formatReport()'s WSJT-X-style formatting/
                           clamping, defaultCqMessage(), row-highlight
                           matching (isRelatedToQso()), and the full
                           Ft8QsoSequencer state machine end to end in
                           both roles (replying to someone else's CQ, and
                           someone answering our own CQ — including
                           picking the strongest reply out of a pileup
                           and manually overriding that pick)
  manual-civ-test.js      manual smoke test against a real radio (CI-V only)
  manual-ws-test.js       manual smoke test against a running server, over
                           the network
  manual-scope-test.js    manual smoke test: confirms whether your specific
                           radio/firmware actually delivers scope data over
                           CI-V
  manual-scope-span-diagnostics.js
                           diagnostic tool: tries several candidate wire
                           encodings for the scope span-set command
                           directly against your hardware, using live
                           scope-line data as ground truth for whether
                           each one actually worked — for when the shipped
                           encoding (verified against a supplied worked
                           example, but still rejected on some hardware —
                           see docs/civ-notes.md) doesn't work for you
  manual-smeter-diagnostics.js
                           diagnostic tool: reads the S-meter repeatedly
                           and prints the raw reply bytes directly,
                           alongside every plausible interpretation of
                           them side by side — for when getSMeter()'s
                           byte-slicing guess (already wrong twice — see
                           docs/civ-notes.md) still doesn't match what
                           your radio's front panel shows
  manual-txpower-diagnostics.js
                           diagnostic tool: tries several candidate wire
                           encodings for the TX power set command
                           directly against your hardware — for when
                           setTxPower() is rejected (NG) on your radio.
                           Safe to run: setting the power level never
                           engages PTT or transmits anything by itself
docs/
  civ-notes.md    CI-V protocol implementation notes, incl. spectrum scope
                  byte layout and a real-world reliability caveat
  audio-notes.md  audio pipeline implementation notes (incl. PCM vs Opus)
  pwa-notes.md    PWA installability / HTTPS constraint notes
  ui-notes.md     client UI architecture, binary frame tagging, gesture/mic
                  lifecycle notes, testing boundary
```


## Rig control UI

Opening `http://<pi>:8080` in a browser now gives you the real thing:
click-to-edit frequency (displayed grouped by thousands — "14.195.000",
not "14.195000" — for readability at a glance; the editable field itself
still takes/shows a plain decimal, e.g. "14.195000", so it stays a valid
number while you're typing) with -10kHz/-1kHz/+1kHz/+10kHz step buttons
alongside it, band quick-select (10 bands, 160m through 6m, the current
band highlighted the same way the current mode is) and mode buttons (LSB
through FM) laid out in fixed 2-row grids, RX function
toggle buttons (Preamp, NR, NB, Notch, Filter — each cycles through its
states on click, e.g. "P.Amp Off" -> "P.Amp 1" -> "P.Amp 2", "Filter 1"
-> "Filter 2" -> "Filter 3") alongside them, a segmented S-meter (S0-S9
individually, +10dB through +60dB over S9 — see below) that switches to
showing VSWR with green/orange/red coloring while transmitting, antenna
tuner on/off and a separate one-shot Tune button plus a transmit power
dropdown (100/75/50/25/5W) below the S-meter, a fail-safe 10-minute
transmission cutoff enforced server-side (required for this style of
remote operation under the Australian amateur class licence — see
`docs/civ-notes.md`), push-to-talk (button or hold Space) that switches
to a two-button iambic CW paddle (Dot/Dash, adjustable WPM) whenever the
mode is CW, a scrolling CW decode ticker under the S-meter that
activates automatically alongside it (server-side Morse decoding from
the radio's own RX audio — see below), speaker/mic audio once you tap
"Speaker: off" to enable it
(browsers require a user gesture before audio can play), and — if
`CIV_SCOPE_ENABLED=true` and your radio cooperates (see `docs/civ-notes.md`) — a live spectrum trace and scrolling waterfall, colored with
Google's "Turbo" colormap (see `docs/ui-notes.md`), with a dashed tuning marker and
click-to-tune (click anywhere on either the trace or the waterfall to
retune to that frequency), plus a vertical RX gain slider (0-255,
default max) to its right. The Preamp/NR/NB/Notch/Filter
toggle buttons, the tuner on/off button, the transmit power dropdown,
and the RX gain slider are all actively polled to stay in
sync with the radio's actual state — including changes made from the
front panel, not just this UI — rather than just reflecting their own
last click; see `docs/ui-notes.md` for why and how. Multiple browser
tabs/devices can be connected at once and stay in sync — see
`docs/ui-notes.md` for the architecture and, importantly, the **testing
boundary**: server-side logic and pure client-side logic (waterfall
color mapping, tuning-marker and click-to-tune math, S-meter bucketing)
are covered by automated tests, but the actual Web Audio/microphone/PTT
flow and canvas rendering need manual verification in a real browser
against real hardware, since
this environment has no headless browser available to automate that.

The page also requests a **Screen Wake Lock** as soon as it loads, so a
phone's own screen timeout doesn't interrupt an operator mid-QSO while
they're just listening/watching rather than actively touching the
screen — re-requested automatically whenever the page becomes visible
again after being backgrounded (the browser force-releases the lock
while hidden). Requires a secure context (`https://`, same as the
service worker — see `docs/pwa-notes.md`) and a browser that implements
the API; degrades to the phone's normal screen-timeout behavior
otherwise, with no other effect on the app. See `docs/ui-notes.md`.

An **FT8** chip sits in the mode row itself (in RTTY's old grid slot,
styled identically to the real mode chips — see below for why it isn't
actually a hardware mode despite living there); selecting it puts the
radio on USB, auto-tunes to the current band's standard FT8 calling
frequency (re-tuning automatically on any subsequent band change too),
and swaps the PTT button/bandwidth control/scope-span row out for an
FT8 band-activity table and a manual message composer. Clicking a real
mode chip leaves FT8 mode again. See the **FT8** section below and
`docs/ui-notes.md` for the full design.

**The scope stays centered on the current frequency, with 50kHz division
markers below it and a "Scope Span" slider (2.5/5/10/25/50/100/250/500
kHz, default 100kHz) to control the width to each side of center** (a
"100kHz" span tuned to 7100kHz displays 7.000-7.200MHz — confirmed on
real hardware; see `docs/ui-notes.md`/`docs/civ-notes.md`). Mode is set
to Center once
when scope output is enabled (`ScopeBridge#start()`) — Center mode's
displayed center automatically tracks the VFO on the radio itself, so
this one-time setup keeps it centered through band clicks, direct entry,
scope click-to-tune, and even the front panel, with no per-change command
needed. Span is **not** set at server startup at all — the client
requests the default itself once connected, and the same slider changes
it on demand via the `setScopeSpan` WebSocket request; the slider's own
value is an index into the eight span options (equal positions along its
range), and every one of their values maps exactly onto one of the
radio's 8 fixed presets, no clamping needed. The 50kHz gridlines/tick
labels are computed by
`scopeDivisions()` and drawn/rendered fresh on every scope line — see
`docs/ui-notes.md`.

Getting the span command right took real back-and-forth, worth tracking
honestly since it took a genuine upgrade in source quality to finally
resolve. Several wire-format guesses were tried and confirmed wrong by
real hardware testing — including one that had checked out byte-for-byte
against a concrete worked example from an informal online source, which
still turned out wrong: it claimed the value was a single-byte *index*
(0-7) and that presets were labeled by their **half**-width, both
incorrect. The breakthrough was Icom's own official IC-7300 CI-V
reference manual (Section 19), whose own reference table explicitly
confirms the value is the span **directly in Hz** — settling a question
no prior source had actually answered unambiguously. The manual also
revealed a second, separate bug: scope mode-setting needed a 2-byte
payload, not the 1-byte one this project had been sending (which hadn't
been causing visible failures, just not matching spec). The exact byte
*position* of the span value within its 6-byte payload still isn't
independently hardware-confirmed the way frequency encoding is — PDF
extraction of the manual's own diagram is inherently lossy — so
`test/manual-scope-span-diagnostics.js` has been updated with the
manual-derived encoding as its primary candidate for final verification
against real hardware. See `docs/civ-notes.md` for the full history and
`docs/ui-notes.md` for the span slider.

**S-meter**: bucketed into 16 segments (S0 through S9 individually,
+10dB through +60dB over S9) using real calibration data — refined
twice now as better data became available: first an even-spacing
placeholder (no manufacturer table existed at the time; Icom's S-meter
is well-documented as non-linear/inconsistent across models/firmware),
then a supplied raw-value-range table that could only distinguish
"S1-S3" as one combined bucket, and now a power-curve-derived table
giving individual S1-S9 buckets, superseding that combined range
entirely. Just the bucketed label is shown (e.g. "S7") — an earlier
version also showed the raw value alongside it, dropped per explicit
request (see `docs/ui-notes.md`).

**VSWR while transmitting**: the same S-meter bar switches to showing
VSWR (green ≤1.5, orange >1.5–3, red >3, capped at 5) whenever PTT is
active, reverting back once released. `CivDriver#getSWR()` reuses the
S-meter's now-hardware-confirmed byte decode, since it lives under the
same CI-V command group and Icom's manual documents it in the identical
table style — a reasoned extension backed by clean matches against all
of the manual's own documented examples, but **not independently
confirmed against a real transmit into a known load** the way S-meter
itself now is. See `docs/civ-notes.md` for the full reasoning and
`src/client/vswr.js`/`test/vswr.test.mjs` for the raw-to-VSWR conversion.

**Receive filter (Filter 1/2/3)**: no standalone CI-V command exists for
this — it's the second byte of the existing mode-set command, so
`CivDriver#setFilter()` reads the current mode first and resends it
unchanged alongside the new filter byte, rather than risking an
accidental mode change.

**Transmit power (100/75/50/25/5W dropdown)**: `CivDriver#setTxPower()`
converts watts to the CI-V level's raw 0-255 range via a **simple linear
assumption** (100W rated max) — that part remains unverified. The byte
*encoding* itself, however, was tested on real hardware and found
wrong: the first attempt (standard BCD) got every write rejected
outright (NG), root-caused to an invalid byte value for higher
wattages, and fixed by reusing the packing already confirmed for the
S-meter. See `docs/civ-notes.md` for the full story, and
`test/manual-txpower-diagnostics.js` if it's still rejected on your
hardware (safe to run — it never engages PTT or transmits anything).

**RX gain (vertical slider, right of the scope)**: raw 0-255, no unit
conversion, defaulting to 255 (max). Applies the TX power lesson
immediately rather than repeating it — RF gain lives in the same CI-V
command group as TX power, so `CivDriver#setRxGain()` uses the same
byte packing from the start. Worth being precise about what that rests
on: it's an inference on top of an inference (TX power's fix for its own
NG rejection hasn't itself been hardware-confirmed yet), not something
independently verified for RX gain specifically. See `docs/civ-notes.md`.

**CW iambic paddle**: replaces the PTT button with Dot/Dash buttons
whenever the mode is CW. Real limitation worth stating plainly: there's
no CI-V primitive for timed keying, so every element goes through the
same PTT toggle used for voice, over the full WebSocket + serial round
trip — expect visibly less precise timing than a hardware keyer,
especially at higher WPM. Defaults to a conservative 15 WPM given that
latency. See `docs/ui-notes.md` for the full design, including a
defense-in-depth session timer that closes a real gap in the PTT
watchdog below (a stuck paddle producing continuous keying wouldn't
otherwise trip it, since each element's brief gap resets the server-side
timer).

**PTT fail-safe (10-minute automatic cutoff)**: enforced server-side,
required for this style of remote operation under the Australian
amateur class licence (`Radiocommunications (Amateur Stations) Class
Licence 2023`, s.13(4)(b)). Deliberately not client-side — the server is
the persistent process, so a crashed browser tab or dropped network
connection while transmitting still gets caught, which is exactly the
scenario the rule exists to guard against. Normal CW keying never trips
it, since every PTT-off (including the natural gaps between keyed
elements) resets the timer — only a truly continuous, unbroken
transmission accumulates toward the limit. See `docs/civ-notes.md` for
the full design and the one known gap (not persisted across a server
restart) that's accepted rather than solved.

**CW decoder**: activates automatically whenever mode is CW, decoding
from the radio's own RX audio server-side (a hard dependency on
`AUDIO_RX_DEVICE` being configured — see below) and streaming text to a
scrolling ticker under the S-meter. Built and tuned against synthetic
generated audio, not assumed correct — four real bugs (a cold-start
silent-drop bug, a wrong-direction speed-adaptation bug, a genuine
noise-vs-speed-range tuning tradeoff, and a bug where any message
starting with a dash — including "CQ", the most common CW call there is
— had its very first character misread) were found and fixed this way;
see `docs/civ-notes.md` for the full account. Clicking to tune the scope
while in CW mode also sets the exact clicked frequency rather than
snapping to the nearest kHz, the same as RTTY mode, since a CW signal's
own bandwidth is too narrow for kHz-precision tuning to reliably land on
it. Worth being direct about realistic expectations: like any CW
decoder, weak or noisy signals degrade it, sometimes significantly —
this is a genuinely useful aid for clean-to-moderate signals, not a
guarantee of accurate copy in poor conditions, the same caveat that
applies to dedicated hardware/software CW decoders generally. Three
decoder algorithms are available, switched via the CW mode chip itself
(its label reads "CW 1"/"CW 2"/"CW 3"; click it again while already in CW
mode to cycle CW1 -> CW2 -> CW3 -> CW1) — "CW1" is the original decoder
described above, "CW2" is a from-scratch port of Jonathan Dawson's
"Hamfist" decoder (https://github.com/dawsonjon/HamFist): an FFT-based
design that decodes across several frequency channels at once (no pitch
calibration needed — whichever channel has the tone lights up on its
own), with histogram-based (rather than fixed-ratio) dot/dash/gap
classification and a Bayesian beam-search decode backed by a ~9800-word
autocorrect dictionary; and "CW3" is a neural-network decoder ported from
`e04/deepcw-engine` (https://github.com/e04/web-deep-cw-decoder): a small
CNN+CTC model run via `onnxruntime-node`, with no timing/classification
model at all. Unlike CW1/CW2, CW3 doesn't decode live character-by-
character — it batches 5-20 second audio windows through the model, so
its output arrives in bursts every several seconds rather than as each
element is keyed. It also depends on a native `onnxruntime-node` binary
for the host platform: prebuilt binaries cover 64-bit Raspberry Pi OS
(Pi 4/5, `linux-arm64`), but *not* 32-bit `armv7` (`linux-arm`); if no
matching binary is available, CW3's model fails to load and that failure
is surfaced as an error banner while CW3 is selected, rather than
silently decoding nothing. Bundling this model is also why the project as
a whole is now AGPL-3.0-only — see "Licence" below. See
`docs/ui-notes.md`'s "CW decoder" section, `src/audio/hamfist-cw-decoder.js`'s
and `src/audio/deepcw-decoder.js`'s own doc comments for the full
comparison.

**RTTY decoder**: activates automatically whenever mode is RTTY, decoding
Baudot/ITA2 from the radio's own RX audio server-side (same
`AUDIO_RX_DEVICE` dependency as the CW decoder) and streaming text to a
scrolling ticker under the S-meter, the same presentation as CW's own. The
RF scope also draws a second dashed marker while RTTY is active: a blue
dashed line 170Hz below the tuned-frequency marker (which stays its usual
green), marking the mark/space shift — trace-only, like the tuning marker
itself, not drawn into the waterfall. Clicking to tune the scope while in
RTTY mode also sets the exact clicked frequency rather than snapping to
the nearest kHz, since RTTY's tones are packed too closely together for a
1kHz snap to reliably land where intended. A "Reverse" checkbox next to
the ticker swaps which tone (mark/space) the decoder treats as which —
RTTY polarity genuinely isn't predictable from the radio's mode alone (it
depends on both stations' equipment), so a signal using the opposite
polarity from the decoder's assumption previously decoded nothing at all;
see `docs/ui-notes.md`'s "Real bug found" writeup for the full story.
Unchecked by default.

**FT8 (RX + manual TX)**: since the IC-7300 has no native "FT8" CI-V
mode — the radio only ever sees `USB` — FT8 is an app-level concept
layered on top: opening the FT8 panel puts the radio on USB and starts
decoding 15-second, UTC-slot-aligned band activity from the same RX
audio the CW decoder and voice RX use, showing decoded callsigns/grids/
reports in a band-activity table. Selecting FT8 (and any subsequent band
change while it's active) auto-tunes the dial to that band's standard
FT8 calling frequency. TX is manual only: you compose/pick a message and
send it, and the app keys PTT itself and plays the encoded tone out at
the next slot boundary — there's no auto-sequencing (WSJT-X-style
automatic QSO completion), which is a deliberate choice, not a
limitation of the library, to stay clearly within an operator
*supervising* each transmission rather than software conducting a QSO on
its own; see `docs/ui-notes.md` for the reasoning and the possible
future auto-sequencing phase left explicitly undone for now. Decoding is
CPU-heavy (real seconds per slot on a busy band), so it runs in a
background worker thread, not the main server process, to avoid
stalling CI-V/audio/WebSocket handling. While the FT8 panel is open, the
RF scope display is replaced by a live spectrum/waterfall computed with
a real FFT of the RX audio itself (0-3000Hz above the dial, matching
WSJT-X's own FT8 display exactly, updated a few times a second) rather
than a crop of the radio's coarser CI-V sweep — see `docs/ui-notes.md`
for the full pipeline. Uses
[`@e04/ft8ts`](https://www.npmjs.com/package/@e04/ft8ts) — see
**Licence** below for what that means for this project. Entering FT8 mode
also turns on the IC-7300's separate **DATA MODE** setting (not just the
`USB` operating mode) — required for the radio to actually source TX
audio from the USB connection rather than the front-panel mic. **If FT8
transmissions still aren't being heard by other stations, check on the
radio itself: Menu > Set > Connectors > MOD Input, and confirm the "DATA
ON" entry (not just "DATA OFF") is set to USB** — this is a menu setting
CI-V cannot change remotely; see `docs/civ-notes.md`'s "DATA MODE"
section for the full story. PTT is held for
the encoded waveform's nominal playback duration *plus* a
`PTT_RELEASE_MARGIN_MS` (300ms default, `src/audio/ft8-bridge.js`) safety
margin before releasing, since handing PCM to the ALSA playback pipe
doesn't mean it's already reached the speaker — releasing PTT too early
truncates the tail of the transmission; see `docs/ui-notes.md`'s "Real bug
found" writeup for the full story.

**Guided FT8 QSOs**: with `STATION_CALLSIGN`/`STATION_GRID` configured
(see above), the FT8 composer starts each session with a default
`CQ {CALLSIGN} {MAIDENHEAD}` message, and `src/client/ft8-qso.js` drives
the standard FT8 exchange as a guided sequence: clicking a decoded CQ (or
sending your own CQ and having someone answer it) prefills the next
message the standard exchange calls for at each step — grid, then signal
report, then acknowledgement, then RRR73/73 — as each reply is actually
decoded, tracking one QSO at a time. The rows belonging to the
in-progress QSO are highlighted in the band-activity table, and its
frequency is marked on the FT8 spectrum and used to target that QSO's own
replies (standard operating practice: reply on the frequency the other
station is actually listening on, not always your own calling
frequency), all via the optional `freqHz` on `sendFt8` (see the protocol
section below). The same targeting is available manually: hovering the
FT8 spectrum shows a 50Hz-snapped frequency tag, and clicking it sets that
as the next transmission's frequency (marked with the same amber marker
used for an in-progress guided QSO). Absent a guided QSO or a manual
click, a fresh CQ goes out at a default TX frequency of **1500Hz**,
tracked per-session: clicking a new frequency on the spectrum updates
that default too, so it sticks for the rest of the session (until the
page is reloaded) rather than reverting after the next send — see
`docs/ui-notes.md`'s "Default FT8 TX frequency" note. This is still guidance, not automation: every suggested
message still has to be reviewed and sent by the operator, same as any
other composer text — see `docs/ui-notes.md`'s "What's still Phase 3
(explicitly not built)" note on why full auto-sequencing (deciding *and
transmitting* without a human per message) is a deliberate scope
boundary, not a missing feature.

**Worth knowing:**

- **Microphone access (PTT/TX audio) requires HTTPS** when accessing from
  any device other than the Pi itself — over plain HTTP on a LAN address,
  `navigator.mediaDevices` is unavailable entirely in the browser, not
  just degraded. RX (speaker) audio and everything else works fine over
  plain HTTP. The server supports TLS directly via `TLS_CERT_PATH`/
  `TLS_KEY_PATH` env vars — see `docs/pwa-notes.md` for cert generation
  options and trade-offs.
- Service worker/installability also wants HTTPS, but degrades gracefully
  (`docs/pwa-notes.md`).
- No arbitration between multiple clients transmitting simultaneously
  (`docs/ui-notes.md`) — everyone has equal control.
- **USB audio levels are maxed on every server start**, on both sides of
  the link: the Linux/ALSA side (best-effort, via `amixer`) so the USB
  codec doesn't get left at some unpredictable gain — see
  `docs/audio-notes.md` for how to disable this — *and* the radio's own
  internal levels for the same signal path (CI-V `1A 05 00 60`/`00 65`,
  "AF output level to ACC/USB"/"MOD input level from USB" — see
  `docs/civ-notes.md`, and `CIV_MAXIMIZE_USB_LEVELS` above to disable
  just that half). A real caveat either way: 100% capture/level risks
  clipping on transmit depending on your radio's own input sensitivity,
  worth checking your actual TX audio quality.

## WebSocket protocol

Plain JSON text frames carry the control protocol; binary frames carry
audio and scope data (tagged, see `docs/ui-notes.md`), multiplexed on the
same connection. See `src/server/protocol.js` for the full JSON message
shapes.

- **Control (JSON, text frames)**: requests (`getFrequency`,
  `setFrequency`, `getMode`, `setMode`, `setDataMode`, `getDataMode`,
  `setPtt`, `getSMeter`, `getSWR`,
  `setScopeBand`, `setScopeSpan`, `setPreamp`, `getPreamp`,
  `setNoiseReduction`, `getNoiseReduction`, `setNoiseBlanker`,
  `getNoiseBlanker`, `setNotch`, `getNotch`, `setFilter`, `getFilter`,
  `setTuner`, `getTuner`, `setTxPower`, `getTxPower`, `setRxGain`,
  `getRxGain`, `setFt8Active`, `sendFt8`)
  correlated by `id`; events (`connected`, `frequency`, `mode`, `data-mode`, `ptt`,
  `ptt-timeout`, `cw-text`, `ft8-decodes`, `ft8-tx-status`, `rig-error`,
  `audio-error`, `scope-error`)
  broadcast without an `id`. `setFt8Active` arms/disarms RX decoding
  (sent when the client opens/closes the FT8 panel); `sendFt8`
  (`{message, freqHz?}`) queues a message for transmission at the next
  15-second slot boundary and returns immediately — the actual outcome
  (including the actual `freqHz` transmitted at) arrives later as an
  `ft8-tx-status` broadcast (`scheduled` → `sending` → `sent`/`error`).
  The optional `freqHz` targets a specific audio frequency instead of the
  server's own default — used by the guided QSO sequencer (see above) so
  a reply goes out at the frequency the other station is actually
  listening on, rather than always this app's one fixed calling
  frequency. See `src/server/protocol.js` for the exact
  `ft8-decodes`/`ft8-tx-status` payload shapes.
- **Audio (binary frames, tagged `BINARY_TYPE.AUDIO`)**: by default
  (`AUDIO_CODEC=pcm`), raw 16-bit PCM in both directions — no
  framing/codec requirement, chunk sizes are whatever arrives. With
  `AUDIO_CODEC=opus` (not used by the shipped client, see
  `docs/audio-notes.md`), each frame's payload is one Opus packet
  instead, and *does* require exact frame-size PCM in/out — see
  `src/audio/opus-codec.js`.
- **Scope (binary frames, tagged `BINARY_TYPE.SCOPE_LINE`,
  server→client only)**: one reassembled spectrum line per frame — see
  `src/server/scope-bridge.js` for the exact header format.

Note: every connected client currently has equal, unrestricted control,
including sending TX audio — there's no access arbitration (e.g. locking
out other clients while one is transmitting, or preventing two people's
mic audio from being decoded and played simultaneously, which will
produce garbled TX audio). Worth keeping in mind if more than one
operator will use this concurrently; not addressed by the current
phases.

On the Pi, the radio's USB CI-V serial device typically shows up as
`/dev/ttyUSB0` or `/dev/ttyACM0` — check `dmesg` after plugging in, or
use a udev rule to get a stable name if you have other USB-serial
devices attached.

## Design notes

- CAT control happens **server-side** (Node `serialport`), not via the
  browser's Web Serial API — this keeps client browser support universal
  (Safari/Firefox/iOS included) and avoids needing the browser tab
  physically at the radio.
- Audio in/out uses the radio's USB audio codec (present on IC-7300,
  IC-9700, IC-705, IC-7610, etc.) via ALSA on the Pi — no separate sound
  card or virtual audio cable needed.
- Remote-over-internet access is intentionally out of scope for this
  app; it's expected to be layered on separately via VPN.

See `docs/civ-notes.md` for CI-V protocol specifics.

## Licence

AGPL-3.0-only (see `LICENSE`).

Every other dependency this project uses (`ws`, `serialport`,
`opusscript`, `socket.io-client`) is permissively licensed, and the
project itself started
under a permissive licence. FT8 support changed that first: it uses
[`@e04/ft8ts`](https://www.npmjs.com/package/@e04/ft8ts), a pure-TypeScript
port of WSJT-X's own FT8 encoder/decoder, which is GPL-3.0 (as is
WSJT-X itself). Linking a GPL-3.0 dependency into the app means the
combined work is a derivative work under copyright law, so at that
point the whole project became licensed GPL-3.0-or-later, not just the
FT8-related files — a deliberate, informed choice (the alternative would
have been porting an FT8 codec from C by hand to avoid the dependency,
which wasn't worth it for what's gained).

The "CW 3" decoder (`src/audio/deepcw-decoder.js`, see the CW decoder
section below) moved the licence again, from GPL-3.0-or-later to
**AGPL-3.0-only**. It bundles the model and metadata from
[`e04/deepcw-engine`](https://github.com/e04/deepcw-engine)
(`models/deepcw/` — see the `NOTICE.md` there), which is AGPL-3.0-only.
GPLv3 §13 and AGPLv3 §13 contain a reciprocal permission for combining a
GPLv3 work with an AGPLv3 work into one combined work, with the
combination as a whole then governed by AGPLv3 — including its §13
network-interaction clause: anyone who interacts with a running PiRO
instance over the network is entitled to the corresponding source. Since
PiRO is a network service by design, that requirement is real, not
theoretical — set the `SOURCE_CODE_URL` env var to wherever you host
your copy of this repository (a fork, a tarball, whatever satisfies
"corresponding source" for your actual running version) and the app's
own UI footer shows a "Source" link to it for every connected client;
see `server/index.js`'s `SOURCE_CODE_URL` handling and
`docs/ui-notes.md`.

The "HamNoise" toggle (see "Rig control UI" above) bundles a second
AGPL-3.0 dependency alongside DeepCW's: the prebuilt WASM binaries from
[`e04/HamNoise`](https://github.com/e04/HamNoise) (`models/hamnoise/` —
see the `NOTICE.md` there), same author and licence as `deepcw-engine`
above. This doesn't change the project's overall licensing conclusion —
PiRO was already AGPL-3.0-only because of the DeepCW bundle — but if
you're leaving "CW 3" out per the paragraph below, leave `models/hamnoise/`
and `src/audio/hamnoise-filter.js` out too, for the same reason.

If you're integrating pieces of this codebase elsewhere and can't accept
copyleft terms, the FT8 feature (`src/audio/ft8-bridge.js`,
`src/audio/ft8-decode-worker.js`, the FT8-specific client UI), the
"CW 3" decoder (`src/audio/deepcw-decoder.js`, `models/deepcw/`, the
decoder-variant plumbing in `cw-decoder-bridge.js` that's specific to
it), and the "HamNoise" denoiser (`src/audio/hamnoise-filter.js`,
`models/hamnoise/`, the HamNoise-specific wiring in `audio-bridge.js`) are
the parts to leave out — everything else here was written for
this project under no such constraint. Leaving out "CW 3"/HamNoise and
keeping FT8 would still leave the project at GPL-3.0-or-later, not
AGPL-3.0; leaving out all three would allow a permissive relicensing of
the remainder, same as before FT8 was added.

### Third-party components that are not bundled

- **RNNoise** (BSD-3-Clause) is not in this repository. You build it yourself
  (see [RNNoise](#rnnoise-rnn-button)). The one file included,
  `third_party/rnnoise/rnnoise_demo.c`, is RNNoise's example program with the
  `wet` patch, and keeps its original copyright and licence header.
- **rade_c** (FreeDV RADE) is built and installed separately, under its own
  licence.

If you publish a fork, set `SOURCE_CODE_URL` to it, so the footer link points
to the source of the version that is actually running.
