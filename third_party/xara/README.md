# Xara (VARA HF modem), in WebAssembly

Xara is an open-source modem by x0rro that is compatible with VARA HF and
VARA FM, written in Rust. PiRO's VARA chat mode runs its VARA HF modem,
compiled to WebAssembly, in a Node worker thread. Nothing is installed on
the Pi for it: `src/audio/xara/xara.wasm` is the whole modem.

| | |
|---|---|
| Upstream | xara 0.1.1, commit `2e96fcd1563c765a0f5731dae9cc9465c4b86ac6`, https://github.com/x0rro/xara |
| Upstream licence | MIT (`LICENSE` here, copied from the xara tree) |
| PiRO licence | AGPL-3.0-only (MIT code may be combined with it; the notice is kept) |
| Copyright | Copyright (c) 2026 x0rro |

Xara's author reports testing it against VARA HF 4.9.0 and VARA FM 4.4.0.
VARA itself (by Jose Alberto Nieto Ros, EA5HVK) is closed source; Xara is an
independent implementation.

## What is here

| File | What it is |
|---|---|
| `build-wasm.sh` | Builds `src/audio/xara/xara.wasm` from the pinned xara commit |
| `xara-wasm.patch` | The only change to xara's own code: xara-host's TCP server, KISS server and writer use Unix sockets, so they are left out on WebAssembly |
| `wasm/` | PiRO's wrapper crate (`xara-wasm`), added to xara's workspace by the build |
| `wasm/src/lib.rs` | The exported functions (`xr_init`, `xr_process`, `xr_command`, `xr_send`, `xr_take`, ...) and the PTT lead delay |
| `wasm/src/tnc.rs` | xara's `crates/xara/src/tnc.rs` (its VARA host interface) without sockets: commands and data come from memory, and the replies and received data are left in buffers. The handling of every VARA command is xara's own code. The web UI telemetry and UI controls are left out. KISS frames heard on air (VarAC's beacons and notices) are always listened for, and passed up as a line of PiRO's own, `KISS <command> <hex>`, instead of to a KISS port |
| `wasm/ui-shim/` | A stand-in for the `xara-ui` crate, which needs sockets and files: just the one type (`telemetry::Link`) that xara's station code names |
| `LICENSE` | xara's MIT licence |

The modem itself, `crates/xara/src/station` and the `xara-phy` and
`xara-arq` crates, is compiled unchanged.

## PiRO's side

| PiRO file | What it does |
|---|---|
| `src/audio/xara/xara.js` | Loads `xara.wasm`. One `XaraModem` is one modem: 48 kHz audio in and out in 10 ms blocks, VARA commands in, replies out, data both ways |
| `src/audio/vara-worker.js` | Runs a `XaraModem` in a worker thread |
| `src/server/vara-bridge.js` | Connects it to the radio: audio, PTT, DATA mode, the browsers |

Settings PiRO uses: 500 Hz bandwidth by default (`VARA_BW`), the VARA Chat
commands (`CHAT ON`, `P2P SESSION`, `COMPRESSION TEXT`), `LISTEN ON`, and
xara's default transmit level (-5 dB). The modem runs unregistered, as VARA
HF does without a licence key: only its slower speed levels are used.

The wrapper tells the modem how far the transmit audio lags what is written
to the sound card (`VARA_AUDIO_LATENCY_MS`, through xara's `tx_latency`
option). Then the modem holds PTT until its audio has gone out and times
its replies to suit. In simulation, an untold delay of 600 ms each way
stopped two modems connecting; told, they connected with delays of up to a
second on one side.

## Building

Needs Rust 1.85 or newer and git:

    third_party/xara/build-wasm.sh [WORKDIR]

It clones xara at the pinned commit into WORKDIR (a temporary directory if
not given), applies the patch, adds the wrapper crate and builds it for
`wasm32-unknown-unknown`. If rustup doesn't have that target (it may not be
downloadable behind a proxy), the script builds Rust's standard library for
WebAssembly from source instead: it uses `rust-src` if installed, or fetches
Rust's `library/` at the compiler's own commit from GitHub, and builds with
`-Z build-std` (allowed on a stable compiler with `RUSTC_BOOTSTRAP=1`).

`xara.wasm` in the repository was built with rustc 1.97.0 (2d8144b78) this
second way. It is about 1 MB, imports nothing, and two builds gave the same
file.

## How it was checked

* `test/vara.test.js`: the modem answers `VERSION` as VARA HF 4.9.0 does,
  and two copies of PiRO's VARA bridge, each with its own modem in a worker,
  joined by a simulated channel with noise: one calls CQ, the other hears
  it, they connect, exchange a line each way and disconnect.
* By hand, with two modems in Node: CQ, connect, text both ways and
  disconnect at 500, 2300 and 2750 Hz, and at 500 Hz down to -10 dB S/N
  (noise in the signal's bandwidth). The first line of text took about
  12 s at 500 Hz. Two modems used about 4% of one core of a 2.1 GHz PC.

Not yet tested against VARA itself, VARA Chat or VarAC, and not tested on
air.
