//! Xara's VARA HF modem as a WebAssembly library for PiRO.
//!
//! One modem per instance of the module. The host (PiRO's worker thread):
//!
//! 1. writes the callsign into memory from `xr_alloc` and calls `xr_init`;
//! 2. calls `xr_process` with every 10 ms of received audio (480 samples at
//!    48 kHz, -1..1) and gets the same number of samples to transmit back;
//!    bit 0 of the result says whether the modem wants PTT;
//! 3. sends VARA commands (`xr_command`, one line without the CR) and data
//!    to transmit (`xr_send`);
//! 4. collects replies (`xr_take(0)`: command-port lines, each ending in CR)
//!    and received data (`xr_take(1)`), reading `xr_take_len` bytes at
//!    `xr_take_ptr`.
//!
//! The modem itself is Xara's, unchanged (crates/xara/src/station, and the
//! xara-phy and xara-arq crates); `tnc.rs` is Xara's host interface without
//! sockets. Xara: https://github.com/x0rro/xara (MIT, copyright (c) 2026 x0rro).

#[path = "../../xara/src/station/mod.rs"]
pub mod station;
mod tnc;

use station::Options;
use std::collections::VecDeque;
use tnc::{Input, Tnc};
use xara_arq::hf;
use xara_phy::hf::level::Bandwidth;

struct Instance {
    tnc: Tnc<station::hf::Station>,
    /// PTT lead: transmit audio is held back this many samples after PTT is
    /// asked for, as xara's TxAudio does, so the radio is keyed in time.
    delay: VecDeque<f64>,
    input: Vec<f64>,
    output: Vec<f64>,
    take: Vec<u8>,
}

static mut INSTANCE: Option<Instance> = None;

#[allow(static_mut_refs)]
fn instance() -> Option<&'static mut Instance> {
    // SAFETY: WebAssembly here is single threaded, and the host calls one export at a time.
    unsafe { INSTANCE.as_mut() }
}

/// Memory for the host to write into (the callsign, audio, commands, data).
#[unsafe(no_mangle)]
pub extern "C" fn xr_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[unsafe(no_mangle)]
pub extern "C" fn xr_free(p: *mut u8, n: usize) {
    if !p.is_null() {
        // SAFETY: p came from xr_alloc(n).
        unsafe { drop(Vec::from_raw_parts(p, 0, n.max(1))) };
    }
}

fn text(p: *const u8, n: usize) -> String {
    // SAFETY: the host passes memory it wrote, n bytes long.
    let b = unsafe { std::slice::from_raw_parts(p, n) };
    String::from_utf8_lossy(b).into_owned()
}

/// Starts the modem: VARA HF at `bw_hz` (500, 2300 or 2750), callsign
/// (`call`, `call_len` bytes), PTT lead `lead_samples` (48 kHz; transmit
/// audio is held back this long after PTT), `extra_samples` more transmit
/// delay that the host's audio path adds on its own, and TX drive
/// `drive_db` (-30..0). The modem is told the whole delay, so it unkeys
/// after the audio has gone and times its replies to suit. Returns 0, or
/// 1 for a bad bandwidth.
#[unsafe(no_mangle)]
pub extern "C" fn xr_init(bw_hz: u32, call: *const u8, call_len: usize, lead_samples: u32, extra_samples: u32, drive_db: f64) -> i32 {
    let bw = match bw_hz {
        500 => Bandwidth::Hz500,
        2300 => Bandwidth::Hz2300,
        2750 => Bandwidth::Hz2750,
        _ => return 1,
    };
    let call = text(call, call_len);
    let mut cfg = hf::Config::new(bw, &call);
    // Unregistered, like a VARA HF without a licence key: its slower speed levels only.
    cfg.host.registered = false;
    let opts = Options { drive_db: drive_db.clamp(-30.0, 0.0), tx_latency: i64::from(lead_samples) + i64::from(extra_samples) };
    let st = station::hf::Station::new(cfg, opts);
    let inst = Instance {
        tnc: Tnc::new(st),
        delay: std::iter::repeat_n(0.0, lead_samples as usize).collect(),
        input: Vec::new(),
        output: Vec::new(),
        take: Vec::new(),
    };
    // SAFETY: as instance().
    unsafe { INSTANCE = Some(inst) };
    0
}

/// A buffer of `n` f32 samples for the host to fill with received audio and
/// read transmit audio back from (the same buffer, after `xr_process`).
#[unsafe(no_mangle)]
pub extern "C" fn xr_audio_buffer(n: usize) -> *mut f32 {
    xr_alloc(n * 4) as *mut f32
}

/// Runs the modem over `n` received samples at `buf` and writes the samples
/// to transmit over them. Returns 1 while the modem wants PTT, else 0.
#[unsafe(no_mangle)]
pub extern "C" fn xr_process(buf: *mut f32, n: usize) -> u32 {
    let Some(inst) = instance() else { return 0 };
    // SAFETY: the host passes a buffer from xr_audio_buffer(n') with n <= n'.
    let s = unsafe { std::slice::from_raw_parts_mut(buf, n) };
    inst.input.clear();
    inst.input.extend(s.iter().map(|&v| f64::from(v)));
    inst.output.clear();
    inst.output.resize(n, 0.0);
    inst.tnc.process(&inst.input, &mut inst.output);
    if !inst.delay.is_empty() {
        inst.delay.extend(inst.output.iter().copied());
        for o in inst.output.iter_mut() {
            *o = inst.delay.pop_front().unwrap_or(0.0);
        }
    }
    for (o, v) in s.iter_mut().zip(&inst.output) {
        *o = *v as f32;
    }
    u32::from(inst.tnc.keyed())
}

/// One VARA command line (no CR), as sent to VARA's command port.
#[unsafe(no_mangle)]
pub extern "C" fn xr_command(p: *const u8, n: usize) {
    let Some(inst) = instance() else { return };
    let line = text(p, n);
    let line = line.trim_end_matches(['\r', '\n']);
    let msg = xara_host::command::parse(line).map_or(Input::Wrong, Input::Command);
    inst.tnc.input.push_back(msg);
}

/// Data to transmit, as written to VARA's data port.
#[unsafe(no_mangle)]
pub extern "C" fn xr_send(p: *const u8, n: usize) {
    let Some(inst) = instance() else { return };
    // SAFETY: as text().
    let b = unsafe { std::slice::from_raw_parts(p, n) }.to_vec();
    inst.tnc.input.push_back(Input::Data(b));
}

/// Moves what the modem has for the host into the take buffer: `which` 0 =
/// command-port lines (each ending in CR), 1 = received data. Returns the
/// length; the bytes are at `xr_take_ptr()` until the next call.
#[unsafe(no_mangle)]
pub extern "C" fn xr_take(which: u32) -> usize {
    let Some(inst) = instance() else { return 0 };
    let src = if which == 0 { &inst.tnc.out.lines } else { &inst.tnc.out.data };
    inst.take.clear();
    inst.take.append(&mut src.borrow_mut());
    inst.take.len()
}

#[unsafe(no_mangle)]
pub extern "C" fn xr_take_ptr() -> *const u8 {
    instance().map_or(std::ptr::null(), |i| i.take.as_ptr())
}

/// Bytes waiting to be sent (VARA's BUFFER).
#[unsafe(no_mangle)]
pub extern "C" fn xr_buffered() -> usize {
    instance().map_or(0, |i| i.tnc.buffered())
}
