//! The VARA host interface, without sockets: adapted from
//! xara/crates/xara/src/tnc.rs (MIT, copyright (c) 2026 x0rro).
//!
//! Xara's own `Tnc` reads commands and data from its TCP server and writes
//! replies back to it. This one takes them from memory and leaves the
//! replies (command lines, each ending in CR) and received data in buffers
//! for the caller to collect. The KISS port, the web UI's telemetry and the
//! UI's tune/restart controls are left out; everything else, including the
//! handling of every VARA command, is Xara's own code.

use crate::station::{HostConfig, Modem, Report, TX_RING_BYTES};
use std::cell::RefCell;
use std::collections::VecDeque;
use xara_arq::compression::Compression;
use xara_arq::host::{HostEvent, LinkBw};
use xara_arq::time::{SECOND, Time};
use xara_host::command::{Command, Comp, DRIVE_MIN_DB, Drive, Invalid};
use xara_host::response::{LinkWidth, Response};
use xara_phy::fm::level::FmBandwidth;

const REGISTERED_AFTER: Time = 5 * SECOND;
const HOST_TUNE_LIMIT: Time = 60 * SECOND;
const ALIVE_EVERY: Time = 60 * SECOND;

pub enum Input {
    Command(Command),
    Wrong,
    Data(Vec<u8>),
}

/// What Xara's TCP server would have sent: lines for the command port,
/// bytes for the data port.
#[derive(Default)]
pub struct Outbox {
    pub lines: RefCell<Vec<u8>>,
    pub data: RefCell<Vec<u8>>,
}

pub struct Tnc<M: Modem> {
    station: M,
    pub input: VecDeque<Input>,
    pub out: Outbox,
    keyed: bool,
    alive_at: Time,
    registered_at: Option<Time>,
    deferred_mycall: Option<Result<Vec<String>, Invalid>>,
    saved_retries: u32,
    busy: bool,
    tune_until: Option<Time>,
}

impl<M: Modem> Tnc<M> {
    pub fn new(station: M) -> Self {
        Self {
            alive_at: station.now() + ALIVE_EVERY,
            station,
            input: VecDeque::new(),
            out: Outbox::default(),
            keyed: false,
            registered_at: None,
            deferred_mycall: None,
            saved_retries: 0,
            busy: false,
            tune_until: None,
        }
    }

    pub fn keyed(&self) -> bool {
        self.keyed
    }

    pub fn buffered(&self) -> usize {
        self.station.buffered()
    }

    fn service(&mut self) {
        while let Some(i) = self.input.pop_front() {
            match i {
                Input::Command(c) => self.command(c),
                Input::Wrong => self.say(Response::Wrong),
                Input::Data(d) => self.station.send(&d),
            }
        }
        self.flush();
    }

    pub fn process(&mut self, input: &[f64], output: &mut [f64]) {
        self.service();
        self.station.process(input, output);
        let now = self.station.now();
        if now >= self.alive_at {
            self.alive_at += ALIVE_EVERY;
            self.say(Response::IAmAlive);
        }
        if self.registered_at.is_some_and(|t| now >= t) {
            self.registered_at = None;
            let cfg = self.station.config();
            self.say(Response::Registered(cfg.host().registered.then(|| cfg.host().mycalls.clone())));
            self.say(Response::EncryptionDisabled);
        }
        self.flush();
        if self.station.busy() != self.busy {
            self.report_busy(self.station.busy());
        }
        if self.tune_until.is_some_and(|t| !self.station.tuning() || now >= t) {
            self.tune_until = None;
            self.station.tune(false);
        }
    }

    fn set_drive(&mut self, db: f64) -> f64 {
        let db = db.clamp(DRIVE_MIN_DB, 0.0).round_ties_even();
        self.station.set_drive(db);
        db
    }

    fn say(&self, r: Response) {
        let mut l = self.out.lines.borrow_mut();
        l.extend_from_slice(r.to_string().as_bytes());
        l.push(b'\r');
    }

    fn report_busy(&mut self, on: bool) {
        self.busy = on;
        self.say(Response::Busy(on));
    }

    fn toggle_busy(&mut self) {
        self.report_busy(!self.busy);
    }

    fn idle(&self) -> bool {
        self.station.idle()
    }

    fn reconfigure(&mut self, f: impl Fn(&mut M::Config)) -> bool {
        let mut cfg = self.station.config().clone();
        f(&mut cfg);
        self.station.reconfigure(cfg)
    }

    fn set_mycalls(&mut self, calls: Vec<String>) {
        if self.reconfigure(|c| c.host_mut().mycalls = calls.clone()) {
            self.registered_at = Some(self.station.now() + REGISTERED_AFTER);
        }
    }

    fn set_chat(&mut self, on: bool) {
        if !self.reconfigure(|c| c.host_mut().chat = on) {
            self.station.update(|c| c.host_mut().chat = on);
        }
    }

    fn command(&mut self, c: Command) {
        let idle = self.idle();
        let ok = match c {
            Command::Connect { mycall, remote } => !self.station.ptt() && self.station.connect(&mycall, &remote, &[]),
            Command::ConnectVia { mycall, remote, vias } => {
                M::VIAS
                    && !self.station.ptt()
                    && !vias.contains(&mycall)
                    && self.station.connect(&mycall, &remote, &vias)
            }
            Command::Mycall(calls) if !idle => {
                self.deferred_mycall = Some(calls);
                false
            }
            Command::Mycall(Ok(calls)) => {
                self.deferred_mycall = None;
                self.set_mycalls(calls);
                true
            }
            Command::Mycall(Err(Invalid)) => {
                self.say(Response::Wrong);
                true
            }
            Command::CqFrame { call, bw } => idle && self.station.cq_frame(&call, bw.as_deref()),
            Command::Disconnect => {
                self.station.disconnect();
                true
            }
            Command::Abort => {
                self.station.abort();
                true
            }
            Command::Chat(on) if idle => {
                if on {
                    self.toggle_busy();
                }
                // Xara's server only allows chat with both ports open; here both always are.
                self.set_chat(on);
                if on {
                    self.station.set_listen(true);
                }
                true
            }
            Command::Chat(_) => false,
            Command::WinlinkSession | Command::P2pSession => {
                self.station.set_p2p(c == Command::P2pSession);
                true
            }
            Command::Retries(v) => {
                let cur = self.station.config().host().retries;
                let new = match v {
                    Ok(0) if self.saved_retries > 0 => Some(self.saved_retries),
                    Ok(0) | Err(Invalid) => None,
                    Ok(n) => {
                        self.saved_retries = cur;
                        Some(u32::from(n))
                    }
                };
                if let Some(n) = new {
                    self.station.update(|c| c.host_mut().retries = n);
                }
                true
            }
            Command::Listen(on) => {
                let linked = !idle;
                self.station.set_listen(on);
                self.say(Response::Ok);
                if linked {
                    self.station.drop_link();
                }
                return;
            }
            Command::Compression(m) => {
                let m = match m {
                    Comp::Off => Compression::Off,
                    Comp::Text => Compression::Text,
                    Comp::Files => Compression::Files,
                };
                self.station.update(|c| c.host_mut().compression = m);
                true
            }
            Command::Bw(b) => idle && self.station.set_bw(b),
            Command::Gateway | Command::Cwid(_) => M::CWID_GATEWAY,
            Command::Public(_) => true,
            Command::TuneOff => {
                self.tune_until = None;
                self.station.tune(false)
            }
            Command::Tune(d) => {
                self.say(Response::Ok);
                match d {
                    Drive::OutOfRange => return,
                    Drive::Db(db) => {
                        self.set_drive(f64::from(db));
                    }
                    Drive::NotNumeric => {}
                }
                if !self.station.tuning() && self.station.tune(true) {
                    self.tune_until = Some(self.station.now() + HOST_TUNE_LIMIT);
                }
                return;
            }
            Command::DriveLevel(d) => {
                if let Drive::Db(db) = d {
                    self.set_drive(f64::from(db));
                }
                true
            }
            Command::IgnoreKissDcd(on) => {
                self.station.set_ignore_dcd(on);
                true
            }
            Command::TuneQuery => {
                self.say(Response::Tune(self.station.options().drive_db.round()));
                return;
            }
            Command::CleanTxBuffer => {
                self.say(Response::CleanTxBuffer { empty: self.station.buffered() == 0 });
                return;
            }
            Command::Version => {
                self.say(Response::Version(M::VERSION));
                return;
            }
        };
        self.say(if ok { Response::Ok } else { Response::Wrong });
    }

    fn flush(&mut self) {
        while let Some(r) = self.station.pop() {
            match r {
                Report::Trace(_) | Report::Kiss(..) => {}
                Report::Ptt(on) => {
                    self.keyed = on;
                    self.say(Response::Ptt(on))
                }
                Report::Busy(on) => {
                    if on != self.busy {
                        self.report_busy(on);
                    }
                }
                Report::UnencryptedLink => self.say(Response::UnencryptedLink),
                Report::Line(l) => self.say(Response::Line(l)),
                Report::Bitrate { level, bps, tx } => self.say(Response::Bitrate { level, bps, tx }),
                Report::Host(HostEvent::Data(d)) => self.out.data.borrow_mut().extend_from_slice(&d),
                Report::Host(HostEvent::Disconnected) => {
                    let deferred = self.deferred_mycall.take();
                    if let Some(Err(Invalid)) = deferred {
                        self.say(Response::Wrong);
                    }
                    self.say(Response::Disconnected);
                    if let Some(Ok(calls)) = deferred {
                        self.set_mycalls(calls);
                    }
                }
                Report::Host(h) => {
                    if let Some(r) = response(h) {
                        self.say(r);
                    }
                }
            }
        }
        let _ = TX_RING_BYTES;
    }
}

fn response(h: HostEvent) -> Option<Response> {
    Some(match h {
        HostEvent::Pending => Response::Pending,
        HostEvent::CancelPending => Response::CancelPending,
        HostEvent::Connected { caller, answerer, vias, bw } => {
            let width = match bw {
                LinkBw::Hf(b) => LinkWidth::Hz(b.hz()),
                LinkBw::Fm(FmBandwidth::Narrow) => LinkWidth::Narrow,
                LinkBw::Fm(FmBandwidth::Wide) => LinkWidth::Wide,
            };
            Response::Connected { caller, answerer, vias, width }
        }
        HostEvent::Disconnected => Response::Disconnected,
        HostEvent::Registered(r) => Response::LinkRegistered(r),
        HostEvent::Buffer(n) => Response::Buffer(n),
        HostEvent::Sn(s) => Response::Sn(s),
        HostEvent::UnableToConnect
        | HostEvent::TimedOut
        | HostEvent::Data(_)
        | HostEvent::Unencrypted
        | HostEvent::RxFrame(_)
        | HostEvent::Log(_) => return None,
    })
}
