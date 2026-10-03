// The sessions the widget knows, kept apart from the window so it can be
// tested on its own.

use std::collections::HashMap;

use serde_json::{json, Value};

const MAX_SESSIONS: usize = 40;
// An ended session stays a while; one not heard from goes later.
const KEEP_ENDED_MS: u64 = 5 * 60_000;
const KEEP_SILENT_MS: u64 = 30 * 60_000;

pub struct Row {
    pub snap: Value,
    pub received_at: u64,
}

#[derive(Default)]
pub struct Hub {
    pub rows: HashMap<String, Row>,
    commands: HashMap<String, Vec<Value>>,
    pub has_heard: bool,
    pub error: Option<String>,
}

pub struct Received {
    // What goes back to the session: the Stop presses waiting for it.
    pub answer: String,
    // The snapshot of a session that just stopped running, to notify about.
    pub finished: Option<Value>,
}

pub fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").chars().take(80).collect()
}

// Equal in time whatever the bytes, so the code cannot be guessed a letter at a time.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Hub {
    // One POST from a session; Err is the HTTP status to refuse it with.
    pub fn receive(&mut self, token: &str, origin: Option<&str>, auth: Option<&str>, raw: &str, now: u64) -> Result<Received, u16> {
        // A web page can reach 127.0.0.1 too; the mod never sends an Origin.
        if origin.is_some() {
            return Err(403);
        }
        if !same(auth.unwrap_or(""), &format!("Bearer {token}")) {
            return Err(401);
        }
        let snap: Value = serde_json::from_str(raw).map_err(|_| 400u16)?;
        let id = text(&snap, "id");
        if !snap.is_object() || snap.get("v").and_then(Value::as_u64) != Some(1) || id.is_empty() {
            return Err(400);
        }
        self.has_heard = true;
        let was = self.rows.get(&id).map(|r| text(&r.snap, "status"));
        let finished = was.as_deref() == Some("running") && text(&snap, "status") != "running";
        self.rows.insert(id.clone(), Row { snap: snap.clone(), received_at: now });
        if self.rows.len() > MAX_SESSIONS {
            if let Some(oldest) = self.rows.iter().min_by_key(|(_, r)| r.received_at).map(|(k, _)| k.clone()) {
                self.rows.remove(&oldest);
            }
        }
        let commands = self.commands.remove(&id).unwrap_or_default();
        Ok(Received { answer: json!({ "commands": commands }).to_string(), finished: finished.then_some(snap) })
    }

    // A Stop press, held for the session's next beat; only for the turn it runs.
    pub fn stop(&mut self, id: &str, turn_id: &str) -> bool {
        let is_running = self
            .rows
            .get(id)
            .map(|r| text(&r.snap, "status") == "running" && text(&r.snap, "turnId") == turn_id)
            .unwrap_or(false);
        if is_running {
            self.commands.entry(id.to_string()).or_default().push(json!({ "kind": "stop", "turnId": turn_id }));
        }
        is_running
    }

    pub fn prune(&mut self, now: u64) {
        self.rows.retain(|_, r| {
            let age = now.saturating_sub(r.received_at);
            age < KEEP_SILENT_MS && !(text(&r.snap, "status") == "ended" && age > KEEP_ENDED_MS)
        });
        let rows = &self.rows;
        self.commands.retain(|id, _| rows.contains_key(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "abcdefghijklmnop1234";
    const AUTH: Option<&str> = Some("Bearer abcdefghijklmnop1234");

    fn snap(status: &str) -> String {
        json!({ "v": 1, "id": "s1", "project": "shop", "status": status, "turnId": "t1", "last": { "status": "ok", "ms": 42000 } }).to_string()
    }

    #[test]
    fn refuses_without_the_code_or_from_a_page() {
        let mut h = Hub::default();
        assert_eq!(h.receive(T, None, None, &snap("idle"), 0).err(), Some(401));
        assert_eq!(h.receive(T, None, Some("Bearer wrong"), &snap("idle"), 0).err(), Some(401));
        assert_eq!(h.receive(T, Some("https://evil.example"), AUTH, &snap("idle"), 0).err(), Some(403));
        assert_eq!(h.receive(T, None, AUTH, "not json", 0).err(), Some(400));
        assert_eq!(h.receive(T, None, AUTH, r#"{"v":2,"id":"x"}"#, 0).err(), Some(400));
        assert!(h.rows.is_empty() && !h.has_heard);
    }

    #[test]
    fn keeps_sessions_and_sees_one_finish() {
        let mut h = Hub::default();
        assert!(h.receive(T, None, AUTH, &snap("running"), 0).unwrap().finished.is_none());
        let done = h.receive(T, None, AUTH, &snap("idle"), 1000).unwrap();
        assert_eq!(text(&done.finished.unwrap(), "project"), "shop");
        assert!(h.receive(T, None, AUTH, &snap("idle"), 2000).unwrap().finished.is_none());
        assert_eq!(h.rows.len(), 1);
    }

    #[test]
    fn hands_a_stop_to_the_turn_it_was_pressed_for() {
        let mut h = Hub::default();
        h.receive(T, None, AUTH, &snap("running"), 0).unwrap();
        assert!(!h.stop("s1", "other"));
        assert!(!h.stop("nobody", "t1"));
        assert!(h.stop("s1", "t1"));
        let r = h.receive(T, None, AUTH, &snap("running"), 1).unwrap();
        assert_eq!(r.answer, r#"{"commands":[{"kind":"stop","turnId":"t1"}]}"#);
        // Handed over once.
        assert_eq!(h.receive(T, None, AUTH, &snap("running"), 2).unwrap().answer, r#"{"commands":[]}"#);
    }

    #[test]
    fn forgets_ended_and_silent_sessions() {
        let mut h = Hub::default();
        h.receive(T, None, AUTH, &snap("ended"), 0).unwrap();
        h.prune(KEEP_ENDED_MS - 1);
        assert_eq!(h.rows.len(), 1);
        h.prune(KEEP_ENDED_MS + 1);
        assert!(h.rows.is_empty());
        h.receive(T, None, AUTH, &snap("idle"), 0).unwrap();
        h.prune(KEEP_SILENT_MS + 1);
        assert!(h.rows.is_empty());
    }

    #[test]
    fn holds_at_most_forty() {
        let mut h = Hub::default();
        for i in 0..45u64 {
            let s = json!({ "v": 1, "id": format!("s{i}"), "status": "idle" }).to_string();
            h.receive(T, None, AUTH, &s, i).unwrap();
        }
        assert_eq!(h.rows.len(), 40);
        assert!(!h.rows.contains_key("s0") && h.rows.contains_key("s44"));
    }
}
