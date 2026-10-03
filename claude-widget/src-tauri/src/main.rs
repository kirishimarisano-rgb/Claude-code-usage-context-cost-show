// Claude Widget: listens on 127.0.0.1 for the widget-bridge mod in each local
// Claude Code session, shows what they do, and hands back the Stop presses.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hub;

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, LogicalSize, Manager, State};
use tauri_plugin_notification::NotificationExt;

use hub::{text, Hub};

const PORT: u16 = 47615;
const MAX_BODY: u64 = 64 * 1024;
const NOTIFY_AFTER_MS: u64 = 10_000;

const FULL: (f64, f64) = (720.0, 340.0);
const PILL: (f64, f64) = (340.0, 64.0);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    token: String,
    pinned: bool,
    compact: bool,
    notify: bool,
    lang: String,
}

struct Shared {
    prefs: Mutex<Prefs>,
    hub: Mutex<Hub>,
    path: PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_token() -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut buf = [0u8; 24];
    getrandom::getrandom(&mut buf).expect("the system has no randomness");
    buf.iter().map(|b| ABC[(*b as usize) % ABC.len()] as char).collect()
}

fn load_prefs(path: &PathBuf) -> Prefs {
    let saved = fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Prefs>(&s).ok());
    match saved {
        Some(p) if p.token.len() >= 16 && p.token.chars().all(|c| c.is_ascii_alphanumeric()) => p,
        _ => {
            // The window picks the language on its first run, from the system's.
            let p = Prefs { token: new_token(), pinned: true, compact: false, notify: true, lang: String::new() };
            save_prefs(path, &p);
            p
        }
    }
}

fn save_prefs(path: &PathBuf, p: &Prefs) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(path, serde_json::to_string_pretty(p).unwrap_or_default());
}

// ---------- the listener ----------

fn serve(app: AppHandle, shared: Arc<Shared>) {
    let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(e) => {
            shared.hub.lock().unwrap().error = Some(format!("127.0.0.1:{PORT} is taken ({e})"));
            return;
        }
    };
    for mut req in server.incoming_requests() {
        let (status, body) = handle(&app, &shared, &mut req);
        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status).with_header(header));
    }
}

fn handle(app: &AppHandle, shared: &Shared, req: &mut tiny_http::Request) -> (u16, String) {
    if *req.method() != tiny_http::Method::Post || req.url() != "/v1/sessions" {
        return (404, "{}".into());
    }
    let header = |name: &str| {
        req.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string())
    };
    let (origin, auth) = (header("Origin"), header("Authorization"));
    let mut raw = String::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_string(&mut raw).is_err() || raw.len() as u64 > MAX_BODY {
        return (413, "{}".into());
    }
    let token = shared.prefs.lock().unwrap().token.clone();
    let got = shared.hub.lock().unwrap().receive(&token, origin.as_deref(), auth.as_deref(), &raw, now_ms());
    match got {
        Ok(r) => {
            if let Some(snap) = r.finished {
                notify(app, shared, &snap);
            }
            (200, r.answer)
        }
        Err(status) => (status, "{}".into()),
    }
}

fn notify(app: &AppHandle, shared: &Shared, snap: &Value) {
    let prefs = shared.prefs.lock().unwrap().clone();
    let last = snap.get("last");
    let ms = last.and_then(|l| l.get("ms")).and_then(Value::as_u64).unwrap_or(0);
    if !prefs.notify || ms < NOTIFY_AFTER_MS {
        return;
    }
    let status = last.map(|l| text(l, "status")).unwrap_or_default();
    let zh = prefs.lang == "zh";
    let word = match (status.as_str(), zh) {
        ("error", true) => "出錯",
        ("stopped", true) => "已停止",
        (_, true) => "完成",
        ("error", false) => "failed",
        ("stopped", false) => "stopped",
        _ => "done",
    };
    let secs = ms / 1000;
    let took = if secs >= 60 { format!("{}:{:02}", secs / 60, secs % 60) } else { format!("{secs}s") };
    let title = format!("{} · {word}", text(snap, "project"));
    let prompt = text(snap, "prompt");
    let body = if prompt.is_empty() { took } else { format!("{prompt}\n{took}") };
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------- what the window asks ----------

#[tauri::command]
fn state(shared: State<'_, Arc<Shared>>) -> Value {
    let now = now_ms();
    let prefs = shared.prefs.lock().unwrap().clone();
    let mut hub = shared.hub.lock().unwrap();
    hub.prune(now);
    let sessions: Vec<Value> =
        hub.rows.values().map(|r| json!({ "snap": r.snap, "receivedAt": r.received_at })).collect();
    json!({
        "token": prefs.token,
        "port": PORT,
        "pinned": prefs.pinned,
        "compact": prefs.compact,
        "notify": prefs.notify,
        "lang": prefs.lang,
        "paired": hub.has_heard,
        "error": hub.error,
        "sessions": sessions,
        "now": now,
    })
}

#[tauri::command]
fn stop(shared: State<'_, Arc<Shared>>, id: String, turn_id: String) {
    shared.hub.lock().unwrap().stop(&id, &turn_id);
}

#[tauri::command]
fn set_pref(app: AppHandle, shared: State<'_, Arc<Shared>>, key: String, value: Value) -> Result<(), String> {
    let mut prefs = shared.prefs.lock().unwrap();
    match (key.as_str(), value) {
        ("pinned", Value::Bool(b)) => {
            prefs.pinned = b;
            if let Some(w) = app.get_webview_window("main") {
                w.set_always_on_top(b).map_err(|e| e.to_string())?;
            }
        }
        ("compact", Value::Bool(b)) => {
            prefs.compact = b;
            size_window(&app, b);
        }
        ("notify", Value::Bool(b)) => prefs.notify = b,
        ("lang", Value::String(s)) if s == "zh" || s == "en" => prefs.lang = s,
        _ => return Err("unknown setting".into()),
    }
    save_prefs(&shared.path, &prefs);
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn size_window(app: &AppHandle, is_compact: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let (width, height) = if is_compact { PILL } else { FULL };
        let _ = w.set_size(LogicalSize::new(width, height));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("prefs.json");
            let prefs = load_prefs(&path);
            let (pinned, compact) = (prefs.pinned, prefs.compact);
            let shared = Arc::new(Shared { prefs: Mutex::new(prefs), hub: Mutex::new(Hub::default()), path });
            app.manage(shared.clone());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(pinned);
            }
            size_window(app.handle(), compact);
            let handle = app.handle().clone();
            std::thread::spawn(move || serve(handle, shared));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![state, stop, set_pref, quit])
        .run(tauri::generate_context!())
        .expect("Claude Widget could not start");
}
