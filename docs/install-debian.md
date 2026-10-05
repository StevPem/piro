# Installing on a fresh Debian or Raspberry Pi OS install

This walks through getting the server running on a brand new machine,
from a stock OS install to opening the app in a browser.

**Raspberry Pi OS vs. Debian**: Raspberry Pi OS *is* Debian — every step
below is identical on both. The only two things worth calling out
explicitly are marked **[Raspberry Pi OS]** as you go; everything else
just works the same way regardless of which one you're on, or whether
the machine is a Pi or a generic x86/ARM Debian box.

## What you need

- A Debian or Raspberry Pi OS install (this was written against Debian
  12 "Bookworm" and Raspberry Pi OS Bookworm — newer releases should
  work identically)
- The Icom transceiver connected via USB (this is what provides both the
  CI-V serial control link and, if you want audio, a USB audio codec)
- A few minutes of terminal access, plus `sudo`

---

## 1. Update the system

```bash
sudo apt update && sudo apt full-upgrade -y
```

## 2. Install Node.js 18 or newer

Debian's own package repos usually ship an older Node.js than this
project needs (`>=18`). The official NodeSource setup script is the
simplest reliable way to get a current version — it auto-detects your
CPU architecture, so this is the same command whether you're on a Pi
(ARM) or a regular PC (x86):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x or similar — needs to be 18 or higher
```

## 3. Install system dependencies

```bash
sudo apt install -y git build-essential python3 alsa-utils
```

- `build-essential` + `python3` — needed to compile the `serialport`
  package's native addon during `npm install`. This is the step most
  likely to fail if skipped; `npm install` will show `node-gyp` errors
  without it.
- `alsa-utils` — provides `arecord`/`aplay`/`amixer`, which the audio
  bridge shells out to. Skip this if you only want CI-V rig control
  (frequency/mode/PTT/scope) without RX/TX audio.

## 4. Get the project onto the machine

If you have the project as a zip file, copy it over (e.g. `scp` from
another machine) and unzip it:

```bash
unzip PiRO.zip -d ~/PiRO
cd ~/PiRO
```

If it's in a git repository instead:

```bash
git clone <repository-url> ~/PiRO
cd ~/PiRO
```

## 5. Install the Node dependencies

```bash
npm install
```

## 6. Give your user permission to access the serial port

The USB CI-V connection shows up as a serial device (typically
`/dev/ttyUSB0`), and on Debian that device is normally only writable by
the `dialout` group. Add yourself to it:

```bash
sudo usermod -a -G dialout $USER
```

**Log out and back in** (or reboot) for this to take effect — group
membership changes don't apply to an already-open terminal session. If
you skip this, the server will fail to open the serial port with a
permissions error.

## 7. Connect the radio and find its device name

Plug the radio into the machine via USB, then check what showed up:

```bash
ls /dev/ttyUSB*
```

This is normally `/dev/ttyUSB0` if it's the only USB-serial device
connected. If you have other USB-serial devices too, unplug them
temporarily or check `dmesg | tail` right after plugging the radio in to
see exactly which one it claimed.

## 8. Set up the radio's own CI-V menu settings

The radio needs a few things enabled on its own end before the server
can talk to it — this isn't something the software can do for you:

- **CI-V USB Baud Rate**: note whatever this is set to (19200 is the
  default; higher rates like 115200 are common if you plan to use the
  spectrum scope, which is fairly high-bandwidth). You'll need to match
  this exactly with the `CIV_BAUD_RATE` environment variable below.
- **CI-V Transceive**: should be ON.
- **CI-V Address**: note this too (0x94 is the IC-7300's factory
  default) — you generally don't need to set this explicitly if you're
  using the matching `CIV_RADIO_MODEL`, but it's worth knowing.

## 9. (Optional) Find your audio device name

Skip this step if you don't need RX/TX audio through the browser. With
the radio's USB audio codec connected:

```bash
arecord -l
aplay -l
```

Look for your radio's codec in the list — Icom radios typically show up
with the model name. Note the card name; you'll use it as
`plughw:<name>,0` below.

## 10. Start the server

```bash
CIV_SERIAL_PATH=/dev/ttyUSB0 \
CIV_RADIO_MODEL=IC-7300 \
CIV_BAUD_RATE=19200 \
AUDIO_RX_DEVICE=plughw:CODEC,0 \
npm start
```

Adjust each value to match what you found in the steps above (drop the
`AUDIO_RX_DEVICE` line entirely if you're skipping audio). You should
see log output confirming the CI-V port opened and the server is
listening.

## 11. Open it in a browser

From any device on the same network:

```
http://<the-machine's-hostname-or-IP>:8080
```

You should see the app, with the frequency display populated and the
LED status indicator showing "Connected."

---

## Running it permanently (systemd service)

For a shack machine that should come up on its own at boot, install the
systemd unit that ships in `deploy/`. The full steps (settings file in
`/etc/piro/piro.env`, the `sed` command that fills in your user and folder,
and the day-to-day `systemctl` and `journalctl` commands) are in the main
README under
[Running PiRO as a systemd service](../README.md#running-piro-as-a-systemd-service).

---

## If something doesn't work

- **Serial port permission denied** — you likely skipped the log
  out/in after step 6, or the device path is wrong (recheck `ls
  /dev/ttyUSB*`).
- **`npm install` fails with node-gyp/compiler errors** — `build-essential`
  and `python3` weren't installed (step 3), or Node.js is older than 18.
- **CI-V commands all time out** — check the baud rate matches the
  radio's menu exactly, and that CI-V Transceive is enabled on the radio.
  If another instance of this app (or another CI-V program) is also
  connected to the same serial port, that alone causes this too — only
  one process can hold the port at a time.
- **No audio devices found** — confirm `alsa-utils` is installed and the
  radio's USB audio codec is actually connected (some Icom models need a
  separate USB cable for audio versus CI-V control — check your radio's
  manual).

For anything more specific — the full environment variable reference,
the WebSocket protocol, or hardware-level CI-V diagnostics for scope
span/S-meter/TX power issues — see the main `README.md` and
`docs/civ-notes.md`.
