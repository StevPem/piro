# PiRO

PiRO is a web app for remote control of an Icom transceiver. It runs as one
Node.js service on a Raspberry Pi (or any small Linux machine) that is
connected to the radio by USB. You open it in a browser on your network and
get frequency, mode and PTT control, RX/TX audio, a spectrum scope and
waterfall, and a set of digital-mode and noise-reduction tools. It needs no
Hamlib, no separate audio server and no extra apps.

![PiRO screenshot](https://raw.githubusercontent.com/StevPem/piro/refs/heads/main/gallery/piro.png)

Written by VK3TR. Licensed AGPL-3.0-only (see
[Licence](#licence)).

**Current build: v119.** This is the version the app shows next to its title.
It is the `CACHE_NAME` number in `src/client/sw.js`, which goes up with every
change to the web app.

This README has two parts:

- **[Part 1: For radio operators](#part-1-for-radio-operators)**: what
  PiRO is and does, how to install it, and how to use each mode.
- **[Part 2: For developers](#part-2-for-developers)**: how PiRO is built,
  its parts, the WebSocket protocol, and the tests.

[Credits](#credits) and the [Licence](#licence) are at the end.

## Warning!
Note that it DOES NOT include any form of login or password - so don't present it to the big bad internet or some rando will start controlling your rig! Always put it behind a firewall or VPN.

---

## Part 1: For radio operators

1. [What PiRO does](#what-piro-does)
2. [What you need](#what-you-need)
3. [Installing PiRO](#installing-piro)
4. [Running PiRO as a systemd service](#running-piro-as-a-systemd-service)
5. [Optional components](#optional-components) (RNNoise, HamNoise, DeepCW, FreeDV RADE)
6. [Using PiRO](#using-piro): the screen, sharing the radio, voice, CW,
   the text modes, FT8 and FT4, WSPR, FreeDV, the picture modes
7. [Configuration reference](#configuration-reference)
8. [Updating](#updating)
9. [Troubleshooting](#troubleshooting)
10. [Hardware diagnostics](#hardware-diagnostics)

### What PiRO does

- **Rig control** over CI-V: frequency, mode, band, filter, PTT, TX power,
  S-meter, SWR and more.
- **Audio** both ways in the browser, using the radio's built-in USB sound
  codec through ALSA. Compressed audio (Opus, about 24 kbit/s each way)
  for use away from home over a VPN or mobile data. See
  [Compressed audio for remote use](#compressed-audio-for-remote-use).
- **Spectrum scope and waterfall** from the radio's CI-V scope data (opt-in).
- **A CW decoder** (DeepCW, a neural decoder) and an RTTY decoder.
- **RTTY, JTTY, Olivia and Feld-Hell**: one "TTY" button selects RTTY, then
  cycles through [JTTY](https://wsjt.sourceforge.io/) (WSJT-X's new text
  mode), [Olivia 8/250](https://en.wikipedia.org/wiki/Olivia_MFSK) (the
  robust MFSK keyboard mode) and
  [Feld-Hell](https://en.wikipedia.org/wiki/Hellschreiber) (text sent as a
  picture), all ported to JavaScript here and the last two compatible with
  fldigi. In all four, a text box and a Send button replace PTT; received
  text is decoded as it arrives, or for Feld-Hell painted in the scope and
  read from the picture as text. See
  [RTTY, JTTY, Olivia and Feld-Hell](#rtty-jtty-olivia-and-feld-hell).
- **VARA chat**: the TTY button's fourth choice is a VARA HF modem for
  keyboard QSOs with VARA Chat and VarAC users. It runs
  [Xara](https://github.com/x0rro/xara), an open-source VARA-compatible
  modem, on the Pi. See [VARA chat](#vara-chat).
- **EasyPal**: the Image button's second choice receives digital SSTV
  pictures sent by EasyPal or QSSTV (HamDRM), with Reed-Solomon recovery
  of lost segments, and sends a photo from the phone's camera or a chosen
  picture. See [EasyPal](#easypal).
- **Radiofax**: the Image button's third choice receives HF weather
  charts, such as the Bureau of Meteorology's VMC (Charleville) and VMW
  (Wiluna) broadcasts, drawn in place of the spectrum as they arrive. See
  [Radiofax](#radiofax).
- **SSTV** (the Image button): receive pictures in 25 modes (Martin, Scottie, Robot, PD,
  Wraase, Pasokon), recognised automatically from their VIS header, drawn as
  they arrive and then slant-corrected, with a strip of recent pictures to
  view full size or save; and send a photo from the phone's camera or an
  image file, cropped and tagged with your callsign, followed by an FSK ID
  and a CW ID. See [SSTV](#sstv).
- **FT8**: band-activity decoding, manual TX, and a guided QSO sequence that
  suggests each reply (you still send every message yourself), and a chime
  when someone calls you. Optional PSK Reporter spotting.
- **WSPR** (the third choice of the DIGI button, after FT8 and FT4): receive
  and transmit, with the decoder ported to JavaScript from WSJT-X's wsprd.
  Spots go to [wsprnet.org](https://www.wsprnet.org). It can also receive
  on its own when nobody is connected. See [WSPR](#wspr).
- **Current conditions**: a link beside "Band" opens a table that rates
  each band Great to Dismal for your station (from WSPR spots PiRO decoded)
  and for your local area (from wsprnet.org spots of WSPR reporters around
  your grid). See [Current conditions](#current-conditions).
- **FreeDV RADE** digital voice, with optional reporting to the
  [FreeDV Reporter](https://qso.freedv.org) map.
- **A noise reducer for received audio**: "HamNoise" (a neural denoiser
  trained on HF signals). RNNoise is also supported but hidden for now.
- **A voice squelch** for SSB, AM and FM: mutes the hiss between overs by
  listening for the pitch of a voice, so it needs no level setting and
  ignores carriers and static crashes. See [Voice squelch](#voice-squelch).

PiRO is made for Icom radios with a USB CI-V port and USB audio codec. The
CI-V address table covers the IC-7300, IC-7610, IC-9700, IC-705, IC-7100,
IC-7850 and IC-7851, and `IC-7300` is the default model. Spectrum-scope
behaviour varies by radio and firmware (see `docs/civ-notes.md`).

### What you need

| | |
|---|---|
| Computer | A Raspberry Pi 3, 4, 5 or Zero 2 W, or any Linux machine. Use a **64-bit** OS: the CW 3 decoder needs `onnxruntime-node`, which has no 32-bit ARM build. |
| OS | Raspberry Pi OS or Debian 12 "Bookworm" or newer. Other distributions work if you adjust the package names. |
| Node.js | 18 or newer. 20 or 22 is recommended. |
| Radio | An Icom transceiver connected by USB. The one cable gives a CI-V serial port and, on most models, a USB audio codec. |
| System packages | `alsa-utils` (audio), `git`. `build-essential` and `python3` are only needed if `npm install` has to compile the serial-port module itself. |
| Accurate clock | FT8 works in UTC 15-second slots, so the clock must be right. Raspberry Pi OS runs `systemd-timesyncd` by default. A Pi has no battery clock, so it needs the network at boot. |

### Installing PiRO

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
git clone https://github.com/StevPem/piro.git ~/PiRO
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

The radio's CI-V port usually shows up as `/dev/ttyUSB0` or
`/dev/ttyACM0`. Check `dmesg` after plugging it in. If you have other
USB serial devices, a udev rule gives the radio a name that never
changes.

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

### Running PiRO as a systemd service

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

### Optional components

PiRO works with just the steps above. Each feature in this section needs
something extra, and each one switches itself off cleanly (the button does
nothing and an error is shown) if its part is missing.

| Feature | What it needs | Where |
|---|---|---|
| CW decoders, RTTY, FT8, scope, "HamNoise" button | Nothing extra: they are bundled and installed by `npm install` | |
| "CW 3" decoder (DeepCW) | The bundled model and `onnxruntime-node` (installed by `npm install`) | [DeepCW](#deepcw-cw-3-decoder) |
| "RNN" button (hidden for now) | A patched `rnnoise_demo` that you build | [RNNoise](#rnnoise-rnn-button) |
| FreeDV RADE mode | `rade_c` built and installed | [FreeDV RADE](#freedv-rade) |

#### RNNoise ("RNN" button)

**Hidden for now.** The RNN button is not shown in the app (since v84);
the server's RNNoise support is unchanged. To show it again, set
`RNNOISE_IN_UI` to `true` near the top of the RNN section in
`src/client/app.js`. The rest of this section describes it when shown.

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

#### HamNoise ("HamNoise" button)

[HamNoise](https://github.com/e04/HamNoise) is a neural denoiser trained on HF
signals, with separate CW and voice models. Its WebAssembly models are
bundled in `models/hamnoise/`, so there is nothing to install. PiRO picks the
CW or voice model to match the radio's mode. It is switched on with the
"HamNoise" button after "NR" (or under "RNN" when that is shown; the two are
mutually exclusive).

HamNoise has two model generations. PiRO defaults to `classic`, which is light
enough for a Raspberry Pi. HamNoise's own newer `v2` models use roughly 36 to
53% of real time on a fast PC, and a Pi cannot keep up with them: the server
pins at 100% CPU. Set `HAMNOISE_QUALITY=v2` only on hardware that you have
tested.

In the author's testing, HamNoise helps on moderate signals (around S4 and up) where
RNNoise, which was trained on general speech noise rather than HF noise, is
more likely to mute them.

#### DeepCW ("CW 3" decoder)

The model is bundled in `models/deepcw/` and runs in Node through
`onnxruntime-node`, which `npm install` fetches. It needs a 64-bit OS on a Pi.
If `onnxruntime-node` cannot load, the "CW 3" decoder is unavailable, and
since v84 that is the only CW decoder the app shows. The other two still
work: show them again with `CW_DECODERS_IN_UI` (see the CW section).

#### FreeDV RADE

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

### Using PiRO

Open `http://<pi-hostname-or-ip>:8080` (or `https://` if you set up a
certificate) in a browser. A phone works well. You can add PiRO to the
home screen: see `docs/pwa-notes.md`.

#### The screen

From the top:

- **Connected (2)**, at the top right: whether this browser is connected
  to PiRO, and how many browsers are connected now, yours included.
- **Frequency.** Tap it to type a new one, in MHz. The **−10**, **−1**,
  **+1** and **+10** kHz buttons step it. It is shown in groups, like
  14.195.000.
- **Band**: 160 m to 6 m. In the digital and picture modes a band button
  goes to that mode's usual frequency on the band (see each mode below).
  **Current conditions**, beside "Band", opens the band conditions table
  (see [Current conditions](#current-conditions)).
- **Mode**: two rows of four.
  - **SSB**, **AM**, **FM** and **CW** are the radio's own modes. SSB picks
    the usual sideband (LSB below 10 MHz, USB above). Press it again to
    swap sidebands. It reads **LSB** or **USB** while selected.
  - **TTY** steps through RTTY, JTTY, Olivia, VARA and Feld-Hell.
  - **DIGI** steps through FT8, FT4 and WSPR.
  - **FreeDV** is RADE digital voice.
  - **Image** steps through SSTV, EasyPal and Radiofax.

  Each button shows the mode it is in.
- **Receive buttons**: **P.Amp** (Off, 1, 2), **NR**, **Notch** and
  **Filter** (1, 2, 3). Each press steps to the next setting. Below them
  are **HamNoise** (see [HamNoise](#hamnoise-hamnoise-button)) and
  **Squelch** (see [Voice squelch](#voice-squelch)).
- **Meter.** Tap its title to choose what it shows: **S-meter**, **SWR**
  or **ALC**, then round again. The labels under the bar change to match.
  Each browser remembers its own choice.
  - **S-meter**: S0 to S9, then +10 to +60 dB (red over S9). While you
    transmit it shows SWR instead, as the S-meter reads nothing then.
  - **SWR**, while you transmit: 1.0 to 5.0, green up to 1.5, amber to 3,
    red above. On receive it says "on transmit".
  - **ALC**, while you transmit: the radio's ALC meter as a percent of its
    scale (CI-V reports 0 to 120). Use it with **Mic** to set your drive.
    On receive it says "on transmit". Not yet checked against the radio's
    own ALC meter.
- **The controls row**: **Speaker**, **Audio**, **Tuner**, **Tune**, **Mic**
  and **Power**, on one line. Each shows its name small above its setting.
- **Speaker** starts the received audio. Browsers only play sound after a
  tap, so it starts off. **Audio** picks full or compressed audio for this
  browser (see [Compressed audio for remote use](#compressed-audio-for-remote-use)).
- **Tuner** turns the antenna tuner on and off. **Tune** starts one tune.
- **Mic**: microphone gain for this browser, +20 dB to −20 dB (0 dB to
  start). Shown whenever the PTT button is. Microphones differ a lot
  between phones, laptops and headsets, so each browser has its own
  setting and remembers it. It changes only your voice from this
  browser's microphone (including FreeDV), not the digital modes, whose
  audio is made on the Pi. Above about 80% of full scale, peaks are
  rounded off rather than clipped hard. Watch the **ALC** meter while you
  talk to set it. Not tested on air.
- **Power**: 100, 75, 50, 25 or 5 W (1 to 5 W in WSPR).
- **Spectrum scope and waterfall**, if `CIV_SCOPE_ENABLED=true` and your
  radio sends scope data. It stays centred on your frequency. **Scope
  Span** sets its width, 2.5 to 500 kHz (100 kHz to start). Tap the trace
  or the waterfall to tune there: to the nearest kHz, or exactly in CW and
  RTTY. The **RX Gain** slider (0 to 255) is on the right. In the digital
  and picture modes the scope shows the 0 to 3 kHz audio from the radio
  instead, like WSJT-X's waterfall.
- **PUSH TO TALK**: hold the button, or hold the Space bar. The microphone
  needs HTTPS (see [Installing PiRO](#installing-piro)). In CW and in the
  text modes the PTT button is replaced (see below).
- **Notes**, under PTT, for messages to the other operators (see below).

The buttons show what the radio is really set to, including changes made
on its front panel. On HTTPS the page also keeps a phone's screen on, so
it doesn't lock while you listen.

**The 10-minute limit.** PiRO stops any transmission that has gone on for
10 minutes. The Australian class licence requires this for remotely
controlled stations. The server does it, so it works even if your browser
crashes or the network drops. Modes that transmit without PTT (CW text,
for example) have their own limits.

#### Sharing the radio

Several people can have PiRO open at once, on any device. The number in
brackets after **Connected**, at the top right, is how many browsers have
it open now, yours included.

- Every browser shows the same radio settings and the same mode. Pick SSTV
  on one phone and the others switch to SSTV too. A browser opened later
  starts in the same mode. What you are typing, and an FT8 QSO you are
  working, stay in your own browser.
- Everyone has the same control. Nothing stops two people transmitting at
  once, and two microphones at once garble the audio. Agree who has the
  radio: the notes help.
- When the last browser closes, PiRO stops any transmission and the
  receivers. Phones disconnect often, so don't rely on a page staying open.

**Notes.** Under the PTT button is a box for short notes to the other
people using the radio, for example "VK3ABC: on 40 m FT8 until 16:30" or
"can I have it after the net?". Type one and press Enter or Send; it
appears in every browser with the time, and the three most recent are
shown, newest first. In the other browsers a new note plays a short chime
and flashes the screen once (on a device set to reduce motion, only the
notes light up). Opening or reconnecting PiRO makes no sound. Nobody signs
in, so put your callsign in the note. The notes are kept on the Pi (a
browser opened later sees them) and cleared after an hour with no new
note, or two minutes after the last browser closes. Browsers only play
sound once the page has been tapped, and a phone that is locked or has the
browser in the background usually won't chime at all.

#### Voice: SSB, AM and FM

Pick **SSB**, **AM** or **FM**, tap **Speaker**, and use **PUSH TO TALK**.
The microphone needs HTTPS. Set **Mic** so your audio drives the radio
properly: tap the meter's title until it says **ALC**, then talk and watch
it.

PiRO sets the radio's USB audio levels to maximum when it starts, both in
Linux and in the radio (`CIV_MAXIMIZE_USB_LEVELS=false` leaves the
radio's alone). Check your transmit audio: on some radios full level may
be too much.

Two things help with a noisy band:

- **HamNoise** cleans up the received audio with a neural network trained
  on HF signals. It picks a CW or a voice model to suit the mode. See
  [HamNoise](#hamnoise-hamnoise-button).
- **Squelch** mutes the hiss between overs. See below.

Neither changes what the decoders hear: they always read the radio's own
audio.

##### Voice squelch

The **Squelch** button (beneath HamNoise) mutes the hiss between overs in
SSB, AM and FM. It is one setting for everyone, like HamNoise.

The radio's own squelch opens on level, so on HF it needs resetting as
the noise changes, and it opens on carriers and static crashes. PiRO's
listens for the pitch of a voice instead: the envelope of speech repeats
80 to 300 times a second as the voice's pitch wanders. Noise, a steady
carrier, CW and static don't do that, and two carriers beating together
do it at a pitch that never moves.
- It opens within about 0.2 s of a voice starting, and plays the audio
  0.3 s behind so the start of the over isn't lost.
- It stays open for 1.5 s after the voice stops, so it doesn't chop
  between words.
- In testing it opened on a synthetic voice 3 dB below the noise (in the
  receiver's bandwidth) and stayed shut at 10 dB below. Very weak stations may
  stay muted: switch it off for them.
- A new pair of carriers can open it for about a second before it works
  out they are a tone.
- In CW, with DATA mode on, or in FT8, FreeDV and the other digital modes,
  the button says **Paused** and all the audio passes.
- With HamNoise on, it judges HamNoise's cleaned-up audio.
- The decoders never see it: they read the radio's audio directly.
- Between overs nothing is sent to the browsers, which saves data on a
  phone.

It was tuned on a real 285 s recording of an SSB contact (with a weak
station, static crashes and AGC) and on synthetic audio. Not yet tried on
the air with PiRO; the Pi's CPU use is estimated from a desktop (about 2%
of a core there).

##### Compressed audio for remote use

Full audio is raw 16-bit PCM: about 770 kbit/s each way at 48 kHz. That
is fine at home, but too much for most mobile data or a slow VPN. The
**Audio** button beside Speaker switches this browser between:
- **Audio: full**: raw PCM, as before.
- **Audio: Opus**: Opus at about 24 kbit/s each way (`AUDIO_OPUS_BITRATE`),
  16 kHz audio. The browser uses its built-in codec (WebCodecs): Chrome,
  Edge, Samsung Internet, Firefox on a desktop, and Safari 26 or later.
- **Audio: ADPCM**: 12 kHz ADPCM at 48 kbit/s, in plain JavaScript, for
  browsers without WebCodecs Opus (Firefox on Android, older Safari). A
  browser that can play Opus but not record it receives Opus and sends
  ADPCM; the button's tooltip says which.

Each browser chooses for itself, so a phone away from home can use Opus
while a tablet at home stays on full audio. A page opened by a home
address (192.168.x.x, 10.x.x.x, 172.16-31.x.x, `localhost`, a `.local` or
`.lan` name, or a name with no dots, like `piro`) starts on full audio;
any other address (a VPN such as Tailscale, or a domain name) starts
compressed. A choice made with the button is remembered by that browser.

Compressed audio plays 0.2 s behind, so short network delays don't break
it up. On any audio, if more than half a second more than that builds up
(after the network stalls), the backlog is skipped.

The decoders (FT8, CW, RTTY and the rest) always work from the radio's
full-quality audio on the Pi, whatever the browsers receive. Compression
only affects what you hear and what your microphone sends. Not tested on
air: speech sent compressed from a phone has not been checked on a real
transmission.

#### CW

In **CW** the PTT button becomes a CW panel.

**Paddle.** **DOT** and **DASH** work as an iambic paddle, at the speed in
the **WPM** box (15 to start). Each element is sent as PTT on and off over
the network, so the timing is looser than a real keyer, more so at higher
speeds. For accurate sending, use CW text.

**CW text.** Above the Dot/Dash buttons is a text box and **Send**. Type a message (or use the CQ it starts with) and press Send or
Enter: PiRO hands the text to the radio's own CW keyer (CI-V command `17`),
which sends it at the speed in the **WPM** box (6–48 WPM on the radio's
keyer). Because the radio does the keying, the timing is exact at any
speed, unlike the paddle. For each message PiRO:

* checks that the radio is in CW or CW-R;
* sets the keyer to the WPM box's speed;
* turns semi break-in on if it was off (the radio only transmits CI-V CW
  with break-in on);
* gives the keyer the text 30 characters at a time, retrying while the
  radio's buffer is full;
* waits until the radio has finished transmitting, then puts the keyer
  speed and break-in back as they were.

Send turns into **Stop** while it goes out, which stops the radio's keyer
at once. Every browser sees the progress. Letters, digits and
`/ ? . , : ' ( ) = + " @ -` can be sent; `^` joins the next two letters
into one prosign (`^AR`, `^SK`), as on the radio's own keyer memories.
Anything else is left out, and the status line says what was dropped.
Messages are limited to 300 characters and under 9 minutes. PTT isn't used,
so the 10-minute PTT cut-off doesn't apply; the length limit stands in for
it. Not yet tested on air.

**CW decoder.** In CW, a ticker under the S-meter shows the CW PiRO
decodes from the received audio. It uses DeepCW, a neural decoder, which
works on 5 to 20 s of audio at a time, so text arrives in bursts every few
seconds. Like any CW decoder it does well on clean signals and less well
on weak or noisy ones. It needs `AUDIO_RX_DEVICE` and a 64-bit OS on a Pi
(see [DeepCW](#deepcw-cw-3-decoder)). Two older decoders are still there
but hidden; see [CW decoders](#cw-decoders) in Part 2.

#### RTTY, JTTY, Olivia and Feld-Hell

The **TTY** button steps through five text modes:

1. The first click selects the radio's RTTY mode, and the button now reads **RTTY**.
   Selecting RTTY also tunes to the middle of the band's digital-modes segment
   in the WIA band plan (e.g. 14.091 MHz on 20 m; see the table below), and band
   buttons then do the same.
2. The next click switches to **JTTY**, and the button reads **JTTY**.
   Entering JTTY also tunes to the standard JTTY dial frequency for the current
   band (e.g. 14.090 MHz on 20 m; the list is the WSJT-X 3.3 beta's and is marked
   preliminary), and band buttons then go to each band's JTTY frequency.
3. The next click switches to **Olivia** (Olivia 8/250), and the button reads
   **Olivia**. Entering Olivia tunes to the band's Olivia calling frequency
   (e.g. 14.0715 MHz dial on 20 m), and band buttons then go to each band's.
4. The next click switches to **VARA** (see [VARA chat](#vara-chat)), and
   the button reads **VARA**. Entering VARA tunes to the band's VarAC
   calling frequency (14.105 MHz dial on 20 m).
5. The next click switches to **Feld-Hell**, and the button reads
   **Feld-Hell**. Entering Feld-Hell tunes so a signal on the band's Feld-Hell
   frequency (e.g. 14.063 MHz on 20 m) comes out at the audio tone (dial
   14.062 MHz with the default 1000 Hz tone), and band buttons then go to
   each band's.
6. The next click goes back to **RTTY**, and so on round.
7. Picking any other mode (LSB, USB, AM, FM, CW, FT8, FreeDV) puts the button
   back to **TTY**.

While a TTY mode is selected, a text box and a **Send** button replace the
PTT button (in VARA, Send works only during a QSO). Enter in the text box also sends. While a message is going out,
Send turns into **Stop**, which cuts the transmission short and releases PTT.
The Space bar does not key the microphone in these modes. The text box starts
with a CQ built from `STATION_CALLSIGN` (if set), and keeps whatever you
type when you switch between the modes.

**RTTY band frequencies.** RTTY has no calling frequencies, so PiRO starts
you in the middle of each band's narrowband digital segment from the WIA's
band plan (the WIA Technical Advisory Committee's
[HF digimodes paper](https://www.wia.org.au/members/bandplans/data/documents/TAC%20Band%20Plans%20-%20HF%20Digimodes%20170103.pdf)),
to tune around from. The radio's RTTY mode displays the mark frequency.

| Band | WIA digital segment (MHz) | PiRO tunes to (MHz) |
|---|---|---|
| 160 m | 1.800–1.810 | 1.805 |
| 80 m | 3.620–3.640 | 3.630 |
| 40 m | 7.040–7.060 | 7.050 |
| 30 m | 10.130–10.140 | 10.135 |
| 20 m | 14.070–14.112 | 14.091 |
| 17 m | 18.100–18.110 | 18.105 |
| 15 m | 21.070–21.125 | 21.0975 |
| 12 m | 24.920–24.930 | 24.925 |
| 10 m | 28.050–28.150 | 28.100 |

6 m has no segment in the paper, so its band button works as usual. The same
paper proposes moving 80 m to 3.570–3.600 MHz (where most of the world's
80 m RTTY is) and widening the 30, 17, 15, 12 and 10 m segments; the table is
`RTTY_FREQUENCIES` in `src/client/app.js` if the plan changes. Busy RTTY is
often elsewhere in the segment (on 20 m, 14.080–14.099), and keep clear of
the beacons at 14.100, 18.110, 21.150 and 24.930 MHz.

**RTTY** sends your text as audio-frequency-shift keying (AFSK): 45.45 baud,
170 Hz shift, with mark always the **higher** of the two RF frequencies, as
RTTY convention requires. The radio's own RTTY mode does not transmit audio
from USB (it keys FSK from its RTTY keying line, so on its own it would just
send a steady carrier). So when you press Send in RTTY, PiRO:

1. reads the frequency the radio shows in RTTY mode, which is the mark frequency;
2. switches to **LSB** with DATA MODE on below 10 MHz, or **USB** with DATA
   MODE on from 10 MHz up, and moves the dial so the mark lands exactly on
   that frequency;
3. keys PTT and plays the tones (on LSB, mark 2125 Hz and space 2295 Hz audio,
   dial 2125 Hz above the mark; on USB, mark 2295 Hz and space 2125 Hz audio,
   dial 2295 Hz below the mark; either way space ends up 170 Hz below mark);
4. puts the radio back in RTTY mode, with its filter, on the mark frequency.
   This also happens if you press Stop or something goes wrong.

The page keeps showing RTTY and the mark frequency throughout, and the status
line says which sideband was used. The "Reverse" tick-box swaps mark and space
for transmit as well as receive, and the radio's RTTY-R mode is kept reversed.
As with FT8, the IC-7300's DATA MOD setting must be USB for the audio to reach
the transmitter. Tested against PiRO's own decoder and a stub radio, not on air.

**RTTY receive.** In RTTY, a ticker under the S-meter shows the RTTY
decoded from the received audio. The scope marks the space tone with a
blue dashed line 170 Hz below your frequency. If a signal decodes as
nonsense, tick **Reverse**: RTTY stations don't all use the same polarity.

**JTTY** is a mode from WSJT-X 3.3 (beta): 4-tone Gaussian FSK at 31.25 baud,
no time slots, one to sixteen 1.9-second frames per message, with strong
error correction (a K=10 convolutional code and a CRC). Text is packed into
the fewest frames, so "CQ VK3TR CQ" takes one frame while free text takes
one frame per five characters. A message can be up to 80 characters. Selecting
JTTY puts the radio on USB with DATA MODE on, as FT8 does. Transmission starts
the moment you press Send, with the lowest tone at `JTTY_TX_FREQ_HZ` (1450 Hz
by default, so the signal sits around 1500 Hz). The **TX freq** box above the
text field sets the frequency for the next message.

**JTTY receive.** While JTTY is selected, a table under the composer lists
messages as they are decoded: UTC time, audio frequency, SNR and text. A line
shows in amber and grows frame by frame while the message is still arriving;
a lost frame shows as " ... ". The spectrum scope switches to the same 0-3 kHz
audio spectrum FT8 uses, with an amber marker at your transmit frequency;
click the spectrum, or tap a decoded line, to move that frequency onto a
station. Decoding happens on the Pi in a worker thread and
only runs while JTTY is selected and you are not transmitting. It searches
`JTTY_RX_LOW_HZ`..`JTTY_RX_HIGH_HZ` (by default the whole 200-2900 Hz
passband) plus two fixed channels around 1350 and 1650 Hz. The default `economy` effort keeps the load low on a Raspberry Pi 4;
see `JTTY_RX_QUALITY`.

The encoder and decoder are JavaScript ports of WSJT-X's; see
[`third_party/jtty/README.md`](third_party/jtty/README.md) for what was ported
and how both were checked against WSJT-X's own programs. The receiver is not
tested over the air, and, as with WSJT-X itself, noise can occasionally
produce a false decode.

**Olivia** is the 8-tone, 250 Hz-wide variant of
[Olivia MFSK](https://en.wikipedia.org/wiki/Olivia_MFSK), the most common
starting point on HF: 31.25 baud, each block of 64 symbols carrying three
characters with strong error correction, so text goes at about 1.5
characters a second and copies at around −14 dB S/N. It is compatible with
fldigi's Olivia 8/250. Selecting Olivia puts the radio on USB with DATA MODE on,
as JTTY does. The **Centre** box sets the audio centre frequency (1500 Hz by
default, `OLIVIA_FREQ_HZ`) used both for sending and for receiving; click the
spectrum to move it. Like fldigi, PiRO starts every transmission with the
short start tones at the band edges and ends it with stop tones. A message
can be up to 300 characters (about 3.5 minutes on air). Characters 128-255 are
sent with fldigi's 8-bit escape, and characters beyond that as ".".

**Olivia receive.** While Olivia is selected, the panel under the S-meter
shows received text as a running transcript, with your own transmissions
inline in amber, and a line giving the time, the S/N figure and how far the
signal is from the centre. The receiver searches 125 Hz either side of the
centre, so a station a little off frequency is still copied; **Tune to
signal** moves the centre onto it, so your reply goes out where that station
is. As with fldigi, text appears about four blocks (8 s) after it is sent,
because the receiver averages over several blocks before deciding.
Decoding runs on the Pi in a worker thread, only while Olivia is selected
and you are not transmitting.

PiRO filters out the junk characters fldigi prints with its squelch off, in
two ways. A block is only shown if its own S/N is strong enough, as well as
the averaged one, and blocks containing control codes that text never uses
are dropped. In testing that removed every false character from 1,000 s of
plain noise (fldigi printed 59 a minute) without losing any copy down to
−14 dB. A strong neighbouring Olivia signal just outside the search window
can still leave a stray character or two. Set `OLIVIA_SQUELCH=off` to get
fldigi's exact behaviour.

The Olivia modem is a JavaScript port of Pawel Jalocha's code in fldigi; see
[`third_party/olivia/README.md`](third_party/olivia/README.md) for what was
ported and how it was checked against a reference program built from
fldigi's own source. It has not yet been tested over the air.

**Feld-Hell** is the classic Hellschreiber mode: each character is drawn,
column by column, from a 7-dot-high font and sent by keying a single tone on
and off (17.5 columns a second, 122.5 baud, about 2.5 characters a second, a
signal some 350 Hz wide). There is no code to decode at the other end; the
receiver paints the tone as a picture and you read it, which is why
Feld-Hell copies through noise and fading that would garble a coded mode.
PiRO also reads the picture as text for you (see below).
Selecting Feld-Hell puts the radio on USB with DATA MODE on, as JTTY and
Olivia do. The **Tone** box sets the audio frequency (1000 Hz by default,
`HELL_TONE_HZ`), used both for sending and for receiving; click the spectrum
on a signal to move it there (to the nearest 10 Hz). Transmissions are sent
exactly as fldigi sends them, with its default font and 2 ms keying shape,
and begin and end with "...". A message can be up to 400 characters (under
three minutes); characters the font does not have are sent as a blank gap.

**Feld-Hell receive.** While Feld-Hell is selected, the scope's upper part
still shows the 0-3 kHz audio spectrum (with an amber marker at the tone),
but its waterfall becomes the received picture, scrolling in from the right
as it arrives. As in fldigi, each column is shown twice, one copy above the
other (the previous column under the current one): Feld-Hell has no synchronisation, so text drifts up or down the
picture, and this way a whole line of it is always in view. Text that slopes
means the other station's timing is slightly off; it is still readable.
The receiver listens about 150 Hz either side of the tone. It is cheap enough
to run on the Pi's main thread, and only runs while Feld-Hell is selected and
you are not transmitting.

**Feld-Hell text.** Below the picture, a **Feld-Hell text** panel shows what
PiRO reads from it. It matches the picture against the font fldigi (and
PiRO) send with, letter by letter, allowing for where each letter sits up or
down the picture and for slant, and prints what it reads about two seconds
behind the picture. Your own transmissions appear in amber, as in Olivia's
panel, and a browser opened later is sent the recent text. In tests through
PiRO's own transmitter and receiver, with random callsign-like text:

| Signal (S/N in 3 kHz) | 10 dB | 3 dB | 0 dB | −3 dB | −6 dB | −9 dB |
|---|---|---|---|---|---|---|
| Characters wrong | 0.6% | 0.3% | 1.3% | 5.5% | 33% | 95% |

Timing errors of ±0.1% (text sloping in the picture) make no difference.
To keep noise from being printed as letters, it waits for a run of good
matches before printing anything: no false characters were printed in five
minutes of noise alone. So on a weak signal it may print nothing, or only
part of it, while you can still read the picture. Trust the picture.

Limits:
* It only reads fldigi's default Feld-Hell font ("hell 12"). Another font,
  "wide" Hell (each column sent twice) or hand-sent Hell won't read.
* Several lower-case letters are drawn exactly like capitals in this font,
  so they read as capitals; the ones drawn differently (such as e and k)
  read as lower case.
* fldigi's opening "..." isn't printed: dots are too small to start the
  text, because noise fits them too easily. The closing "..." is.
* Deep fading loses the faded part, as it does for your eye.
* It costs a few percent of a Pi's CPU while Feld-Hell is selected. It has
  not yet been tested on real off-air signals.

The Feld-Hell modem is a JavaScript port of fldigi's; see
[`third_party/feldhell/README.md`](third_party/feldhell/README.md) for what was
ported and how the transmitter was checked against fldigi's own code. It has
not yet been tested over the air.

Transmit is refused if the radio is already transmitting. The usual PTT
watchdog (ten minutes) still applies.

#### VARA chat

**VARA** is the TTY button's fourth choice. It is the VARA HF modem that
[VARA Chat](https://rosmodem.wordpress.com/) and
[VarAC](https://www.varac-hamradio.com/) use for keyboard QSOs. PiRO runs
[Xara](https://github.com/x0rro/xara), an open-source modem compatible with
VARA HF, compiled to WebAssembly, on the Pi. Nothing else needs to be
installed.

VARA works differently from the other TTY modes. You connect to one
station, and the two modems then exchange frames: each frame is
acknowledged, and anything lost is sent again. Text arrives complete or not
at all. The modem keys the transmitter itself, for its own frames and its
acknowledgements.

Selecting VARA puts the radio on USB with DATA MODE on, and tunes to the
band's VarAC calling frequency. Band buttons then do the same. These are
VarAC's own frequencies, used worldwide; check that they suit the band plan
before you call.

| Band | Dial frequency, USB (MHz) |
|---|---|
| 160 m | 1.995 |
| 80 m | 3.595 |
| 40 m | 7.105 |
| 30 m | 10.133 |
| 20 m | 14.105 |
| 17 m | 18.107 |
| 15 m | 21.105 |
| 12 m | 24.927 |
| 10 m | 28.105 |
| 6 m | 50.330 |

**The VARA panel** (under the S-meter):

- **Status**, at the top right: "listening (500 Hz)", "calling VK3ABC…",
  or in a QSO the other station, the link's S/N, its speed and any text
  still to send. It also shows "transmitting" and "channel busy".
- **CQ** sends a short CQ frame with your callsign, on the calling
  frequency. VARA Chat and VarAC users who are listening see it and can
  connect to you there. (It names no slot, as a VarAC CQ does; see below.)
- **Callsign** and **Connect** call a station. While calling, Connect
  reads **Stop**; in a QSO it reads **Disconnect**.
- **QSYD** and **QSYU**, right of CQ, move 750 Hz down or up (one VarAC
  slot). Off the calling frequency, the status line says how far
  ("calling freq +1.5 kHz"). Outside a QSO they move your radio. In a QSO
  they ask the other station to move with you, as VarAC's QSY does (see
  below); they come on once the other station has said it is ready to QSY,
  and are off while a QSY is under way.
- **Heard** lists the stations heard calling CQ, and VarAC beacons,
  newest first. A VarAC CQ shows its slot ("F6JON +750"), a beacon reads
  "beacon". Tap one to put its callsign in the box; its tooltip gives the
  S/N and the time, and for a VarAC beacon its locator and what it offers
  (VMail, email, AI, BBS).
- **The conversation**: received text in white, your own in amber, and
  PiRO's notes about the link ("Connected to VK3ABC (500 Hz)") in grey.

In a QSO, type a line and press **Send** (or Enter).

**Answering a VarAC CQ.** VarAC sends its CQ on the calling frequency,
then waits for an answer about 2 minutes on a "slot": 750 to 3750 Hz above
or below. The slot is the CQ callsign's suffix: F6JON-11 is F6JON waiting
750 Hz up, -12 1500 Hz up and so on to -15; -1 to -5 are 750 to 3750 Hz
down; -9 is a beacon, not a CQ. PiRO reads this for you. Tap the CQ in
Heard, then **Connect**: PiRO moves to the slot and calls the plain
callsign (F6JON). When the QSO ends, or no one answers, it goes back to
where it was. After the 2 minutes the caller has left the slot, so Connect
then calls from the calling frequency instead.

**Talking to VarAC.** VarAC sends each message as its length, a space,
then the text in UTF-8, and puts tags in the text. PiRO does the same:
- On connecting, each side sends an opening report: "de VK2IO <R+05>", the
  S/N it hears the other at. PiRO sends yours, and shows theirs as "F6JON
  reports your signal at +5 dB".
- `VARA_NAME`, `VARA_QTH` and `STATION_GRID` (if set) follow it, as
  VarAC's name, QTH and locator.
- Tags the other station sends are put into words (name, QTH, locator,
  "is closing the QSO"); tags PiRO doesn't know are shown as they are.
- **Disconnect** first sends VarAC's goodbye (`<DISC>`), then ends the
  link once it has gone.
- **On the calling frequency** VarAC sends no reports. The station that
  was called says it is ready to QSY (`<Q>`, or `<AWQ>` if its operator
  is away), and the caller asks to move the QSO to a slot. PiRO does the
  same: called there, it sends `<Q>`. Calling there, once the other
  station is ready, it asks it to move by itself, as VarAC does: to the
  first slot (+750, −750, +1500, −1500 Hz … ±3750) that no VarAC CQ has
  been heard waiting on in the last 15 minutes. Once a QSY has finished
  (or failed), QSYD/QSYU ask for another.
- **QSY in a QSO** is VarAC's handshake. PiRO follows a request from the
  other station (`<QSYF>` with a frequency, or `<Q:225>`, i.e. +2250 Hz):
  once its modem has acknowledged it, the radio moves, waits for `<TL>`
  ("I've arrived"), replies `<QSYR>`, and each side sends its report on
  the new frequency. Asking works the other way round: `<Q:75>` (+750 Hz,
  the form stock VarAC sends), move once
  it has been delivered, `<TL>`, then wait for `<QSYR>`. Each step is given
  a minute; the status line shows how far it has got. A request for more
  than 4 kHz away isn't followed. When a QSO that was moved off the calling
  frequency ends, PiRO goes back to it, as VarAC does.
- **Beacons and notices:** VarAC's beacons, which carry the station's
  locator and what it offers, are listed in Heard and noted ("Beacon from
  OH8XAT (KP10RQ; offers VMail, email, AI, BBS)"). Its VMail notices are
  noted too ("OH8XAT has VMail waiting for HB9FIH").
- **Times:** everything heard outside your own QSO (CQs, beacons, VMail
  notices, broadcasts) starts with the UTC time it was heard, e.g.
  "12:15Z CQ from W7BTM (…)". Notes about your own link (Calling,
  Connected, QSY) and the chat itself have no time. PiRO can't collect
  VMail yet.
- A station that sends plain text instead (VARA Chat, probably) is shown
  as it comes, and from then on PiRO answers it in plain text too.

These formats come from [hfmodem](https://hfmodem.ssj.lol/) by Saul St
John, W9SSJ, which worked them out from recordings of VarAC on air. See
[`third_party/hfmodem/README.md`](third_party/hfmodem/README.md).

**PSK Spot.** The FT8 **PSK Spot** button is shown in VARA too (the same
setting). While it is ticked, every station heard is reported to
[pskreporter.info](https://pskreporter.info/): each CQ and beacon, and the
station you connect to, with the S/N the modem measured, at the dial
frequency plus 1500 Hz (VARA's centre). The mode is "VARAC", the name
VarAC's own reports use, so on the map they appear with VarAC users'
(choose VARAC in the mode list). Reports go out in a batch every 5
minutes, with FT8's. It needs `STATION_CALLSIGN`. (Before v117 the mode
was "VARA", so those reports are listed apart from VarAC's.)

**Other stations can call you.** While VARA is selected the modem listens,
answers a call by itself, and keys the radio. Leave VARA selected only while
you are there. Picking another mode, or the last browser leaving, ends VARA;
a QSO still open is dropped without a goodbye (no `<DISC>`), so press
Disconnect first.

**Speed.** The modem runs unregistered, as VARA HF does without a licence
key. At 500 Hz a short line takes about 10 to 15 seconds to arrive.

**Limits.**
* No single transmission may last more than 30 seconds (VARA's frames last
  a few seconds). A longer one is stopped.
* A QSO with nothing sent or received for 10 minutes is disconnected.
* The usual PTT watchdog (ten minutes) still applies.
* VARA needs `STATION_CALLSIGN`, and audio at 48 kHz (the default).
* Not yet: calling CQ on a slot as VarAC does (PiRO's CQ stays on the
  calling frequency), choosing a free slot by itself, sending beacons,
  VMail, BBS and file transfer.

**Bandwidth.** `VARA_BW` sets it: 500 Hz (the default, used on the VarAC
calling frequencies), 2300 or 2750 Hz. Both stations must use the same.

**Audio delay.** VARA's acknowledgements must arrive in time, so the modem
must know how far its transmit audio lags. `VARA_AUDIO_LATENCY_MS` (500 by
default, the usual sound-card buffer) tells it. If calls never connect,
see [Troubleshooting](#troubleshooting).

**How far it has been tested.** Receiving is checked against real VarAC
traffic: recordings of 14.105 and 7.105 MHz from public KiwiSDRs (October
2026), which PiRO's modem decodes as VarAC sends it (beacons from 15
stations, VMail notices, a broadcast to ALL, CQ frames). The same
recordings show VarAC's sequence on the calling frequency (`<Q>` or
`<AWQ>`, then `<Q:n>`, `<QSYR>` and the reports on the slot), which is
what PiRO does. On air (28 October 2026), PiRO called ZL2TNB, running
VarAC, on 14.105: it connected, ZL2TNB answered `<AWQ>`, PiRO moved the
QSO to 14.10575 by itself, both sent reports (ZL2TNB heard PiRO at
+10 dB), chat text was exchanged, and PiRO went back to 14.105 after.
Beyond that one QSO, transmitting has only been tested between two PiRO
stations through a simulated channel; not yet with VARA Chat. Xara's author reports testing
Xara against VARA HF 4.9.0. See
[`third_party/xara/README.md`](third_party/xara/README.md).

#### FT8 and FT4

**DIGI** selects FT8. Press it again for FT4, and again for WSPR. PiRO
puts the radio on USB with DATA MODE on, and tunes to the band's FT8 (or
FT4) frequency. Band buttons then go to that mode's frequency on each
band.

- The band-activity table lists what is decoded each 15-second slot (7.5 s
  in FT4): UTC, time offset (dt), audio frequency, SNR and the message. The scope shows the
  0 to 3 kHz audio, as in WSJT-X.
- The composer below it holds the next message. It starts with a CQ made
  from `STATION_CALLSIGN` and `STATION_GRID`. **Send** transmits it at the
  start of the next slot.
- **Guided QSOs.** Tap a CQ in the table, or call CQ and wait for an
  answer. PiRO then fills in each reply the exchange needs (grid, report,
  acknowledgement, RR73 or 73) as the other station's messages are
  decoded. The QSO's lines are highlighted. Replies go out on the other
  station's frequency. PiRO only suggests: you press Send for every
  message. It never transmits by itself.
- **Transmit frequency.** Tap the spectrum to choose it (to the nearest
  50 Hz). It starts at 1500 Hz and stays where you put it until you
  reload the page.
- **Someone calling you.** When a message to your callsign is decoded
  (`VK3TR K1ABC FN42`, also `VK3TR/P` or `<VK3TR>`), every browser in FT8
  plays three rising notes and shows it in amber. Each caller chimes once,
  until they have been quiet for 2 minutes. CQs and other QSOs never
  chime. A browser only plays sound once the page has been tapped.
- Tick **PSK Spot** to send what you decode to
  [PSK Reporter](https://pskreporter.info).

Two things must be right for FT8 to work:

- The Pi's clock. Check `timedatectl` shows "System clock synchronized:
  yes".
- On an IC-7300, Menu > Set > Connectors > MOD Input > **DATA MOD** must be
  **USB**. PiRO can't change this over CI-V. Without it the radio keys up
  but sends nothing.

#### WSPR

WSPR is the third choice of the **DIGI** button: FT8, then FT4, then WSPR,
then FT8 again. It puts the radio on USB with DATA MODE on and tunes to the
band's WSPR frequency (for example 7.0386 MHz on 40 m and 14.0956 MHz on
20 m). Band buttons then go to that band's WSPR frequency. The WSPR signals
are 1400-1600 Hz up; the spectrum marks that window.

WSPR runs in 2-minute slots that start on even UTC minutes. PiRO decodes
every slot it isn't transmitting in. The decoder is WSJT-X's `wsprd`,
ported to JavaScript (`src/audio/wspr-rx.js`); see
`third_party/wsjtx-wsprd/README.md`. It runs in a worker thread and takes a
few seconds per slot. The spots are listed newest first (time, SNR, time
offset, frequency, callsign, grid, power in dBm; tap-and-hold a row for the
drift). Every browser sees the same list, and a page that opens later gets
the recent spots.

Spots go to wsprnet.org after each slot, the way WSJT-X sends them (a
"wsprstat" report when nothing was heard). This needs `STATION_CALLSIGN`
and `WSPR_GRID` (or `STATION_GRID`); `WSPR_UPLOAD=off` turns it off. The
panel shows whether the last upload worked.

While WSPR is on, the **Power** menu offers 1-5 W, and the radio is held at
5 W or less (checked again before each transmission). The power from before
is put back when you leave WSPR.

Tick **Transmit** to transmit too. About one slot in five is then picked at
random, never two in a row, as WSJT-X does with "Tx Pct 20"; the panel says
when the next one is. A transmission starts 1 s into its slot and lasts
110.6 s. It sends `STATION_CALLSIGN`, the first 4 characters of the grid and
the radio's power in dBm (1 W is 30, 2 W is 33, 3-5 W are 37). The transmit
audio frequency is 1500 Hz unless you change it (1410-1590 Hz, in the box
or by tapping the spectrum). WSPR transmits only a plain callsign of up to 6
characters, so not one with a `/`. Transmit stops when the last browser
leaves. Unticking Transmit, or leaving WSPR, stops a transmission straight
away. Not tested on air.

**Unattended receive** (`WSPR_UNATTENDED=on`, off by default): 10 minutes
after the last browser disconnects, PiRO tunes the radio to the WSPR
frequency of the band it is on (20 m if it isn't near one), on USB with
DATA on, and receives and uploads spots by itself. It never transmits then.
Every 6 minutes (three slots; `WSPR_BAND_MINUTES` changes this) it moves
on to the next band: 160, 80, 40, 30, 20, 17, 15, 12, 10 and 6 m, then
round again. `WSPR_SKIP_BANDS` leaves bands out (for example
`160m,6m` for an antenna that doesn't suit them), and `WSPR_BAND_CYCLE=off`
keeps it on the one band. Each slot is decoded and reported on the band it
was heard on.

Straight after each band change it starts the radio's antenna tuner (the
same as the Tune button). This is the only time unattended WSPR transmits:
a tuning carrier for a few seconds, before receiving starts on the new
band. Tuning has its own limit: if the radio still reports tuning or
transmitting after 15 s, PiRO switches the tuner off, which ends the tune,
sends PTT off, and switches the tuner back on. A browser that connects
during a tune waits for it to finish before the radio is put back. Not
tested on air. When a browser connects, it stops
and puts the frequency, mode and DATA mode back.

#### Current conditions

The **Current conditions** link to the right of "Band" opens a window with
a table: **Band**, **My QTH** and **Local area**, one row per WSPR band
(160 m to 6 m). Each cell is tagged by range, how far the stations heard
were: the farthest spot of each station, and of those the 80th percentile,
so one freak spot doesn't decide it.

| Tag | Range |
|---|---|
| Great | 10,000 km or more |
| Good | 5,000 km or more |
| Average | 2,500 km or more |
| Bad | 1,000 km or more |
| Dismal | less than 1,000 km, or nothing heard |

- **My QTH** comes from the WSPR spots PiRO decoded itself in the last 90
  minutes: while you run WSPR, or from unattended receive and its band
  cycle (which visits every band about once an hour). A band PiRO listened
  to and heard nothing on is Dismal. A band it hasn't listened to is N/A.
- **Local area** comes from the spots of every WSPR reporter in your
  4-character grid square and the 8 squares around it (a 3 x 3 block
  centred on your square), in the last 60 minutes. These are wsprnet.org's
  spots. wsprnet.org has no open query interface, so PiRO reads them from
  [wspr.live](https://wspr.live), a free public copy of the wsprnet.org
  database. It asks at most every 10 minutes, and only when the window is
  opened. A band with no spots is N/A. This column works without WSPR
  running, but needs the Pi to have internet access.

Under each tag is the range, the number of stations heard and, for the
local area, the number of reporters. Both columns use `WSPR_GRID` (or
`STATION_GRID`); without one, everything is N/A. The window's note gives
the squares, the time windows and when the local area was last fetched.

#### FreeDV

**FreeDV** selects RADE digital voice (it reads **RADE V1** while on). It
needs the `rade_c` programs installed: see [FreeDV RADE](#freedv-rade).
PiRO puts the radio on the usual sideband for the frequency, with DATA MODE
on. There are no FreeDV calling frequencies, so it stays where you are.

Talk with **PUSH TO TALK** as usual: PiRO turns your voice into the RADE
signal, and decodes received RADE back into speech for your speaker.

**FDV Spot** reports your station to the [FreeDV Reporter](https://qso.freedv.org)
map, with the status message you **Set**. It needs `STATION_CALLSIGN` and
`STATION_GRID`. `FREEDV_REPORTER_ENABLED=0` turns reporting off altogether.
`RADE_TX_GAIN` sets the transmit drive: adjust it with the radio's power
meter and ALC.

#### Pictures: SSTV, EasyPal and Radiofax

The **Image** button selects SSTV on the first press, EasyPal on the
second and Radiofax on the third (then SSTV again).

##### SSTV

The **Image** button's first press turns on SSTV (slow-scan television). It puts the radio
on the band's usual sideband (LSB below 10 MHz, USB above; DATA MODE only
while sending) and tunes to the band's SSTV frequency. Band buttons then do
the same:

| Band | Frequency (MHz) | Sideband |
|---|---|---|
| 40 m | 7.171 | LSB |
| 20 m | 14.230 | USB |
| 15 m | 21.340 | USB |
| 10 m | 28.680 | USB |
| 6 m | 50.950 | USB |

The usual 160 m (1.890 MHz) and 80 m (3.730 and 3.845 MHz) frequencies are
outside the Australian allocations, so on those bands, and on 30, 17 and
12 m, which have no usual SSTV frequency, the band buttons tune as normal.
The table is `SSTV_FREQUENCIES` in `src/client/app.js`.

The PTT button stays the ordinary voice PTT (for talking about the
pictures); pictures are sent with the panel's Send button (below). The
scope shows the 0-3 kHz audio spectrum with faint lines at 1200 Hz (sync),
1500 Hz (black) and 2300 Hz (white) to tune by.

The receiver waits for the VIS header that starts every SSTV picture, which
names its mode, and handles 25 modes: Martin M1-M4, Scottie S1, S2 and DX,
Robot 36, 72, 24 and the black-and-white 8, 12 and 24, PD 50, 90, 120,
160, 180, 240 and 290, Wraase SC-2 120 and 180, and Pasokon P3, P5 and P7.
It measures how far the signal is from the standard tones from the header
(so it copies a station up to about 150 Hz off), and its frequency
measurement gets more averaging as the signal gets noisier. The picture
panel under the S-meter fills in line by line as the picture arrives, with
the mode, line count and offset above it. When the picture ends, the
receiver finds the sync pulses' slope, which is how far the other station's
sound card clock is off, and redraws the picture straight. It then joins
the strip of recent pictures (the last 12, kept by the server, so another
browser or a reload sees them too).

* **Stop** ends the picture now and keeps what has arrived. A picture also
  ends by itself if the sync pulses stop for 12 lines (the signal has gone),
  and when you transmit.
* **Save** downloads the picture shown as a PNG, at its own resolution.
* Tap the picture to open it full size (pinch to zoom; tap again to close).
  Thumbnails show older pictures.
* Set `SSTV_SAVE_DIR` to have the server save every picture there as well.

Picture sizes are 320 × 256 for Martin, Scottie, Wraase and PD 50/90,
320 × 240 for Robot, 512 × 400 for PD 160 and 640 × 496 for PD 120/180/240
and Pasokon (800 × 616 for PD 290). On a phone the panel is about 360-430
points wide, which on a 2-3× screen is at least as many pixels as the
picture has.

The receiver is a JavaScript port of slowrx by Oona Räisänen OH2EIQ (ISC
licence); see [`third_party/sstv/README.md`](third_party/sstv/README.md)
for what was ported, the differences, and how it was checked (including
against audio from PySSTV, an independent encoder). It runs in a worker
thread, only while SSTV is selected and you are not transmitting. Not yet
tested over the air. The picture drawn while it arrives is not yet
slant-corrected, so from a station whose sound card is well off it leans
until it is redrawn at the end.

**Sending a picture.** Under the received pictures, **Camera** opens the
phone's camera (on a computer it opens a file chooser) and **Choose image**
picks an existing picture. The picture appears at the size and shape that
will be sent (320 × 256 for the default Scottie 1), filling the frame:

* **drag** it to choose what is shown, and **pinch**, scroll or use **Zoom**
  to get closer;
* the **callsign** (from `STATION_CALLSIGN`, editable) and an optional
  **second line** (for example a report, "UR 595", or a locator) are drawn
  in white with a dark outline on a translucent box, in the **corner** you
  choose. The tag is made as large as fits within half the picture's
  width and half its height, box included (160 × 128 pixels
  at most in Scottie 1);
* **Send** shows the mode and how long it takes (about 1 minute 56 seconds
  for Scottie 1 with the IDs). What is in the preview is exactly what is
  sent.

Sending works as for RTTY: the Pi encodes the picture (in a worker thread),
turns DATA MODE on so the radio takes USB audio, keys PTT, plays it, and
puts everything back afterwards, including if you press **Stop**. After the
picture come the **FSK ID** (the callsign as the short 1900/2100 Hz burst
that MMSSTV, slowrx and similar programs show as the sender's call) and a
**CW ID** ("DE" and the callsign at 20 WPM, 800 Hz). The sent picture joins
the strip, marked as sent.

While a picture is being prepared and sent, a progress box under **Send a
picture** shows the time sent and the total (for example `0:42 / 1:57`), a
bar marked where the picture ends and the IDs begin, what is going out now
(`VIS header`, `Picture · line 112 of 256`, `FSK ID`, `CW ID`) and the time
left, with a **Stop** button. The picture also fills in on the SSTV screen
above as it goes out, the part not yet sent dimmed, with a green line where
it has got to. Every browser connected to PiRO shows this, including one
opened part-way through, so a transmission started on one phone can be
watched or stopped from another.

The mode is set on the Pi with `SSTV_TX_MODE` (Scottie 1, `S1`, by
default; any of the receiver's mode ids, e.g. `M1`, `R36`, `PD120`).
SSTV is a full-power tone for one to four minutes, much harder on the
radio than voice: set `SSTV_TX_POWER_W` to send at lower power (it is put
back afterwards), or turn the power down yourself. `SSTV_FSK_ID=off` and
`SSTV_CW_ID=off` leave out the IDs; with no `STATION_CALLSIGN` there are
none. The usual 10-minute PTT cut-off still applies.

The encoder follows N7CXI's mode specifications: for Martin 1, Robot 36
and PD-120, its tones match PySSTV's, an independent encoder, to within a
few hertz throughout; Scottie modes include the starting sync pulse the
specification calls for. Sending has been tested with PiRO's own receiver
and a stub radio, not on air.

##### EasyPal

The **Image** button's second press turns on **EasyPal** receive: digital
SSTV as EasyPal and QSSTV send it (HamDRM, a form of Digital Radio
Mondiale). The picture is sent as a file (usually JPEG or JPEG 2000) over
an OFDM signal about 2.4 kHz wide. PiRO receives and sends it.

- The radio goes to **USB**, on the band's EasyPal (digital SSTV) calling
  frequency if it has one: 7.173 MHz (40 m), 10.144 MHz (30 m), 14.233 MHz
  (20 m) or 21.337 MHz (15 m), as commonly listed. On other bands it stays
  where it is. The band buttons do the same while EasyPal is on. EasyPal is
  always USB: a USB signal heard on LSB is a mirror image and won't decode.
  The audio spectrum
  replaces the RF scope; a signal tuned right fills the space between the
  two guide lines (400 and 2750 Hz). The receiver copes with a mistuning of
  a few hundred hertz and shows it.
- Like Radiofax, EasyPal turns the radio's **NR** and **auto notch** off and
  selects **FIL1**, and puts them back when you leave
  (`EASYPAL_RADIO_SETUP=off` stops this). NR upsets the phase of the
  carriers, and the auto notch attacks the pilot tones.
- The panel shows what the receiver hears: the mode (A, B or E), the
  bandwidth, the QAM, the S/N, the sender's callsign and how many segments
  of the file have come. While a plain JPEG comes in, its top part is shown
  as it grows. When the file is complete it is shown, described, and added
  to the strip of recent ones (the last 8, for pages that open later). Tap
  the picture for full size; **Save** saves the file (a JPEG 2000 picture
  as the JPEG it was shown as, at most 1600 pixels across; `EASYPAL_SAVE_DIR`
  keeps the original).
- Files sent with Reed-Solomon protection (EasyPal's and QSSTV's `.rs1` to
  `.rs4`) are put back together when some segments are lost, once enough
  have arrived. A plain file needs every segment.
- `EASYPAL_SAVE_DIR` also saves every file, as it was sent.

The receiver is a JavaScript port of QSSTV's, run in a worker thread on
the server: 1 to 2% of a desktop CPU core (measured), so a few percent of a Pi's. It was checked against QSSTV's own
receiver on signals made by QSSTV's own transmitter, in all 72 mode
combinations and with noise, mistuning, clock errors, echoes and fading;
see [`third_party/qsstv-drm/README.md`](third_party/qsstv-drm/README.md).
A recording of a real EasyPal transmission found online (mode A, 64-QAM, a
10-megapixel JPEG 2000 photo sent with Reed-Solomon) decoded completely.
Not tested yet on a signal PiRO receives off air.

###### Sending

Under the EasyPal picture, **Send a picture** offers **Camera** (the
phone's camera) and **Choose image**.

- The whole picture is sent, keeping its shape, fitted within 800 x 600.
  You can put your callsign (and a second line) in a corner, as for SSTV.
- **Send** shows the settings and the longest it will take. The server
  then makes the picture fit that time: it picks the best JPEG quality
  that fits (30 to 90), and makes the picture smaller if even quality 30
  is too big. It is sent as a JPEG, with Reed-Solomon protection
  (`.rs2` by default), named `CALL-YYYYMMDD-HHMMSS` (UTC).
- PiRO puts the radio in **DATA MODE** (and confirms it), sets the
  power if `EASYPAL_TX_POWER_W` is set, keys PTT and sends. Afterwards it
  puts the power and DATA MODE back. The radio must be on USB.
- Every browser shows the progress, the picture going out and a **Stop**
  button. A sent picture is added to the strip, marked "Sent".
- Sending stops if the last browser disconnects. The 10-minute PTT limit
  applies, and `EASYPAL_TX_SECONDS` can't be more than 540.

The settings are fixed on the Pi, as SSTV's mode is: `EASYPAL_TX_MODE`
(B), `EASYPAL_TX_BANDWIDTH` (2.5 kHz), `EASYPAL_TX_QAM` (16),
`EASYPAL_TX_PROTECTION` (high), `EASYPAL_TX_INTERLEAVE` (short),
`EASYPAL_TX_RS` (rs2) and `EASYPAL_TX_SECONDS` (90). The callsign sent in
every frame is `STATION_CALLSIGN`. Mode B, 16-QAM, high protection sends
about 290 bytes a second; the start and end of each transmission add
about 16 s. Guide, for mode B, 16-QAM and RS2:

| Time allowed | JPEG size | A photo is sent at about |
|---|---|---|
| 90 s | 15 kB | 430-550 pixels across |
| 120 s | 22 kB | 520-640 pixels across |
| 180 s | 34 kB | 640-800 pixels across |

The transmitter is a JavaScript port of QSSTV's. Its audio was checked
against QSSTV's own transmitter with the same file: the same frames, and
the same samples to within 2 parts in 32768, in modes A, B and E, both
interleaves and all three QAMs; QSSTV's receiver decodes it. Fitting the
picture and making 90 s of audio takes about 1.5 s on a desktop; expect
several seconds on a Pi (not measured).

**Tested on air** once, on 25 October 2026: a picture sent with the
defaults from an IC-7300 on 28.690 MHz was recorded on a KiwiSDR
(vk3jst.ddns.net) and decoded completely, at about 9 dB S/N. 42 of its
176 segments were lost and put back by Reed-Solomon. The first 22 s of
the recording is a test fixture. EasyPal itself has not been tried, but it uses the same
format.

##### Radiofax

The **Image** button selects SSTV on the first press, EasyPal on the
second and **Radiofax** on the third (then SSTV again). Its label reads
"SSTV", "EasyPal" or "Fax" while one is on. Radiofax receives HF weather charts: frequency-modulated audio around
1900 Hz (black 1500 Hz, white 2300 Hz), 120 lines a minute, IOC 576, 1810
pixels a line. That is what the Bureau of Meteorology sends. It receives
only, on USB with DATA MODE off.

While Radiofax is on, the chart coming in is drawn where the spectrum
usually is, newest line at the bottom; tap it to open it full size. Below
the spectrum, the Radiofax panel shows what the receiver is doing, and has
**Start now**, **Stop** and **Save** buttons and the last few charts.

Below the S-meter are buttons for the VMC (Charleville, Qld) and VMW
(Wiluna, WA) frequencies, in order of their broadcast hours (UTC, from the
Bureau's technical guides). The ones not on the air now are dimmed, and
the one the radio is on is lit. A button tunes the radio 1.9 kHz below the
listed frequency, on USB, so the signal's centre is at 1900 Hz. Entering
Radiofax tunes the first button on the air now, unless the radio is
already on one of them.

Entering Radiofax also sets the radio up for fax: **NR off**, **auto notch
off** and **FIL1** (its widest filter). NR smears every quick black/white
change, so thin vertical lines vanish and text strokes come out hollow;
the auto notch attacks steady tones, which is what a white or black area
is. Leaving Radiofax (or the last browser closing) puts back whatever was
changed, unless you changed it yourself in the meantime; the filter is
only put back if the mode is still the same. `FAX_RADIO_SETUP=off` turns
this off.

| Station | Frequency (kHz) | Hours (UTC) |
|---|---|---|
| VMC, VMW | 5100, 7535, 10555, 11030, 13920, 15615 | all day |
| VMC | 2628 | 09-19 |
| VMW | 5755 | 11-21 |
| VMC | 20469 | 19-09 |
| VMW | 18060 | 21-11 |

How a chart is received:
- The start signal (black and white alternating at 300 Hz for 5 s) starts
  a chart.
- About 30 s of phasing lines follows: black, with one white pulse at the
  start of each line. PiRO lines the chart up on the pulse. It also
  measures how far the pulse drifts from line to line, which is the
  difference between the sender's clock and the Pi's sound card. Each line
  is then made that much longer or shorter, so the chart isn't slanted. The
  measurement is shown as "clock ±N ppm".
- PiRO looks for phasing lines all the time, so a chart still lines up if
  its start signal was missed, or if **Start now** was pressed during the
  phasing.
- A few phasing lines spoilt by noise (a static crash, a fade) don't end
  the phasing: it takes three bad lines in a row. So the whole 30 s is
  measured, and none of it is drawn as part of the chart.
- The clock is only measured from the phasing when the measurement is
  good to 25 ppm. Otherwise the phasing still lines the chart up, and the
  line length stays as it was.
- The clock error is kept (the median of the last 5, in
  `FAX_STATE_FILE`), so a chart without phasing, or the first one after a
  restart, starts with the right line length.
- Any chart whose clock wasn't measured from its own phasing is
  straightened when it ends: PiRO tries slants of up to 1.5 pixels a line
  and keeps the one that lines up its vertical edges best (frames, grids,
  coasts, the left edge of text), then shifts each line back. The chart
  then says "slant corrected". The slant found also counts as a clock
  measurement for later charts. Its left edge stays wherever the line
  happened to start, unless phasing lined it up.
- When a chart ends, noise damage is mended: a line spoilt across its
  width by a static crash (up to 3 in a row) is replaced by a blend of the
  lines either side, and patches of speckle much worse than the lines
  around them are smoothed. Clean drawing, text and grids are left alone.
  A deep fade that wipes out more lines can't be recovered. The chart
  then says how many lines were mended. `FAX_CLEANUP=off` turns this off.
- The stop signal (450 Hz) ends the chart. So do a new start signal,
  **Stop**, leaving Radiofax, transmitting, or 25 minutes.
- **Start now** begins a chart straight away, for a broadcast that is
  already under way. Its left edge is then wherever the line happens to
  start, and the clock correction is the last one measured.

Each chart is kept as a PNG (the last 6, for pages that open later; a page
that opens part-way through a chart is sent it so far). `FAX_SAVE_DIR`
also saves them to a folder. The receiver is PiRO's own JavaScript, run on
the server: 0.6% of a desktop CPU core (measured), so a few percent of a
Pi's. Not tested on an off-air signal yet.

### Configuration reference

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
| `AUDIO_OPUS_BITRATE` | `24000` | Opus bit rate for compressed audio, in bits per second (6000 to 128000). See [Compressed audio for remote use](#compressed-audio-for-remote-use). `AUDIO_CODEC` is no longer used: each browser chooses. |
| `SCREEN_TITLE` | `SPARC PiRO` | Title shown in the browser tab and on the page. |
| `JTTY_TX_FREQ_HZ` | `1450` | Audio frequency of JTTY's lowest tone, in Hz. The signal fills about 94 Hz above it. |
| `JTTY_RX_LOW_HZ`, `JTTY_RX_HIGH_HZ` | `200`, `2900` | Audio range, in Hz, searched for JTTY signals. The default is the whole range the decoder supports. Two extra fixed channels at 1350 and 1650 Hz (±150 Hz) are always searched as well. A narrower range saves a little CPU. |
| `JTTY_RX_QUALITY` | `economy` | JTTY decoder effort. `economy` uses about 40% of `full`'s CPU and decoded nearly as many weak signals in testing. `light` is in between, `full` matches WSJT-X's search exactly, and `auto` runs `full` but drops to `economy` when the Pi falls behind. |
| `OLIVIA_FREQ_HZ` | `1500` | Olivia's default audio centre frequency, in Hz, for sending and receiving, until it is changed in the UI. The signal is 250 Hz wide; the receiver searches 125 Hz either side. |
| `VARA_BW` | `500` | VARA bandwidth in Hz: `500`, `2300` or `2750`. See [VARA chat](#vara-chat). |
| `VARA_NAME`, `VARA_QTH` | none | Your name and QTH, sent to the other station after the opening report, as VarAC's profile (`<NAME:…>`, `<QTH:…>`). `STATION_GRID` goes with them as the locator. |
| `VARA_AUDIO_LATENCY_MS` | `500` | How far VARA's transmit audio lags what is written to the sound card, in ms (0 to 2000). The modem holds PTT that much longer and times its replies to suit. |
| `OLIVIA_SQUELCH` | on | `off` turns off PiRO's filtering of junk characters and decodes exactly as fldigi does with its squelch off. See [Olivia](#rtty-jtty-olivia-and-feld-hell). |
| `SSTV_SAVE_DIR` | none | If set, every received SSTV picture is also saved in this folder as a PNG (`YYYYMMDD-HHMMSSz-<mode>.png`, UTC). |
| `FAX_STATE_FILE` | `~/.config/piro/fax.json` | Where Radiofax keeps the sound card's measured clock error between restarts. |
| `FAX_RADIO_SETUP` | on | `off` stops Radiofax turning the radio's NR and auto notch off and selecting FIL1. |
| `FAX_CLEANUP` | on | `off` stops Radiofax mending crash-hit lines and speckle when a chart ends. |
| `EASYPAL_SAVE_DIR` | none | If set, every file received by EasyPal is also saved in this folder as it was sent (`YYYYMMDD-HHMMSSz-CALL-name.jpg`, UTC). |
| `EASYPAL_RADIO_SETUP` | on | `off` stops EasyPal turning the radio's NR and auto notch off and selecting FIL1. |
| `EASYPAL_TX_MODE` | `B` | EasyPal transmit robustness mode: `A`, `B` or `E`. B suits most HF paths; E is the most robust and slowest; A is fastest. |
| `EASYPAL_TX_BANDWIDTH` | `2.5` | EasyPal transmit bandwidth in kHz: `2.5` or `2.3`. |
| `EASYPAL_TX_QAM` | `16` | EasyPal transmit QAM: `4`, `16` or `64`. 4 is the most robust, 64 the fastest. |
| `EASYPAL_TX_PROTECTION` | `high` | EasyPal transmit error protection: `high` or `normal` (faster, needs a better signal). |
| `EASYPAL_TX_INTERLEAVE` | `short` | EasyPal transmit interleave: `short` or `long` (copes better with fading). |
| `EASYPAL_TX_RS` | `rs2` | Reed-Solomon protection for EasyPal pictures sent: `off`, `rs1` (least) to `rs4` (most). It lets the other station rebuild lost segments, but makes the file bigger. |
| `EASYPAL_TX_SECONDS` | `90` | The longest an EasyPal picture may take to send, 10 to 540 seconds. The picture is made smaller, and its JPEG quality lowered, until it fits. |
| `EASYPAL_TX_POWER_W` | none | TX power in watts while sending EasyPal (put back afterwards). Unset leaves the power alone. |
| `FAX_SAVE_DIR` | none | If set, every received radiofax chart is also saved in this folder as a greyscale PNG (`YYYYMMDD-HHMMSSz-fax.png`, UTC, the chart's start). |
| `SSTV_TX_MODE` | `S1` | SSTV transmit mode: `S1` (Scottie 1), or any mode id the receiver knows (`M1`, `M2`, `S2`, `SDX`, `R36`, `R72`, `PD90`, `PD120`, `PD180`, ...; see `src/audio/sstv-modes.js`). Read at startup. |
| `SSTV_TX_POWER_W` | none | TX power in watts while sending SSTV (put back afterwards). Unset leaves the power alone. |
| `SSTV_FSK_ID`, `SSTV_CW_ID` | on | `off` leaves out the FSK ID or the CW ID sent after each SSTV picture. Both use `STATION_CALLSIGN`. |
| `HELL_TONE_HZ` | `1000` | Feld-Hell's default audio tone, in Hz, for sending and receiving, until it is changed in the UI. The band frequencies the client tunes to assume the signal is at this tone. |
| `STATION_CALLSIGN`, `STATION_GRID` | none | Your callsign and Maidenhead grid. They set the FT8 default message and guided QSO, the FreeDV Reporter report, and WSPR's callsign (WSPR transmits only a plain call of up to 6 characters). |
| `WSPR_GRID` | `STATION_GRID` | The Maidenhead grid WSPR sends (the first 4 characters) and reports to wsprnet.org (4 or 6 characters, such as `QF22` or `QF22LB`). |
| `WSPR_UPLOAD` | on | `off` stops WSPR spots going to wsprnet.org. Uploading also needs `STATION_CALLSIGN` and a grid. |
| `WSPR_UNATTENDED` | off | `on` makes WSPR receive by itself 10 minutes after the last browser leaves: the radio goes to the WSPR frequency of its band (USB, DATA on), and goes back to how it was when a browser connects. It never transmits then. See [WSPR](#wspr). |
| `WSPR_BAND_CYCLE` | on | While WSPR receives unattended, it moves to the next band every `WSPR_BAND_MINUTES`, 160 m up to 6 m and round again, and starts the antenna tuner after each change. `off` stays on the one band. |
| `WSPR_BAND_MINUTES` | `6` | Minutes on each band in the unattended band cycle. WSPR slots are 2 minutes, so it is rounded to an even number; 2 changes band every slot. |
| `WSPR_SKIP_BANDS` | none | Bands left out of the unattended band cycle, separated by commas: for example `160m,6m` (or `160,6`). The bands are 160m 80m 40m 30m 20m 17m 15m 12m 10m 6m. If the radio is on a skipped band, the cycle starts on the next one. |
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

`CIV_SCOPE_ENABLED` also accepts `1`. The reasoning behind the less obvious
defaults (`HAMNOISE_QUALITY`, `RADE_TX_GAIN`, `RADE_VERSION`,
`CIV_MAXIMIZE_USB_LEVELS`) is in `docs/ui-notes.md` and
`docs/civ-notes.md`.

### Updating

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

### Troubleshooting

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
- **A digital transmission (FT8, RTTY, JTTY, Olivia, VARA, Feld-Hell, SSTV) keys
  the radio but shows no power.** The radio's display should read USB-D or
  LSB-D while it transmits; PiRO turns DATA mode on with CI-V `1A 06`
  (before v78 it sent the wrong command, so DATA mode never came on). Then
  check on the radio: Menu > Set > Connectors > MOD Input > **DATA MOD**
  must be **USB**, and USB MOD Level not 0. If it only happens sometimes,
  update to v80 or later: PTT used to follow the DATA mode command so
  closely that the radio could transmit from the microphone instead. PiRO
  now confirms DATA mode, and waits for it to take, before keying. A
  warning saying DATA mode was turned off during a transmission means
  something changed the radio's mode while it was sending.
- **FT8 or WSPR decodes nothing or at the wrong times.** Check the system
  clock with `timedatectl`. It must show "System clock synchronized: yes".
- **"Local area" in Current conditions is all N/A.** A red line at the top
  of the window says why, if PiRO knows: no grid set, or wspr.live couldn't
  be reached or refused the query (the Pi needs internet access to
  `db1.wspr.live`, HTTPS). The server log (`journalctl -u piro`) has a
  "Band conditions:" line for every fetch. To test from the Pi itself, run
  `node test/manual-wspr-live.js QF22` (your grid): it sends the same
  queries and prints what comes back. With no red line, no WSPR reporters
  near you were heard in the last hour. Before v92, `ETIMEDOUT` within half
  a second was Node giving up too soon on a far server (see below).
- **`ETIMEDOUT` after a fraction of a second** when reaching a server
  abroad. Node gives each address only 250 ms to connect, and wspr.live (in
  Europe) is about 300 ms from Australia. Since v92 PiRO allows 5 s.
- **WSPR spots don't reach wsprnet.org.** The WSPR panel says whether the
  last upload worked. Uploading needs `STATION_CALLSIGN`, `WSPR_GRID` (or
  `STATION_GRID`) and internet access from the Pi (to `wsprnet.org`, port
  80), and must not be turned off with `WSPR_UPLOAD=off`.
- **The WSPR Transmit box can't be ticked.** Its tooltip says why: usually
  `STATION_CALLSIGN` or the grid is not set, or the callsign has a `/`.
- **The microphone is blocked in the browser.** Use HTTPS (see
  [Installing PiRO](#installing-piro)).
- **The Squelch button says Paused.** It only works in SSB, AM and FM
  voice. In CW, with DATA mode on, or in FT8, FreeDV and the other digital
  modes it stands aside and lets all the audio through.
- **The squelch stays shut on a station I can hear.** It needs to hear
  the pitch of a voice, and very weak or badly distorted signals may not
  show one. Switch it off for weak stations.
- **Audio breaks up away from home.** Check the Audio button says Opus or
  ADPCM, not "full"; tap it if not. Full audio needs about 770 kbit/s each
  way. Compressed audio plays 0.2 s behind, to ride out a slow network;
  if it still breaks up, the connection is losing packets. A browser that
  can't decode Opus (Firefox on Android, Safari before 26) uses ADPCM,
  which needs 48 kbit/s each way.
- **The Audio button can't be tapped.** The server can't compress audio:
  `AUDIO_CHANNELS` must be 1.

- **VARA calls never connect, or links drop.** Both stations must use the
  same bandwidth (`VARA_BW`). Watch the status line: if the other station
  is heard (its CQ is listed, or "someone is calling…" shows) but the link
  fails, the timing may be off. Try `VARA_AUDIO_LATENCY_MS` at 300 or 800.
  Check the transmit audio level the same way as for the other digital
  modes: no ALC.
- **The VARA panel says "not running on the server".** The server has no
  VARA: either audio isn't set up (`AUDIO_RX_DEVICE`), or PiRO was updated
  but not restarted, so the old server is serving the new page (the build
  number beside the title is the server's). Restart it:
  `sudo systemctl restart piro`.
- **The VARA panel says why it can't run.** It needs `STATION_CALLSIGN` and
  a sample rate of 48000.
- **EasyPal shows the mode and S/N but no picture.** A plain (not
  Reed-Solomon) file needs every segment: one lost segment and it never
  completes. Ask the sender to use an `.rs` setting, or to send again. A file
  already received is not shown a second time. Below about 10 dB S/N
  (16-QAM) or 15 dB (64-QAM) segments are lost; mode B or E with 4- or
  16-QAM copes with weaker signals.
- **EasyPal sends a small or blurry picture.** The picture is made to fit
  `EASYPAL_TX_SECONDS`. In 90 s (mode B, 16-QAM, RS2) that is a JPEG of
  about 15 kB, so a photo goes out at about 430 to 550 pixels across. Allow
  120 or 180 s for a bigger picture, or turn `EASYPAL_TX_RS` down.
- **EasyPal won't send: "Put the radio on USB first".** EasyPal is sent on
  USB with DATA MODE. Pressing the EasyPal button sets USB.

### Hardware diagnostics

The `test/manual-*.js` scripts talk to a real radio. Stop the service first,
because they need the serial port. None of them transmits.

```bash
node test/manual-civ-test.js /dev/ttyUSB0            # basic CI-V check (optionally add the address: 0x94)
node test/manual-scope-test.js /dev/ttyUSB0          # does your radio deliver scope data? (may need CIV_BAUD_RATE=115200)
node test/manual-scope-span-diagnostics.js /dev/ttyUSB0   # scope span slider rejected ("Radio rejected request")
node test/manual-smeter-diagnostics.js /dev/ttyUSB0       # S-meter shows wrong values; prints the raw reply bytes
node test/manual-txpower-diagnostics.js /dev/ttyUSB0      # TX power setting rejected (NG)
node test/manual-ws-test.js ws://<pi-hostname-or-ip>:8080 # talk to a running server's WebSocket
node test/manual-wspr-live.js QF22                        # Current conditions "Local area": the wspr.live queries from this machine (no radio needed)
```

If you open an issue about one of these, include the script's full output and
what the radio's front panel showed. `docs/civ-notes.md` explains the common
causes.

---

## Part 2: For developers

1. [Architecture](#architecture)
2. [Design rules](#design-rules)
3. [Project layout](#project-layout)
4. [Components in detail](#components-in-detail)
5. [WebSocket protocol](#websocket-protocol)
6. [Testing](#testing)
7. [Making a change](#making-a-change)
8. [Ported code](#ported-code)

### Architecture

PiRO is one Node.js process on the Pi, and a web app (a PWA) in the
browser. There is no build step: the browser loads plain ES modules.

```
  Browsers (phones, PCs)                   Raspberry Pi
 +------------------------+  WebSocket  +-----------------------------------+
 | app.js (the whole UI)  |<----------->| ControlServer (ws-server.js)      |
 | RigLink (rpc.js)       | JSON control|   requests -> events -> bridges   |
 | AudioPipeline, scope   | and tagged  |   state snapshot, broadcasts      |
 +------------------------+ binary      |   PTT watchdog (10 min)           |
                            frames      |                                   |
                                        | CivDriver ----- CI-V serial --+   |
                                        | AudioBridge --- ALSA ---------+   |
                                        | feature bridges -> workers    |   |
                                        +-------------------------------|---+
                                                         one USB cable  v
                                                              Icom transceiver
```

- **CivDriver** (`src/civ/driver.js`) owns the serial port. It sends one
  CI-V request at a time, matches replies, and emits the radio's own
  changes (frequency, mode, scope lines).
- **ControlServer** (`src/server/ws-server.js`) serves the web app and the
  WebSocket. It answers requests, keeps the shared state that a new
  browser gets on connect, broadcasts changes, and runs the PTT watchdog.
  Requests for a feature become internal events that its bridge handles.
- **AudioBridge** (`src/server/audio-bridge.js`) runs `arecord` and
  `aplay` on the radio's USB codec. It sends received audio to the
  browsers (raw PCM, Opus or ADPCM, per browser) and plays microphone
  audio to the radio.
- **Feature bridges** (`src/server/*-bridge.js`, plus
  `src/audio/ft8-bridge.js` and `src/audio/tty-bridge.js`): one per
  feature. Each listens to ControlServer's events, reads received audio
  or writes transmit audio, drives the radio through CivDriver, and
  broadcasts results.
- **Workers.** Heavy decoding and encoding (FT8, JTTY, Olivia, SSTV, WSPR,
  EasyPal) and the VARA modem run in worker threads, so the main thread stays free for CI-V,
  audio and the WebSocket.
- **The client** (`src/client/`): `app.js` is the whole UI. `rpc.js`
  (RigLink) wraps the WebSocket and re-dispatches every server event as a
  DOM event. `audio.js` plays and records with Web Audio. `scope.js` draws
  the spectrum and waterfall. `sw.js` caches the app for offline start.

[`docs/architecture.drawio`](docs/architecture.drawio) is a UML diagram of
the main classes and how they connect: browser client, server, feature
bridges, CI-V and audio. Its second page lists which events each server
part listens to and sends. Open it in [draw.io](https://app.diagrams.net/)
or the draw.io desktop app. [`docs/architecture.png`](docs/architecture.png)
is a preview of the first page.

[![PiRO class diagram](docs/architecture.png)](docs/architecture.png)

### Design rules

- **The radio is the source of truth** for its settings: frequency, mode,
  filter, DATA mode, power, preamp, NR and the rest, including changes made
  on its front panel. **The server is the source of truth** for its own
  settings: the app-level modes (FT8/FT4, FreeDV, JTTY, Olivia, VARA,
  Feld-Hell, SSTV, EasyPal, Radiofax, WSPR) and their frequencies, the decoder
  options, the notes. Every browser shows what the radio or the server
  reports, by event or by polling. A browser never treats its own copy as
  the truth.
- Server settings live in `ControlServer.state` (the connect snapshot) and
  are broadcast when they change. The browser that made a change does not
  send radio commands again when it hears the broadcast.
- Phones disconnect and reconnect often. Transmissions and receivers stop
  when the last browser leaves.
- A feature that changes a radio setting (mode, DATA mode, power, key
  speed, break-in, NR, filter) puts it back afterwards, also on Stop and on
  errors.
- Before keying audio, DATA mode is confirmed with `ensureDataMode()`
  (`src/civ/data-mode-guard.js`): read back, retried, then a settle time.
  PTT straight after the command could transmit from the microphone.
- Anything that transmits without PTT has its own time limit, because the
  PTT watchdog doesn't see it.
- CAT control is on the server (Node `serialport`), not the browser's Web
  Serial API. So any browser works, including Safari and iOS, and the
  browser needn't be near the radio.
- Audio uses the radio's own USB codec through ALSA: no extra sound card
  or virtual audio cable.
- There is no login. Remote use is expected over a VPN. PiRO compresses
  audio for such links.

`docs/civ-notes.md` has the CI-V command history and corrections, and is
worth reading before changing anything in `src/civ/`.

### Project layout

```
src/
  civ/        CI-V: framing and BCD (frame.js), commands (commands.js),
              the driver (driver.js), scope line reassembly (scope.js),
              the DATA mode guard (data-mode-guard.js)
  server/     index.js (env vars, wiring), ws-server.js (ControlServer),
              protocol.js (every request and event, documented inline),
              static-server.js, audio-bridge.js and audio-codecs.js,
              scope-bridge.js, one *-bridge.js per feature,
              radio-setup.js (NR, notch and filter for fax and EasyPal),
              band-conditions.js, wsprnet.js, freedv-reporter.js, png.js,
              varac.js (VarAC's messages and CQ slots)
  audio/      ALSA (alsa.js, mixer.js), Opus (opus-codec.js), PCM framing,
              resampling (resample.js, decimator.js), FFT (fft.js),
              noise reduction (rnnoise-filter.js, hamnoise-filter.js),
              voice-squelch.js, and the modems:
                CW       cw-decoder.js, hamfist-cw-decoder.js, deepcw-decoder.js
                RTTY     rtty-decoder.js, rtty-encoder.js
                FT8/FT4  ft8-bridge.js, ft8-decode-worker.js, slot-clock.js,
                         psk-reporter.js (codec: @e04/ft8ts)
                JTTY     jtty-codec.js, jtty-tx.js, jtty-rx.js,
                         jtty-tbcc-decode.js, jtty-decode-worker.js
                Olivia   olivia-dsp.js, olivia-tx.js, olivia-rx.js,
                         olivia-decode-worker.js
                Hell     hell-font.js, hell-tx.js, hell-rx.js, hell-ocr.js
                SSTV     sstv-modes.js, sstv-rx.js, sstv-tx.js,
                         sstv-decode-worker.js, sstv-encode-worker.js
                WSPR     wspr-codec.js, wspr-rx.js, wspr-decode-worker.js
                Fax      fax-rx.js (fax-tx.js makes test signals)
                EasyPal  drm/ (HamDRM receiver and transmitter),
                         easypal-decode-worker.js, easypal-encode-worker.js
                FreeDV   rade-pipeline.js (runs the rade_c programs)
                VARA     xara/xara.wasm (Xara's VARA HF modem in
                         WebAssembly), xara/xara.js, vara-worker.js
              tty-bridge.js sends RTTY, JTTY, Olivia and Feld-Hell.
  client/     the PWA: index.html, styles.css, app.js (the whole UI),
              rpc.js (RigLink), audio.js, mic-capture-processor.js,
              audio-codec.js (shared with the server), scope.js, smeter.js,
              vswr.js, ft8-qso.js, sw.js, manifest and icons
test/         *.test.js and *.test.mjs (npm test), manual-*.js (see Testing)
  fixtures/   recordings and pictures the tests use
docs/
  civ-notes.md        CI-V command history and corrections, scope byte
                      layout, DATA mode, the PTT watchdog
  ui-notes.md         one section per build: what changed, bugs and causes
  audio-notes.md      the audio pipeline (PCM and Opus, levels)
  pwa-notes.md        HTTPS, certificates, installing to a home screen
  install-debian.md   the install steps with more explanation
  architecture.drawio UML class diagram and event-wiring table (draw.io)
  architecture.png    preview of the class diagram
deploy/       piro.service (systemd unit) and piro.env.example
models/       bundled DeepCW and HamNoise models, with their licences
third_party/  notes, licences and test harnesses for the ported code;
              xara/ also builds xara.wasm (build-wasm.sh)
```

### Components in detail

#### Scope

The waterfall uses Google's "Turbo" colour map (see `docs/ui-notes.md`).

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

#### CW decoders

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
applies to dedicated hardware/software CW decoders generally. The app
uses "CW3", the DeepCW decoder, and the mode chip just reads "CW". Two
other decoders are kept but hidden for now (since v84): to offer them
again, set `CW_DECODERS_IN_UI` in `src/client/app.js` to
`['CW1', 'CW2', 'CW3']`; the chip then reads "CW 1"/"CW 2"/"CW 3" and a
click while already in CW cycles CW1 -> CW2 -> CW3 -> CW1. "CW1" is the original decoder
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

#### FT8 and FT4 internals

**FT8 (RX + manual TX)**: since the IC-7300 has no native "FT8" CI-V
mode — the radio only ever sees `USB` — FT8 is an app-level concept
layered on top: opening the FT8 panel puts the radio on USB and starts
decoding 15-second, UTC-slot-aligned band activity from the same RX
audio the CW decoder and voice RX use, showing decoded callsigns/grids/
reports in a band-activity table. Selecting FT8 (and any subsequent band
change while it's active) auto-tunes the dial to that band's standard
FT8 calling frequency. Every transmission is started by the operator:
you compose or pick a message and send it, and the app keys PTT itself
and plays the encoded tone out at the next slot boundary. The guided QSO
sequence (below) suggests each reply, but it never sends one by itself.
Full WSJT-X-style auto-sequencing, where the software decides *and*
transmits each step of a QSO, is deliberately not built: the operator
supervises every transmission. See `docs/ui-notes.md` for the reasoning.
Decoding is
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

The FT8 and FT4 transmit audio fades in and out, which avoids key clicks:
the encoder applies WSJT-X's raised-cosine ramp (about 16 ms for FT8 and
40 ms for FT4), and a test checks it survives the resampling to 48 kHz.

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

#### Audio levels, HTTPS, several browsers and the screen

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

The page also requests a **Screen Wake Lock** as soon as it loads, so a
phone's own screen timeout doesn't interrupt an operator mid-QSO while
they're just listening/watching rather than actively touching the
screen — re-requested automatically whenever the page becomes visible
again after being backgrounded (the browser force-releases the lock
while hidden). Requires a secure context (`https://`, same as the
service worker — see `docs/pwa-notes.md`) and a browser that implements
the API; degrades to the phone's normal screen-timeout behavior
otherwise, with no other effect on the app. See `docs/ui-notes.md`.

#### Compressed audio

The server encodes each compressed format once for all the browsers that
use it, and only while one does. On a Raspberry Pi 4 the Opus encoder
should take a few per cent of one core (it took 1% on a desktop). The
codec code that both ends share is `src/client/audio-codec.js`.

### WebSocket protocol

Plain JSON text frames carry the control protocol; binary frames carry
audio and scope data (tagged, see `docs/ui-notes.md`), multiplexed on the
same connection. See `src/server/protocol.js` for the full JSON message
shapes.

- **Control (JSON, text frames)**: requests (`getFrequency`,
  `setFrequency`, `getMode`, `setMode`, `setDataMode`, `getDataMode`,
  `setPtt`, `getSMeter`, `getSWR`, `getAlc`,
  `setScopeBand`, `setScopeSpan`, `setPreamp`, `getPreamp`,
  `setNoiseReduction`, `getNoiseReduction`, `setNoiseBlanker`,
  `getNoiseBlanker`, `setNotch`, `getNotch`, `setFilter`, `getFilter`,
  `setTuner`, `getTuner`, `setTxPower`, `getTxPower`, `setRxGain`,
  `getRxGain`, `setFt8Active`, `sendFt8`, `sendTty`, `abortTty`, `setJttyActive`,
  `setOliviaActive`, `setVaraActive`, `vara`, `setHellActive`, `setSstvActive`, `endSstvPicture`, `getSstvPictures`,
  `sendSstv`, `abortSstv`, `setWsprActive`, `setWsprTx`, `getBandConditions`)
  correlated by `id`; events (`connected`, `clients`, `frequency`, `mode`, `data-mode`, `ptt`,
  `ptt-timeout`, `cw-text`, `ft8-decodes`, `ft8-tx-status`, `tty-tx-status`,
  `jtty-text`, `olivia-text`, `vara-status`, `vara-text`, `rig-error`, `audio-error`, `scope-error`)
  broadcast without an `id`. The `connected` snapshot carries `clients`,
  how many browsers are connected (this one included); a `clients`
  broadcast (`{count}`) goes to the others whenever a browser connects or
  disconnects. `setFt8Active` arms/disarms RX decoding
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
  `ft8-decodes`/`ft8-tx-status` payload shapes. `sendTty`
  (`{mode: 'RTTY'|'JTTY'|'OLIVIA'|'HELL', text, freqHz?}`) encodes and transmits straight
  away (none of these modes is slotted); progress arrives as `tty-tx-status`
  broadcasts (`sending` → `sent`/`aborted`/`error`), and `abortTty` cuts a
  running transmission short. `setJttyActive` (`{active, txHz?}`) starts and stops
  JTTY decoding and sets the transmit audio frequency (lowest tone) every
  browser shows; decoded messages arrive as `jtty-text` broadcasts
  (`{id, freqHz, snr, text, status: 'growing'|'complete'|'expired', time,
  startTime}`, times in epoch ms), re-sent with the same `id` as a message grows.
  `setOliviaActive` (`{active, centreHz?}`) starts and stops Olivia decoding
  and sets the centre frequency (sending it again retunes); decoded text
  arrives as `olivia-text` broadcasts (`{text, snr, freqOffsetHz, centreHz,
  time}`, a block of up to three characters at a time).
  `setVaraActive` (`{active}`) starts and stops the VARA chat modem. While
  it runs it listens for calls and keys PTT itself. `vara` (`{action:
  'cq'|'connect'|'disconnect'|'send', call?, text?}`) drives it: a CQ
  frame, a call to `call`, the end of a QSO (or of calling), or `text`
  sent as one line. It fails, with a reason, if VARA isn't running or the
  action doesn't fit (`send` with no QSO). The modem's state is the connect
  snapshot's `vara` and the `vara-status` broadcast (`{available, reason,
  callsign, bw, state: 'off'|'starting'|'listening'|'calling'|'connected'|
  'disconnecting', peer, linkBw, pending, busy, ptt, sn, bitrate, buffer,
  heard: [{call, raw, slot, offsetHz, beacon, bw, sn, time}]}`; `call` without
  a VarAC slot suffix, `raw` as heard). The conversation goes out as `vara-text`
  (`{text, own, note, time}`: received text, own text, or a note about the
  link); a page that connects is sent `{replace: true, segments}`, the
  conversation so far.
  `setHellActive` (`{active, toneHz?}`) starts and stops the Feld-Hell
  receiver and sets its tone; the picture arrives as binary
  `BINARY_TYPE.HELL_COLUMNS` frames (below), and the text read from it as
  `hell-text` broadcasts (`{text, time}`: the new characters; with
  `replace: true`, sent to a page that has just connected, the recent text).
  `setSstvActive` (`{active}`) starts and stops the SSTV receiver. A
  picture is announced by an `sstv-start` broadcast (`{id, mode, name,
  width, lines, lineHeight, shiftHz, time}`), its lines follow as binary
  `BINARY_TYPE.SSTV_LINE` frames, and it ends with `sstv-picture` (the same
  fields plus `endTime, complete, linesReceived, slantDeg, png`, the
  slant-corrected picture as base64 PNG). `endSstvPicture` ends the picture
  in progress; `getSstvPictures` returns the recent ones. An `sstv-fsk-id`
  broadcast (`{id, time, text}`) adds the sender's FSK ID to a received
  picture. `sendSstv` (`{rgb, width, height}`: base64 RGB at the size in the
  connect snapshot's `sstvTx`) transmits a picture in `SSTV_TX_MODE` with
  the IDs; progress arrives as `sstv-tx-status` broadcasts (`encoding` →
  `sending` → `sent`/`aborted`/`error`), and `abortSstv` stops it. `sending`
  also carries `elapsedSec`, a `timeline` of the parts (`headerSec,
  pictureSec, fskSec, gapSec, cwSec, totalSec`), the picture's `lines` and
  the picture itself (`png`); a page that connects during a transmission is
  sent the current status, with `elapsedSec` how far in it is.
  `sendEasypal` (`{jpeg}`, base64, at most 4 MB) sends a picture with the
  `EASYPAL_TX_*` settings (the connect snapshot's `easypalTx`: `{mode,
  bandwidth, qam, protection, interleave, rs, seconds, bytesPerSecond,
  maxWidth, maxHeight, callsign}`); `abortEasypal` stops it. Progress goes
  out as `easypal-tx-status` (`{status:
  'preparing'|'sending'|'sent'|'aborted'|'error', durationSec, startTime,
  elapsedSec, fileName, bytes, width, height, quality, jpeg, error}`); a
  page that connects while it is sending gets the current status. The sent
  picture is then broadcast as an `easypal-picture` with `own: true`.
  `setEasypalActive` (`{active}`) starts and stops the EasyPal receiver.
  Its state goes out as `easypal-status` (`{state:
  'idle'|'listening'|'sync'|'receiving', snr, mode, callsign, offsetHz,
  file}`, also the connect snapshot's `easypal`), the top of a JPEG coming
  in as `easypal-preview` (`{transportId, fileName, mime, data}`), and each
  file received as `easypal-picture` (`{id, transportId, time, fileName,
  callsign, mode, snr, segments, recovered, size, mime, data, width,
  height, text}`; JPEG 2000 is sent as a JPEG at most 1600 pixels across). `getEasypalPictures` returns
  the kept files and the current preview.
  `setFaxActive` (`{active}`) starts and stops the radiofax receiver;
  `faxStartNow` starts a chart without a start signal and `faxStop` ends
  one. Receiver state goes out as `fax-status` (`{state:
  'idle'|'listening'|'phasing'|'receiving', lines, clockPpm}`, also the
  connect snapshot's `fax`). A chart is announced by `fax-start` (`{id,
  width, lpm, ioc, phased, clockPpm, time}`), its lines follow as binary
  `BINARY_TYPE.FAX_LINE` frames (chart id, line, width, one grey byte per
  pixel), and it ends with `fax-picture` (`{id, width, lines, time,
  endTime, complete, reason, phased, clockPpm, png}`, a greyscale PNG).
  `getFaxPictures` returns the kept charts and the one coming in so far.
  `setWsprActive` (`{active}`) turns WSPR on and off; `setWsprTx`
  (`{enabled?, txHz?}`) turns WSPR transmit on and off and sets its audio
  frequency (1410-1590 Hz). WSPR's state is the connect snapshot's `wspr`
  and the `wspr-status` broadcast (`{phase: 'idle'|'rx'|'tx', slotStartMs,
  slotEndMs, txEnabled, txHz, txPct, canTransmit, txMessage, txReason?,
  nextTx, upload, uploadStatus, unattended, unattendedBand, bandCycle,
  cycleBands, bandMinutes, tuning, decoding, lastSlotStartMs,
  lastDecodeCount}`). Each decoded slot arrives as a `wspr-decodes`
  broadcast (`{slotStartMs, dialHz, decodes: [{snr, dt, audioHz, drift,
  message, callsign, grid, dbm, type}]}`; with `replace: true`, sent to a
  page that has just connected, the recent spots of every slot).
  `getBandConditions` returns the Current conditions table: `{grid,
  squares, myWindowMin, localWindowMin, localUpdatedMs, localError,
  myError, tags, bands: [{band, myQth: {tag, rangeKm?, stations?, slots?,
  lastMs?}, local: {tag, rangeKm?, stations?, reporters?}}]}`.
  An `app-modes` broadcast (`{ft8Active, freeDvActive, jttyActive, jttyTxHz,
  oliviaActive, oliviaCentreHz, varaActive, hellActive, hellToneHz, sstvActive,
  wsprActive, faxActive}`) goes to the other browsers after any
  `setFt8Active`, `setFreeDvActive`, `setJttyActive`, `setOliviaActive`,
  `setVaraActive`, `setHellActive`, `setSstvActive`, `setWsprActive` or `setFaxActive`, so they show the same mode; the
  connect snapshot has the same fields.
  `sendCw` (`{text, wpm?}`) sends text with the radio's CW keyer;
  progress arrives as `cw-tx-status` broadcasts (`sending` →
  `sent`/`aborted`/`error`, with the text as sent, `wpm`, `durationSec`
  and any `dropped` characters), and `abortCw` stops it.
  `postNote` (`{text}`, up to 200 characters) adds an operator note; the
  connect snapshot's `notes` and the `notes` broadcast (`{notes, posted?,
  cleared?}`) carry the three most recent (`{id, text, time}`, newest
  last). `posted` is set only for a newly added note, which the browsers
  chime for.
- **Audio (binary frames, tagged `BINARY_TYPE.AUDIO`)**: raw 16-bit PCM
  at the server's rate in both directions — no framing/codec requirement,
  chunk sizes are whatever arrives. The default for every browser.
- **Compressed audio (binary frames, tagged `BINARY_TYPE.AUDIO_OPUS` or
  `BINARY_TYPE.AUDIO_ADPCM`)**: a browser asks for one format for its RX
  audio with `setAudioCodec` (`{codec: 'pcm'|'opus'|'adpcm'}`, replies
  `{codec}`); it applies to that browser only and is forgotten when it
  disconnects. Each frame is 20 ms: one Opus packet (16 kHz audio) or one
  12 kHz IMA ADPCM frame (a 4-byte header with the first sample and step
  index, then 4 bits a sample). Mic audio may be sent in any of the three.
  The connect snapshot's `audio.codecs` lists what the server can send,
  and `audio.opusBitrate` the Opus rate. The format code is shared by both
  ends: `src/client/audio-codec.js`.
- **Voice squelch**: `setVoiceSquelch` (`{enabled}`) switches it for
  everyone; the reply and the `voice-squelch` broadcast carry
  `{enabled, active}` (`active`: on and in a voice mode), and the connect
  snapshot has `voiceSquelch`.
- **Scope (binary frames, tagged `BINARY_TYPE.SCOPE_LINE`,
  server→client only)**: one reassembled spectrum line per frame — see
  `src/server/scope-bridge.js` for the exact header format.
- **SSTV lines (binary frames, tagged `BINARY_TYPE.SSTV_LINE`,
  server→client only)**: one received line as it arrives — picture id,
  line number, width, then RGB; see `src/server/protocol.js`.
- **Radiofax lines (binary frames, tagged `BINARY_TYPE.FAX_LINE`,
  server→client only)**: one received chart line — chart id, line number,
  width, then one grey byte per pixel; see `src/server/protocol.js`.
- **Feld-Hell picture (binary frames, tagged `BINARY_TYPE.HELL_COLUMNS`,
  server→client only)**: received columns, about ten frames a second —
  rows per column, column count, tone, then the columns' ink values; see
  `src/server/protocol.js`.

### Testing

- `npm test` runs every test that needs no hardware. It must pass before
  a commit.
- `test/manual-tty-ui.js` drives the real web app in headless Chromium
  against a real ControlServer with a stub radio, with several browsers at
  once. It is not part of `npm test`; run it for any UI change. It needs
  Playwright (set `NODE_PATH` to a Playwright install) and `CHROMIUM_PATH`.
  `test/manual-audio-ui.js` does the same for compressed audio and the
  squelch.
- The other `test/manual-*.js` scripts talk to a real radio (see
  [Hardware diagnostics](#hardware-diagnostics)).
- Nothing counts as tested on air until it has been used on the air. The
  docs say "not tested on air" for anything that transmits until then.

The test files:

```
  frame.test.js           unit tests for CI-V framing/BCD, no hardware needed
  scope.test.js           unit tests for scope waveform decoding/reassembly,
                           synthetic frames, no hardware needed
  civ-driver.test.js      CivDriver integration tests against a fake serial
                           transport: request/reply matching (incl. the
                           subCmd disambiguation fix), scope-line wiring,
                           and scope span/mode/band-range commands
  data-mode-guard.test.js DATA mode confirmed before PTT (read back, retried,
                           settle time) and watched during a transmission
  ws-server.test.js       integration test for the control layer, stubbed
                           CivDriver, no hardware needed
  pcm-framer.test.js      unit tests for PCM frame accumulation
  opus-codec.test.js      real Opus encode/decode round-trip tests (WASM,
                           no hardware needed)
  audio-codec.test.mjs    compressed audio shared by browser and server:
                           ADPCM round trip and edge cases, the streaming
                           resampler (counts, level, anti-aliasing), frame
                           buffering, and which page addresses count as LAN
  voice-squelch.test.js   the voice squelch on synthetic radio audio: shut
                           on noise (with AGC swings and static crashes),
                           a carrier, a keyed carrier and two beating
                           carriers; open from the start of an over at 10,
                           0 and -3 dB SNR and when mistuned, shut 1.5 s
                           after; the output exact and click-free
  mixer.test.js           unit tests for the ALSA mixer helper against an
                           injected fake execFile, no real amixer needed
  audio-bridge.test.js    integration test for the audio bridge: raw PCM,
                           per-browser Opus and ADPCM (sizes, the tone
                           decoded back, mic audio decoded and resampled,
                           encoders only while wanted, RADE's muted path),
                           and the startup volume-maximizing behavior: real
                           WebSocket, fake ALSA I/O, tagged binary frame format
  scope-bridge.test.js    integration test for the scope bridge: real
                           WebSocket, tagged binary frame encode/decode
                           round-trip, coexistence with audio frames
  static-server.test.js   static file server tests: content types, 404s,
                           path-traversal protection
  tls-server.test.js      confirms the server actually works over
                           HTTPS/WSS when TLS_CERT_PATH/TLS_KEY_PATH are set
  readme-version.test.js  checks the README's "Current build" number matches
                           CACHE_NAME in src/client/sw.js
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
  meter-modes.test.mjs    the meter's S-meter / SWR / ALC displays (cycling,
                           SWR while transmitting, the legends, segments
                           and colours) and the Mic gain curve (scaling,
                           peaks rounded off, never folding back)
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
  rtty-encoder.test.js    RTTY AFSK encoder: Baudot shifts, frame timing, and
                           round trips through the app's own RTTY decoder
                           (both polarities, 12/48 kHz, with noise)
  jtty.test.js            JTTY transmit port checked against WSJT-X's own
                           encoder: the spec's 34-bit vectors, 401 reference
                           messages (all exchange profiles), a reference
                           waveform; see third_party/jtty/README.md
  tty-bridge.test.js      RTTY/JTTY/Olivia/Feld-Hell transmit bridge (incl. the
                           RTTY LSB-D/USB-D AFSK switching): PTT, audio, status
                           events, abort, refusals, stub radio and ALSA
  cw-tx-bridge.test.js    CW text through the radio's keyer: speed and
                           break-in set and put back, 30-character pieces,
                           buffer-full retries, Stop, refusals, timing
  jtty-rx.test.js         JTTY receiver: list decoder, multi-frame messages,
                           two signals, noise, gaps, chunking, and WSJT-X's
                           own 10-frame sample recording
  olivia.test.js          Olivia port checked against a reference program built
                           from fldigi's own code (160 symbol sequences, a
                           waveform, 7 receive cases), plus noise, weak
                           signals, tuning range and the 48 kHz path; see
                           third_party/olivia/README.md
  olivia-decoder-bridge.test.js  Olivia receive bridge: arming, retuning, PTT,
                           decimation, spectrum, and a real worker end to end
  vara.test.js            VARA chat: the Xara modem in WebAssembly, and two
                           VARA bridges (each with its real worker) joined by a
                           simulated channel: CQ, call, text both ways,
                           disconnect; PTT, DATA mode, the 30 s and idle limits
  hell.test.js            Feld-Hell port checked against fldigi's own transmit
                           code (40 half-pixel sequences, a waveform), the
                           font, and the received picture clean, in noise,
                           off tune and via 48 kHz; see third_party/feldhell/README.md
  hell-decoder-bridge.test.js  Feld-Hell receive bridge: arming, retuning, PTT,
                           column frames, spectrum, the text read and sent
                           to a page that opens later
  hell-ocr.test.js        Feld-Hell text reader: clean, in noise (error-rate
                           limits), timing errors, off tune, no characters
                           from noise alone, a long stream
  wspr.test.js            WSPR coding against WSJT-X's wsprsim (symbols,
                           hash, message types 1-3) and the decoder on a
                           slot of audio (three signals, two 1.5 Hz apart,
                           start-time offsets, noise alone); see
                           third_party/wsjtx-wsprd/README.md
  band-conditions.test.js Current conditions: grid distances, the 3 x 3
                           squares (with wrap), band of a frequency, range
                           tags, My QTH from decoded slots (heard nothing
                           is Dismal, not listened is N/A, old slots
                           dropped), Local area from a stubbed wspr.live
                           (cache, failure keeps the last answer), no grid
  wspr-bridge.test.js     WSPR bridge: a slot decoded by the real worker,
                           wsprnet.org form fields, power held at 5 W and
                           put back, transmit planning and the audio decoded
                           back, unattended receive and putting the radio back
  sstv.test.js            SSTV receiver: all 25 modes, whole pictures, PySSTV
                           audio, mistuning, clock error (slant), noise, no
                           false pictures, signal loss; see third_party/sstv/README.md
  sstv-decoder-bridge.test.js  SSTV receive bridge with the real worker: line
                           frames, PNG, kept pictures, saving, PTT
  sstv-tx-bridge.test.js  SSTV transmit: radio sequence (DATA MODE, power, PTT),
                           the audio decoded back (picture and FSK ID), Stop,
                           refusals
  fax.test.js             radiofax receiver: start/phasing/stop signals,
                           line-up on the phasing pulse, clock errors of
                           -1000 to +300 ppm corrected, noise (10 and 3 dB),
                           Start now / Stop, a new start signal, phasing
                           with no start signal, Start now during phasing,
                           an unphased slanted chart straightened, a straight
                           chart left alone, phasing with noise-hit lines
                           (all measured, none drawn), real VMC charts
                           (satellite picture, text page) straightened,
                           noise left alone, the clock from the slant,
                           crash-hit lines mended and speckle cut while
                           strokes are kept, clean charts left alone
  easypal.test.js         EasyPal (HamDRM) receiver: QSSTV-made transmissions
                           (modes A, B, E; 4/16/64-QAM; long and short
                           interleave; JPEG, JPEG 2000, Reed-Solomon .rs2)
                           decoded exactly, with the mode, callsign and S/N;
                           noise, mistuning, a burst of static (segments
                           recovered), two transmissions in a row, no false
                           files from noise; the start of an off-air
                           recording of PiRO's own transmitter (KiwiSDR,
                           about 9 dB S/N: header, segments, callsign);
                           Reed-Solomon, CRCs, interleavers; see
                           third_party/qsstv-drm/README.md
  easypal-decoder-bridge.test.js  EasyPal bridge with the real worker:
                           status, pictures (JPEG as sent, JPEG 2000 as JPEG),
                           kept and saved, PTT, the radio set up and put back
  easypal-tx.test.js      EasyPal transmit: the transmitter decoded exactly
                           by our receiver (modes A, B, E; 4/16/64-QAM; RS2);
                           pictures fitted to the time (size and quality);
                           EASYPAL_TX_* settings; the bridge with the real
                           worker: DATA MODE, power, PTT and Stop, all put
                           back; refusals; the last browser leaving
  fax-decoder-bridge.test.js  radiofax bridge: line frames, the chart as a
                           greyscale PNG (decoded back), kept and saved, a
                           page joining part-way, PTT, unsupported rates,
                           the clock error kept across a restart, and learnt
                           from a straightened chart's slant, the radio set
                           up for fax (NR, notch, FIL1) and put back
  jtty-decoder-bridge.test.js  JTTY receive bridge: arming, PTT, decimation,
                           backlog dropping, broadcasts
  manual-tty-ui.js        optional browser test of the TTY button, text box and
                           Send/Stop (needs Playwright and Chromium)
  manual-audio-ui.js      optional browser test of compressed audio: three
                           browsers on full, Opus (WebCodecs) and ADPCM, RX
                           played, the fake microphone sent in each format,
                           the Audio button and its remembered choice, and
                           the Squelch button (noise muted, a voice played,
                           Paused in CW), and the Mic menu (a steady test tone
                           sent at 0, -10, +6, +10 and +20 dB) (needs
                           Playwright and Chromium)
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
  call-alert.test.mjs     the FT8 "someone is calling you" chime rules: what
                           counts as a call, once per caller, 2-minute quiet
                           window, no re-arming from old slots
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
```

### Making a change

- Bump the build with every change to the web app: `CACHE_NAME` in
  `src/client/sw.js` and the "**Current build**" line at the top of this
  README, together (`test/readme-version.test.js` checks they match). The
  new cache name makes browsers load the new files.
- Add a "### <title> (vN)" section at the end of `docs/ui-notes.md`: what
  changed, any real bug and its cause, and the tests.
- Update this README where it applies: the operator text in Part 1, the
  protocol, the test list, the environment variables, troubleshooting.
- Write docs and UI text in plain, short sentences.
- If you publish a fork, set `SOURCE_CODE_URL` to it, so the footer link
  points to the source of the version that is actually running.

### Ported code

Several modems are JavaScript ports of other programs. Each port has a
folder in `third_party/` with what was ported, what differs, how it was
checked against the original, and the original's licence notice:

| Mode | Ported from | Notes |
|---|---|---|
| JTTY | WSJT-X 3.3 | [`third_party/jtty/`](third_party/jtty/README.md) |
| Olivia | fldigi (Pawel Jalocha) | [`third_party/olivia/`](third_party/olivia/README.md) |
| Feld-Hell | fldigi | [`third_party/feldhell/`](third_party/feldhell/README.md) |
| SSTV receive | slowrx (Oona Räisänen) | [`third_party/sstv/`](third_party/sstv/README.md) |
| WSPR | wsprd and wsprsim (WSJT-X) | [`third_party/wsjtx-wsprd/`](third_party/wsjtx-wsprd/README.md) |
| EasyPal | QSSTV (and Dream) | [`third_party/qsstv-drm/`](third_party/qsstv-drm/README.md) |
| VarAC messages and CQ slots | hfmodem (W9SSJ) | [`third_party/hfmodem/`](third_party/hfmodem/README.md) |
| VARA HF modem | Xara (x0rro), compiled to WebAssembly, not ported | [`third_party/xara/`](third_party/xara/README.md) |
| RNNoise (patched demo) | xiph/rnnoise | [`third_party/rnnoise/`](third_party/rnnoise/README.md) |

The DeepCW and HamNoise models are in `models/`, each with its `LICENSE`
and `NOTICE.md`. Keep these notices when you change the code.

---

## Credits
Several of the cooler features in this app are built on the work of others:
- FreeDV support = https://github.com/freedv/rade_c
- FT8/FT4 support = https://github.com/e04/ft8ts
- CW 2 decoder = https://github.com/dawsonjon/HamFist
- CW 3 decoder = https://github.com/e04/web-deep-cw-decoder
- HamNoise denoiser = https://github.com/e04/HamNoise
- RNnoise denoiser = https://jmvalin.ca/demo/rnnoise/
- JTTY support = Ported to JS from https://wsjtx.github.io/wsjtx/index.html
- Olivia support = Ported to JS from Pawel Jalocha's (SP9VRC) MFSK code in fldigi, https://github.com/w1hkj/fldigi
- Feld-Hell support = Ported to JS from fldigi's Feld-Hell modem and font, https://github.com/w1hkj/fldigi
- SSTV receiver = Ported to JS from slowrx by Oona Räisänen (OH2EIQ), https://github.com/windytan/slowrx
- EasyPal (HamDRM) receiver and transmitter = Ported to JS from QSSTV by Johan Maes (ON4QZ) and M. Bos (PA0MBO), https://github.com/ON4QZ/QSSTV, whose transmitter builds on Dream by Volker Fischer (TU Darmstadt)
- WSPR support = Ported to JS from wsprd and wsprsim (K1JT, K9AN) in WSJT-X, https://wsjtx.github.io/wsjtx/index.html
- VarAC messages and slots = Ported to JS from hfmodem by Saul St John (W9SSJ), https://github.com/sstjohn/hfmodem
- VARA chat = Xara, an open-source VARA-compatible modem by x0rro (MIT), compiled to WebAssembly, https://github.com/x0rro/xara. VARA is by Jose Alberto Nieto Ros (EA5HVK).

## Licence

PiRO is licensed under the GNU Affero General Public License, version 3
only (AGPL-3.0-only); see [`LICENSE`](LICENSE). Some of the code and
models it includes come under other licences (AGPL, GPL, ISC, BSD,
Apache and MIT), which allow this. Their notices are in `third_party/` and
`models/`.

The AGPL asks that people who use your PiRO over a network can get its
source code. Set `SOURCE_CODE_URL` to where your version's source is, and
the page footer links to it.
