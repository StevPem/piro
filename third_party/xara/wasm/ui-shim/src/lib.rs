//! Stand-in for xara-ui: just `telemetry::Link`, copied from
//! xara/crates/xara-ui/src/telemetry.rs (MIT, copyright (c) 2026 x0rro).

pub mod telemetry {
    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct Link {
        pub state: String,
        pub level: usize,
        pub peer: String,
        pub bw: String,
        pub passband: (f64, f64),
        pub attempts: u32,
        pub afc_hz: Option<f64>,
    }
}
