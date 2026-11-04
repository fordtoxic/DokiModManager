//! Google Drive save sync.
//!
//! Each mod's saves are zipped into `<mod>.ddmm-saves.zip` inside a Drive folder
//! named "Doki Doki Mod Manager Saves". Entries are stored as `<role>/<relative path>`
//! (role is "renpy" for %APPDATA%\RenPy\<save_directory>, "game" for <mod>/game/saves)
//! so a download can be restored onto whatever paths the other PC uses.
//!
//! Uses the `drive.file` scope, so the app can only see files it created itself.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rng, RngExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub mod launcher;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPES: &str = "https://www.googleapis.com/auth/drive.file openid email";
const FOLDER_NAME: &str = "Doki Doki Mod Manager Saves";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize, Default, Clone)]
struct DriveState {
    client_id: String,
    client_secret: String,
    refresh_token: Option<String>,
    access_token: Option<String>,
    expires_at: u64,
    email: Option<String>,
    folder_id: Option<String>,
    auto_sync: bool,
    /// Hash of the launcher data last uploaded from this PC.
    #[serde(default)]
    launcher_hash: Option<String>,
    /// Drive modifiedTime of the launcher backup this PC last uploaded or restored.
    #[serde(default)]
    launcher_remote_time: Option<String>,
}

#[derive(Serialize)]
pub struct DriveStatus {
    configured: bool,
    signed_in: bool,
    email: Option<String>,
    auto_sync: bool,
    device: String,
}

#[derive(Deserialize)]
pub struct SyncFolder {
    role: String,
    path: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteSave {
    id: String,
    modified_time: String,
    size: u64,
    device: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn store_dir() -> PathBuf {
    crate::get_current_dir().join("store")
}

fn state_path() -> PathBuf {
    store_dir().join("gdrive.json")
}

fn load_state() -> DriveState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(state: &DriveState) -> Result<(), String> {
    fs::create_dir_all(store_dir()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(state_path(), json).map_err(|e| e.to_string())
}

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut r = rng();
    (0..len)
        .map(|_| CHARS[r.random_range(0..CHARS.len())] as char)
        .collect()
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Escapes a value for use inside single quotes in a Drive search query.
fn query_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

fn remote_file_name(mod_id: &str) -> String {
    let safe: String = mod_id
        .chars()
        .map(|c| if c.is_control() || "/\\".contains(c) { '_' } else { c })
        .collect();
    format!("{}.ddmm-saves.zip", safe)
}

fn device_name() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .unwrap_or_default()
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(google_error(status.as_u16(), &body))
    }
}

/// Turns a Google error response into one readable sentence.
fn google_error(status: u16, body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let reasons: Vec<&str> = v["error"]["details"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(v["error"]["errors"].as_array().into_iter().flatten())
        .filter_map(|d| d["reason"].as_str())
        .collect();
    if reasons.iter().any(|r| *r == "SERVICE_DISABLED" || *r == "accessNotConfigured") {
        let project = v["error"]["details"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|d| d["metadata"]["consumer"].as_str())
            .map(|c| c.trim_start_matches("projects/").to_string());
        return format!(
            "The Google Drive API is turned off for your Google Cloud project{}. Open console.cloud.google.com, \
             go to APIs & Services > Library, search for Google Drive API and click Enable, then try again in a few minutes.",
            project.map(|p| format!(" ({})", p)).unwrap_or_default()
        );
    }
    let message = v["error"]["message"]
        .as_str()
        .or_else(|| v["error_description"].as_str())
        .or_else(|| v["error"].as_str())
        .map(String::from)
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("Google Drive error {}: {}", status, message)
}

/// Returns a valid access token, refreshing it when it is about to expire.
async fn access_token(state: &mut DriveState) -> Result<String, String> {
    if let Some(token) = &state.access_token {
        if state.expires_at > now() + 60 {
            return Ok(token.clone());
        }
    }
    let refresh = state
        .refresh_token
        .clone()
        .ok_or("Not signed in to Google Drive")?;
    let resp = client()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", state.client_id.as_str()),
            ("client_secret", state.client_secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let token: TokenResponse = check(resp)
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    state.access_token = Some(token.access_token.clone());
    state.expires_at = now() + token.expires_in;
    save_state(state)?;
    Ok(token.access_token)
}

/// Blocks until Google redirects the browser back to the loopback listener.
fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if started.elapsed() > SIGN_IN_TIMEOUT {
            return Err("Sign-in timed out. Please try again.".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(conn) => conn,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).ok();
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .unwrap_or("");
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                match k {
                    "code" => code = Some(url_decode(v)),
                    "state" => state = Some(url_decode(v)),
                    "error" => error = Some(url_decode(v)),
                    _ => {}
                }
            }
        }
        if code.is_none() && error.is_none() {
            // Favicon or other stray request; keep waiting.
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        }
        let ok = error.is_none() && state.as_deref() == Some(expected_state);
        let message = if ok {
            "Signed in to Doki Doki Mod Manager. You can close this tab."
        } else {
            "Sign-in was cancelled or failed. You can close this tab."
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Doki Doki Mod Manager</title>\
             <body style=\"font-family:sans-serif;background:#1b1b1b;color:#fff;display:grid;place-items:center;height:100vh;margin:0\">\
             <p style=\"font-size:1.2rem\">{}</p></body>",
            message
        );
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html.len(),
                html
            )
            .as_bytes(),
        );
        if let Some(e) = error {
            return Err(format!("Google sign-in failed: {}", e));
        }
        if !ok {
            return Err("Sign-in response did not match this request.".into());
        }
        return code.ok_or_else(|| "No sign-in code received".into());
    }
}

async fn find_or_create_folder(state: &mut DriveState, token: &str) -> Result<String, String> {
    if let Some(id) = &state.folder_id {
        let resp = client()
            .get(format!("{}/{}", FILES_URL, id))
            .bearer_auth(token)
            .query(&[("fields", "id,trashed")])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            if !v["trashed"].as_bool().unwrap_or(false) {
                return Ok(id.clone());
            }
        }
    }
    let q = format!(
        "name = '{}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        query_escape(FOLDER_NAME)
    );
    let resp = client()
        .get(FILES_URL)
        .bearer_auth(token)
        .query(&[("q", q.as_str()), ("fields", "files(id)"), ("spaces", "drive")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    let id = if let Some(id) = v["files"][0]["id"].as_str() {
        id.to_string()
    } else {
        let resp = client()
            .post(FILES_URL)
            .bearer_auth(token)
            .query(&[("fields", "id")])
            .json(&serde_json::json!({
                "name": FOLDER_NAME,
                "mimeType": "application/vnd.google-apps.folder"
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
        v["id"].as_str().ok_or("Drive did not return a folder id")?.to_string()
    };
    state.folder_id = Some(id.clone());
    save_state(state)?;
    Ok(id)
}

async fn find_remote(token: &str, folder_id: &str, mod_id: &str) -> Result<Option<RemoteSave>, String> {
    find_named(token, folder_id, &remote_file_name(mod_id)).await
}

async fn find_named(token: &str, folder_id: &str, file_name: &str) -> Result<Option<RemoteSave>, String> {
    let q = format!(
        "name = '{}' and '{}' in parents and trashed = false",
        query_escape(file_name),
        query_escape(folder_id)
    );
    let resp = client()
        .get(FILES_URL)
        .bearer_auth(token)
        .query(&[
            ("q", q.as_str()),
            ("fields", "files(id,modifiedTime,size,appProperties)"),
            ("orderBy", "modifiedTime desc"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(v["files"].get(0).map(|f| RemoteSave {
        id: f["id"].as_str().unwrap_or_default().to_string(),
        modified_time: f["modifiedTime"].as_str().unwrap_or_default().to_string(),
        size: f["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        device: f["appProperties"]["device"].as_str().map(String::from),
    }))
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<File>,
    root: &Path,
    dir: &Path,
    role: &str,
    count: &mut usize,
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            add_dir_to_zip(zip, root, &path, role, count)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(format!("{}/{}", role, rel), options)
                .map_err(|e| e.to_string())?;
            let mut f = File::open(&path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, zip).map_err(|e| e.to_string())?;
            *count += 1;
        }
    }
    Ok(())
}

/// Zips the given folders (missing ones are skipped). Returns the number of files written.
fn zip_folders(folders: &[SyncFolder], out: &Path) -> Result<usize, String> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = File::create(out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let mut count = 0;
    for folder in folders {
        let root = PathBuf::from(&folder.path);
        if root.is_dir() {
            add_dir_to_zip(&mut zip, &root, &root, &folder.role, &mut count)?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(count)
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() || "-_ ".contains(c) { c } else { '_' })
        .collect()
}

#[tauri::command]
pub async fn gdrive_status() -> DriveStatus {
    let state = load_state();
    DriveStatus {
        configured: !state.client_id.is_empty(),
        signed_in: state.refresh_token.is_some(),
        email: state.email,
        auto_sync: state.auto_sync,
        device: device_name(),
    }
}

#[tauri::command]
pub async fn gdrive_reset_client() -> Result<(), String> {
    gdrive_sign_out().await?;
    let mut state = load_state();
    state.client_id = String::new();
    state.client_secret = String::new();
    save_state(&state)
}

#[tauri::command]
pub async fn gdrive_configure(client_id: String, client_secret: String) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    if !client_id.ends_with(".apps.googleusercontent.com") {
        return Err("That doesn't look like a Google OAuth client ID (it should end in .apps.googleusercontent.com).".into());
    }
    let mut state = load_state();
    if state.client_id != client_id {
        state.refresh_token = None;
        state.access_token = None;
        state.email = None;
        state.folder_id = None;
    }
    state.client_id = client_id;
    state.client_secret = client_secret.trim().to_string();
    save_state(&state)
}

#[tauri::command]
pub async fn gdrive_set_auto_sync(enabled: bool) -> Result<(), String> {
    let mut state = load_state();
    state.auto_sync = enabled;
    save_state(&state)
}

#[tauri::command]
pub async fn gdrive_sign_in() -> Result<String, String> {
    let mut state = load_state();
    if state.client_id.is_empty() {
        return Err("Add your Google OAuth client ID first.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{}", port);
    let verifier = random_string(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let csrf = random_string(24);
    let url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        AUTH_URL,
        url_encode(&state.client_id),
        url_encode(&redirect),
        url_encode(SCOPES),
        challenge,
        csrf
    );
    open::that(&url).map_err(|e| format!("Couldn't open your browser: {}", e))?;

    let code = tokio::task::spawn_blocking(move || wait_for_code(listener, &csrf))
        .await
        .map_err(|e| e.to_string())??;

    let resp = client()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", state.client_id.as_str()),
            ("client_secret", state.client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let token: TokenResponse = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    let refresh = token
        .refresh_token
        .ok_or("Google didn't return a refresh token. Remove the app's access at myaccount.google.com/permissions and try again.")?;

    let info: serde_json::Value = check(
        client()
            .get(USERINFO_URL)
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?
    .json()
    .await
    .map_err(|e| e.to_string())?;

    state.refresh_token = Some(refresh);
    state.access_token = Some(token.access_token);
    state.expires_at = now() + token.expires_in;
    state.email = info["email"].as_str().map(String::from);
    state.folder_id = None;
    save_state(&state)?;
    Ok(state.email.unwrap_or_default())
}

#[tauri::command]
pub async fn gdrive_sign_out() -> Result<(), String> {
    let mut state = load_state();
    if let Some(token) = state.refresh_token.clone() {
        let _ = client().post(REVOKE_URL).form(&[("token", token)]).send().await;
    }
    state.refresh_token = None;
    state.access_token = None;
    state.email = None;
    state.folder_id = None;
    state.launcher_hash = None;
    state.launcher_remote_time = None;
    save_state(&state)
}

#[tauri::command]
pub async fn gdrive_remote_info(mod_id: String) -> Result<Option<RemoteSave>, String> {
    let mut state = load_state();
    let token = access_token(&mut state).await?;
    let folder = find_or_create_folder(&mut state, &token).await?;
    find_remote(&token, &folder, &mod_id).await
}

#[tauri::command]
pub async fn gdrive_upload(mod_id: String, folders: Vec<SyncFolder>) -> Result<RemoteSave, String> {
    let mut state = load_state();
    let token = access_token(&mut state).await?;
    let folder = find_or_create_folder(&mut state, &token).await?;

    let temp = store_dir()
        .join("temp")
        .join(format!("upload-{}-{}.zip", safe_name(&mod_id), now()));
    let zipped = {
        let temp = temp.clone();
        tokio::task::spawn_blocking(move || zip_folders(&folders, &temp))
            .await
            .map_err(|e| e.to_string())?
    };
    let count = match zipped {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&temp);
            return Err(e);
        }
    };
    if count == 0 {
        let _ = fs::remove_file(&temp);
        return Err("This mod has no save files yet, so there's nothing to upload.".into());
    }
    let bytes = fs::read(&temp).map_err(|e| e.to_string());
    let _ = fs::remove_file(&temp);
    let bytes = bytes?;

    let existing = find_remote(&token, &folder, &mod_id).await?;
    let metadata = serde_json::json!({
        "name": remote_file_name(&mod_id),
        "mimeType": "application/zip",
        "appProperties": { "device": device_name(), "mod": mod_id },
    });

    let resp = if let Some(remote) = existing {
        let boundary = format!("ddmm-{}", random_string(16));
        let meta = serde_json::json!({ "appProperties": metadata["appProperties"] });
        client()
            .patch(format!("{}/{}", UPLOAD_URL, remote.id))
            .bearer_auth(&token)
            .query(&[("uploadType", "multipart"), ("fields", "id,modifiedTime,size,appProperties")])
            .header("Content-Type", format!("multipart/related; boundary={}", boundary))
            .body(multipart_body(&boundary, &meta, &bytes))
            .send()
            .await
            .map_err(|e| e.to_string())?
    } else {
        let boundary = format!("ddmm-{}", random_string(16));
        let mut meta = metadata.clone();
        meta["parents"] = serde_json::json!([folder]);
        client()
            .post(UPLOAD_URL)
            .bearer_auth(&token)
            .query(&[("uploadType", "multipart"), ("fields", "id,modifiedTime,size,appProperties")])
            .header("Content-Type", format!("multipart/related; boundary={}", boundary))
            .body(multipart_body(&boundary, &meta, &bytes))
            .send()
            .await
            .map_err(|e| e.to_string())?
    };
    let v: serde_json::Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(RemoteSave {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        modified_time: v["modifiedTime"].as_str().unwrap_or_default().to_string(),
        size: v["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(bytes.len() as u64),
        device: v["appProperties"]["device"].as_str().map(String::from),
    })
}

fn multipart_body(boundary: &str, meta: &serde_json::Value, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(data.len() + 512);
    body.extend_from_slice(
        format!(
            "--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{m}\r\n--{b}\r\nContent-Type: application/zip\r\n\r\n",
            b = boundary,
            m = meta
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
    body
}

/// Downloads the Drive copy and restores it over the local save folders.
/// The current local saves are zipped to store/save_backups first.
/// Returns the path of that backup (empty if there was nothing to back up).
#[tauri::command]
pub async fn gdrive_download(mod_id: String, folders: Vec<SyncFolder>) -> Result<String, String> {
    let mut state = load_state();
    let token = access_token(&mut state).await?;
    let folder = find_or_create_folder(&mut state, &token).await?;
    let remote = find_remote(&token, &folder, &mod_id)
        .await?
        .ok_or("There are no saves for this mod on Google Drive yet.")?;

    let resp = client()
        .get(format!("{}/{}", FILES_URL, remote.id))
        .bearer_auth(&token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = check(resp).await?.bytes().await.map_err(|e| e.to_string())?;

    let backup_dir = store_dir().join("save_backups");
    tokio::task::spawn_blocking(move || restore(&mod_id, &folders, &bytes, &backup_dir))
        .await
        .map_err(|e| e.to_string())?
}

fn restore(mod_id: &str, folders: &[SyncFolder], bytes: &[u8], backup_dir: &Path) -> Result<String, String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Drive copy is not a valid zip: {}", e))?;

    // Back up what is there now, so a bad download can be undone.
    let backup = backup_dir.join(format!("{}-{}.zip", safe_name(mod_id), now()));
    let backed_up = zip_folders(folders, &backup)?;
    if backed_up == 0 {
        let _ = fs::remove_file(&backup);
    }

    // Only replace folders that the Drive copy actually contains.
    let mut roles_present = std::collections::HashSet::new();
    for i in 0..archive.len() {
        let f = archive.by_index(i).map_err(|e| e.to_string())?;
        if let Some(name) = f.enclosed_name() {
            if let Some(first) = name.components().next() {
                roles_present.insert(first.as_os_str().to_string_lossy().into_owned());
            }
        }
    }
    for folder in folders.iter().filter(|f| roles_present.contains(&f.role)) {
        let root = PathBuf::from(&folder.path);
        if root.is_dir() {
            fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    }

    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let Some(name) = f.enclosed_name() else { continue };
        let mut parts = name.components();
        let Some(role) = parts.next() else { continue };
        let role = role.as_os_str().to_string_lossy();
        let Some(target_root) = folders.iter().find(|x| x.role == role) else { continue };
        let rel: PathBuf = parts.collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = PathBuf::from(&target_root.path).join(rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut file).map_err(|e| e.to_string())?;
    }

    Ok(if backed_up > 0 { backup.to_string_lossy().into_owned() } else { String::new() })
}

/// Sizes (in bytes) of each path; directories are measured recursively, missing paths are 0.
#[tauri::command]
pub async fn ddx_measure(paths: Vec<String>) -> Vec<u64> {
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let path = Path::new(p);
                if path.is_file() {
                    path.metadata().map(|m| m.len()).unwrap_or(0)
                } else if path.is_dir() {
                    jwalk::WalkDir::new(path)
                        .skip_hidden(false)
                        .into_iter()
                        .filter_map(|e| e.ok())
                        .filter(|e| e.file_type().is_file())
                        .filter_map(|e| e.metadata().ok())
                        .map(|m| m.len())
                        .sum()
                } else {
                    0
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Deletes files or folders. Returns how many were removed.
#[tauri::command]
pub async fn ddx_remove(paths: Vec<String>) -> usize {
    paths
        .iter()
        .filter(|p| {
            let path = Path::new(p.as_str());
            if path.is_dir() {
                fs::remove_dir_all(path).is_ok()
            } else if path.is_file() {
                fs::remove_file(path).is_ok()
            } else {
                false
            }
        })
        .count()
}

/// Image hosts the Reddit grabber may send. Anything else is ignored.
const IMAGE_HOSTS: [&str; 4] = ["i.redd.it", "preview.redd.it", "external-preview.redd.it", "i.imgur.com"];
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGES: usize = 40;

#[derive(Serialize)]
pub struct FetchedImage {
    url: String,
    path: String,
}

fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn allowed_image_url(raw: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    IMAGE_HOSTS.contains(&host.as_str()).then_some(url)
}

/// Downloads the images a Reddit post page sent over, into store/temp/reddit_images.
#[tauri::command]
pub async fn ddx_fetch_images(urls: Vec<String>) -> Result<Vec<FetchedImage>, String> {
    let dir = store_dir().join("temp").join("reddit_images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .user_agent("DokiModManager image import")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let mut fetched = Vec::new();
    for raw in urls.iter().take(MAX_IMAGES) {
        let Some(url) = allowed_image_url(raw) else { continue };
        let Ok(resp) = client.get(url.clone()).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let Some(ext) = image_extension(&content_type) else { continue };
        if resp.content_length().is_some_and(|len| len as usize > MAX_IMAGE_BYTES) {
            continue;
        }
        let Ok(bytes) = resp.bytes().await else { continue };
        if bytes.len() > MAX_IMAGE_BYTES {
            continue;
        }
        let name = format!("{}.{}", &hex::encode(Sha256::digest(url.as_str().as_bytes()))[..20], ext);
        let path = dir.join(name);
        if fs::write(&path, &bytes).is_ok() {
            fetched.push(FetchedImage {
                url: url.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    Ok(fetched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(role: &str, path: &Path) -> SyncFolder {
        SyncFolder { role: role.into(), path: path.to_string_lossy().into_owned() }
    }

    #[test]
    fn zip_then_restore_round_trips_and_backs_up() {
        let root = std::env::temp_dir().join(format!("ddmm-gdrive-test-{}", random_string(8)));
        let pc_a_renpy = root.join("a/renpy");
        let pc_a_game = root.join("a/game/saves");
        fs::create_dir_all(pc_a_renpy.join("sub")).unwrap();
        fs::create_dir_all(&pc_a_game).unwrap();
        fs::write(pc_a_renpy.join("persistent"), b"persist-A").unwrap();
        fs::write(pc_a_renpy.join("sub/1-1-LT1.save"), b"slot1-A").unwrap();
        fs::write(pc_a_game.join("2-1-LT1.save"), b"game-A").unwrap();

        let zip_path = root.join("upload.zip");
        let count = zip_folders(&[folder("renpy", &pc_a_renpy), folder("game", &pc_a_game)], &zip_path).unwrap();
        assert_eq!(count, 3);

        // "Other PC" already has different saves, including a file that should disappear.
        let pc_b_renpy = root.join("b/renpy");
        let pc_b_game = root.join("b/game/saves");
        fs::create_dir_all(&pc_b_renpy).unwrap();
        fs::create_dir_all(&pc_b_game).unwrap();
        fs::write(pc_b_renpy.join("persistent"), b"persist-B").unwrap();
        fs::write(pc_b_renpy.join("old.save"), b"old-B").unwrap();

        let bytes = fs::read(&zip_path).unwrap();
        let backups = root.join("backups");
        let backup = restore("Test Mod", &[folder("renpy", &pc_b_renpy), folder("game", &pc_b_game)], &bytes, &backups).unwrap();

        assert_eq!(fs::read(pc_b_renpy.join("persistent")).unwrap(), b"persist-A");
        assert_eq!(fs::read(pc_b_renpy.join("sub/1-1-LT1.save")).unwrap(), b"slot1-A");
        assert_eq!(fs::read(pc_b_game.join("2-1-LT1.save")).unwrap(), b"game-A");
        assert!(!pc_b_renpy.join("old.save").exists());

        // The backup holds B's original saves.
        assert!(!backup.is_empty());
        let mut archive = zip::ZipArchive::new(File::open(&backup).unwrap()).unwrap();
        let mut old = String::new();
        archive.by_name("renpy/old.save").unwrap().read_to_string(&mut old).unwrap();
        assert_eq!(old, "old-B");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_leaves_folders_missing_from_the_zip_alone() {
        let root = std::env::temp_dir().join(format!("ddmm-gdrive-test-{}", random_string(8)));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.save"), b"A").unwrap();
        let zip_path = root.join("only-game.zip");
        zip_folders(&[folder("game", &src)], &zip_path).unwrap();

        let renpy = root.join("dst/renpy");
        let game = root.join("dst/game");
        fs::create_dir_all(&renpy).unwrap();
        fs::write(renpy.join("keep.save"), b"keep").unwrap();
        restore("M", &[folder("renpy", &renpy), folder("game", &game)], &fs::read(&zip_path).unwrap(), &root.join("bk")).unwrap();

        assert_eq!(fs::read(renpy.join("keep.save")).unwrap(), b"keep");
        assert_eq!(fs::read(game.join("a.save")).unwrap(), b"A");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn url_helpers() {
        assert_eq!(url_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(url_decode("4%2F0Ab-x+y"), "4/0Ab-x y");
        assert_eq!(query_escape("it's"), "it\\'s");
        assert_eq!(remote_file_name("Mod/Name"), "Mod_Name.ddmm-saves.zip");
    }

    #[test]
    fn image_url_allowlist() {
        assert!(allowed_image_url("https://i.redd.it/abc123.png").is_some());
        assert!(allowed_image_url("https://preview.redd.it/x.jpg?width=640&s=1").is_some());
        assert!(allowed_image_url("http://i.redd.it/abc.png").is_none());
        assert!(allowed_image_url("https://evil.example/i.redd.it.png").is_none());
        assert!(allowed_image_url("https://i.redd.it.evil.example/a.png").is_none());
        assert!(allowed_image_url("file:///C:/Windows/win.ini").is_none());
        assert_eq!(image_extension("image/jpeg; charset=binary"), Some("jpg"));
        assert_eq!(image_extension("text/html"), None);
    }
}
