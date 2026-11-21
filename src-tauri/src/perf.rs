//! Startup timing probes (NTV-1 step 0). Printed only when MOVENA_PERF is set.

use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

pub fn enabled() -> bool {
    std::env::var_os("MOVENA_PERF").is_some()
}

pub fn init() {
    PROCESS_START.get_or_init(Instant::now);
}

pub fn since_start_ms() -> u128 {
    PROCESS_START
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
}

pub fn log(label: &str, duration_ms: Option<u128>, detail: &str) {
    if !enabled() {
        return;
    }
    let duration = duration_ms.map_or(String::new(), |d| format!(" dur={d}ms"));
    eprintln!("[perf] t={}ms {label}{duration} {detail}", since_start_ms());
}

#[tauri::command]
pub fn perf_log(label: String, at: u64, duration_ms: Option<u64>, detail: Option<String>) {
    log(
        &format!("js:{label}"),
        duration_ms.map(u128::from),
        &format!("webview_at={at}ms {}", detail.unwrap_or_default()),
    );
}
