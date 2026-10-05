# Installation

Quick version for getting the server running. For a full walkthrough on a
fresh Debian/Raspberry Pi OS install (including systemd setup and
troubleshooting), see [`docs/install-debian.md`](docs/install-debian.md).

## What you need

- Node.js 18 or newer
- The Icom transceiver connected via USB
- Linux (Debian/Raspberry Pi OS recommended)

## Steps

1. **Get the project onto the machine**

   If you have it as a zip file:

   ```bash
   unzip PiRO.zip -d ~/PiRO
   cd ~/PiRO
   ```

   If it's in a git repository instead:

   ```bash
   git clone <repository-url> ~/PiRO
   cd ~/PiRO
   ```

2. **Install the dependencies**

   ```bash
   npm install
   ```

3. **Give yourself permission to use the serial port** (one-time, then
   log out and back in)

   ```bash
   sudo usermod -a -G dialout $USER
   ```

4. **Find your radio's serial device**

   ```bash
   ls /dev/ttyUSB*
   ```

   This is usually `/dev/ttyUSB0`.

5. **Start the server**

   ```bash
   CIV_SERIAL_PATH=/dev/ttyUSB0 \
   CIV_RADIO_MODEL=IC-7300 \
   AUDIO_RX_DEVICE=plughw:CODEC,0 \
   npm start
   ```

   Drop the `AUDIO_RX_DEVICE` line if you don't need RX/TX audio in the
   browser. Run `arecord -l` to find your radio's actual audio device
   name if you do.

6. **Open it in a browser**

   ```
   http://<this-machine's-hostname-or-IP>:8080
   ```

That's it — you should see the app with the frequency display populated
and the status LED showing "Connected."

## More detail

- Full step-by-step guide and troubleshooting:
  [`docs/install-debian.md`](docs/install-debian.md)
- systemd service, RNNoise and other optional components, and every
  environment variable: [`README.md`](README.md)
