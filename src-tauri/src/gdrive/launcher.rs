//! Launcher data backup.
//!
//! Everything the launcher remembers that isn't a game save goes into one zip,
//! `launcher-data.ddmm.zip`, in the same Drive folder as the saves:
//!
//! - `client-config.json`: theme, cover, play time, sort/filter, sidebar layout
//! - `mods/<mod folder>.json`: each mod's rating, status, Reddit link, pins,
//!   favourite, cover, icon, background and play time
//! - `images/*`: imported covers, `mod_art/*`: custom icons and backgrounds
//!
//! Settings that only make sense on the PC that wrote them (executable paths,
//! save folders, sync markers) are left out. Restoring merges onto what is here;
//! mods that aren't installed yet are kept in `store/synced_mods` and applied
//! when a mod with the same folder name is added.

use super::*;
use serde_json::{Map, Value};

const FILE_NAME: &str = "launcher-data.ddmm.zip";
const MANIFEST: &str = "manifest.json";
const ART_MARK: &str = "@mod_art/";
const LOCAL_MOD_KEYS: &[&str] = &["renpy", "executable", "save_dir", "size", "gdrive_synced", "credits"];
const LOCAL_PROGRAM_KEYS: &[&str] = &["version", "user_name"];

struct Paths {
    root: PathBuf,
    store: PathBuf,
    mods: PathBuf,
}

impl Paths {
    fn current() -> Paths {
        let root = crate::get_current_dir();
        let store = root.join("store");
        let mods = fs::read_to_string(root.join("DNNconfig.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["directory"].as_str().map(PathBuf::from))
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| store.join("mods"));
        Paths { root, store, mods }
    }
    fn art(&self) -> PathBuf {
        self.store.join("mod_art")
    }
    fn images(&self) -> PathBuf {
        self.store.join("images")
    }
    fn pending(&self) -> PathBuf {
        self.store.join("synced_mods")
    }
}

#[derive(Serialize)]
pub struct LauncherInfo {
    remote: Option<RemoteSave>,
    /// Drive time of the backup this PC last uploaded or restored.
    synced_time: Option<String>,
}

#[derive(Serialize)]
pub struct UploadResult {
    /// "uploaded", "unchanged" or "remote_changed" (another PC uploaded since; nothing was sent).
    status: String,
    remote: Option<RemoteSave>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct WaitingMod {
    name: String,
    reddit: String,
}

#[derive(Serialize, Debug)]
pub struct RestoreReport {
    mods_applied: Vec<String>,
    mods_waiting: Vec<WaitingMod>,
    covers: usize,
    art: usize,
    backup: String,
    #[serde(skip)]
    hash: String,
}

struct Built {
    bytes: Vec<u8>,
    hash: String,
}

fn read_json(path: &Path) -> Option<Map<String, Value>> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
}

fn write_json(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

/// A bare file name that can't climb out of the folder it is written into.
fn plain_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(|c| c.is_control());
    ok.then_some(name)
}

fn file_name_of(path: &str) -> Option<String> {
    path.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).map(String::from)
}

/// Rewrites art paths inside a mod config with `f`: the background string and icon.image.
fn map_art(config: &mut Map<String, Value>, f: &dyn Fn(&str) -> Option<String>) {
    if let Some(Value::String(bg)) = config.get("background") {
        if let Some(new) = f(bg) {
            config.insert("background".into(), Value::String(new));
        }
    }
    if let Some(Value::Object(icon)) = config.get_mut("icon") {
        if let Some(Value::String(image)) = icon.get("image") {
            if let Some(new) = f(image) {
                icon.insert("image".into(), Value::String(new));
            }
        }
    }
}

/// Absolute paths into this PC's mod_art folder become `@mod_art/<file>`.
fn portable_art(config: &mut Map<String, Value>) {
    map_art(config, &|p| {
        let lower = p.replace('\\', "/").to_lowercase();
        if lower.contains("/store/mod_art/") {
            file_name_of(p).map(|n| format!("{}{}", ART_MARK, n))
        } else {
            None
        }
    });
}

/// `@mod_art/<file>` becomes a path into this PC's mod_art folder.
fn local_art(config: &mut Map<String, Value>, art_dir: &Path) {
    map_art(config, &|p| {
        p.strip_prefix(ART_MARK)
            .and_then(plain_name)
            .map(|n| art_dir.join(n).to_string_lossy().into_owned())
    });
}

fn mod_entry(mut config: Map<String, Value>) -> Map<String, Value> {
    for key in LOCAL_MOD_KEYS {
        config.remove(*key);
    }
    portable_art(&mut config);
    config
}

fn json_bytes(map: &Map<String, Value>) -> Vec<u8> {
    serde_json::to_vec_pretty(&Value::Object(map.clone())).unwrap_or_default()
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect())
        .unwrap_or_default();
    files.sort();
    files
}

fn build(p: &Paths, device: &str) -> Result<Built, String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut manifest_mods = Vec::new();

    if let Some(mut config) = read_json(&p.root.join("client-config.json")) {
        for key in LOCAL_PROGRAM_KEYS {
            config.remove(*key);
        }
        entries.push(("client-config.json".into(), json_bytes(&config)));
    }

    let mut installed = std::collections::HashSet::new();
    let mut mod_dirs: Vec<PathBuf> = fs::read_dir(&p.mods)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    mod_dirs.sort();
    for dir in mod_dirs {
        let Some(name) = dir.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        let Some(config) = read_json(&dir.join(".ddmm.config.json")) else { continue };
        installed.insert(name.clone());
        let config = mod_entry(config);
        manifest_mods.push(serde_json::json!({
            "name": name,
            "reddit": config.get("reddit").cloned().unwrap_or(Value::Null),
        }));
        entries.push((format!("mods/{}.json", name), json_bytes(&config)));
    }
    // Mods restored from another PC that haven't been reinstalled here yet
    for file in files_in(&p.pending()) {
        let Some(name) = file.file_stem().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if installed.contains(&name) {
            continue;
        }
        let Some(config) = read_json(&file) else { continue };
        let config = mod_entry(config);
        manifest_mods.push(serde_json::json!({
            "name": name,
            "reddit": config.get("reddit").cloned().unwrap_or(Value::Null),
        }));
        entries.push((format!("mods/{}.json", name), json_bytes(&config)));
    }

    for (folder, dir) in [("images", p.images()), ("mod_art", p.art())] {
        for file in files_in(&dir) {
            let Some(name) = file.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
            let bytes = fs::read(&file).map_err(|e| e.to_string())?;
            entries.push((format!("{}/{}", folder, name), bytes));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    // The hash covers the content only, so an unchanged library isn't re-uploaded.
    let mut hasher = Sha256::new();
    for (name, bytes) in &entries {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    let hash: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();

    let manifest = serde_json::json!({
        "format": 1,
        "device": device,
        "created": now(),
        "mods": manifest_mods,
    });
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(MANIFEST, options).map_err(|e| e.to_string())?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    for (name, bytes) in &entries {
        zip.start_file(name.as_str(), options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let bytes = zip.finish().map_err(|e| e.to_string())?.into_inner();
    Ok(Built { bytes, hash })
}

fn max_number(a: Option<&Value>, b: &Value) -> Value {
    match (a.and_then(Value::as_f64), b.as_f64()) {
        (Some(x), Some(y)) if x > y => a.cloned().unwrap_or(Value::Null),
        _ => b.clone(),
    }
}

/// Copies `remote` over `local`, skipping `skip` keys and keeping the larger play time.
fn merge(local: &mut Map<String, Value>, remote: Map<String, Value>, skip: &[&str], time_keys: &[&str]) {
    for (key, value) in remote {
        if skip.contains(&key.as_str()) {
            continue;
        }
        let value = if time_keys.contains(&key.as_str()) { max_number(local.get(&key), &value) } else { value };
        local.insert(key, value);
    }
}

fn apply(p: &Paths, bytes: &[u8], device: &str) -> Result<RestoreReport, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("The Drive copy is not a valid launcher backup: {}", e))?;

    // Keep what is here now, so a restore can be undone.
    let backup = p.store.join("launcher_backups").join(format!("launcher-{}.zip", now()));
    let current = build(p, device)?;
    fs::create_dir_all(backup.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&backup, &current.bytes).map_err(|e| e.to_string())?;

    let mut report = RestoreReport {
        mods_applied: Vec::new(),
        mods_waiting: Vec::new(),
        covers: 0,
        art: 0,
        backup: backup.to_string_lossy().into_owned(),
        hash: String::new(),
    };

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        if file.is_dir() {
            continue;
        }
        let entry = file.name().to_string();
        let mut data = Vec::new();
        file.read_to_end(&mut data).map_err(|e| e.to_string())?;

        let (folder, name) = match entry.split_once('/') {
            Some((f, n)) => (f, n),
            None => ("", entry.as_str()),
        };
        match folder {
            "" if name == "client-config.json" => {
                let Ok(Value::Object(remote)) = serde_json::from_slice::<Value>(&data) else { continue };
                let path = p.root.join("client-config.json");
                let mut local = read_json(&path).unwrap_or_default();
                merge(&mut local, remote, LOCAL_PROGRAM_KEYS, &["totalTime"]);
                write_json(&path, &local)?;
            }
            "images" | "mod_art" => {
                let Some(name) = plain_name(name) else { continue };
                let dir = if folder == "images" { p.images() } else { p.art() };
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                fs::write(dir.join(name), &data).map_err(|e| e.to_string())?;
                if folder == "images" {
                    report.covers += 1;
                } else {
                    report.art += 1;
                }
            }
            "mods" => {
                let Some(mod_name) = name.strip_suffix(".json").and_then(plain_name) else { continue };
                let Ok(Value::Object(mut remote)) = serde_json::from_slice::<Value>(&data) else { continue };
                for key in LOCAL_MOD_KEYS {
                    remote.remove(*key);
                }
                local_art(&mut remote, &p.art());
                let mod_dir = p.mods.join(mod_name);
                if mod_dir.is_dir() {
                    let path = mod_dir.join(".ddmm.config.json");
                    let mut local = read_json(&path).unwrap_or_default();
                    merge(&mut local, remote, &[], &["time"]);
                    write_json(&path, &local)?;
                    report.mods_applied.push(mod_name.to_string());
                } else {
                    let reddit = remote.get("reddit").and_then(Value::as_str).unwrap_or_default().to_string();
                    write_json(&p.pending().join(format!("{}.json", mod_name)), &remote)?;
                    report.mods_waiting.push(WaitingMod { name: mod_name.to_string(), reddit });
                }
            }
            _ => {}
        }
    }
    report.hash = build(p, device)?.hash;
    Ok(report)
}

async fn put(token: &str, folder: &str, existing: Option<&RemoteSave>, bytes: Vec<u8>) -> Result<RemoteSave, String> {
    let boundary = format!("ddmm-{}", random_string(16));
    let props = serde_json::json!({ "device": device_name(), "kind": "launcher" });
    let request = match existing {
        Some(remote) => {
            let meta = serde_json::json!({ "appProperties": props });
            client()
                .patch(format!("{}/{}", UPLOAD_URL, remote.id))
                .body(multipart_body(&boundary, &meta, &bytes))
        }
        None => {
            let meta = serde_json::json!({
                "name": FILE_NAME,
                "mimeType": "application/zip",
                "parents": [folder],
                "appProperties": props,
            });
            client().post(UPLOAD_URL).body(multipart_body(&boundary, &meta, &bytes))
        }
    };
    let resp = request
        .bearer_auth(token)
        .query(&[("uploadType", "multipart"), ("fields", "id,modifiedTime,size,appProperties")])
        .header("Content-Type", format!("multipart/related; boundary={}", boundary))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(RemoteSave {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        modified_time: v["modifiedTime"].as_str().unwrap_or_default().to_string(),
        size: v["size"].as_str().and_then(|s| s.parse().ok()).unwrap_or(bytes.len() as u64),
        device: v["appProperties"]["device"].as_str().map(String::from),
    })
}

#[tauri::command]
pub async fn gdrive_launcher_info() -> Result<LauncherInfo, String> {
    let mut state = load_state();
    let token = access_token(&mut state).await?;
    let folder = find_or_create_folder(&mut state, &token).await?;
    let remote = find_named(&token, &folder, FILE_NAME).await?;
    Ok(LauncherInfo { remote, synced_time: load_state().launcher_remote_time })
}

/// Uploads the launcher data. Without `force` nothing is sent when it hasn't
/// changed, or when another PC uploaded a backup this PC hasn't seen yet.
#[tauri::command]
pub async fn gdrive_launcher_upload(force: bool) -> Result<UploadResult, String> {
    let mut state = load_state();
    let token = access_token(&mut state).await?;
    let folder = find_or_create_folder(&mut state, &token).await?;
    let remote = find_named(&token, &folder, FILE_NAME).await?;

    if !force {
        if let Some(r) = &remote {
            if state.launcher_remote_time.as_deref() != Some(r.modified_time.as_str()) {
                return Ok(UploadResult { status: "remote_changed".into(), remote });
            }
        }
    }

    let device = device_name();
    let built = tokio::task::spawn_blocking(move || build(&Paths::current(), &device))
        .await
        .map_err(|e| e.to_string())??;
    if !force && remote.is_some() && state.launcher_hash.as_deref() == Some(built.hash.as_str()) {
        return Ok(UploadResult { status: "unchanged".into(), remote });
    }

    let uploaded = put(&token, &folder, remote.as_ref(), built.bytes).await?;
    let mut state = load_state();
    state.launcher_hash = Some(built.hash);
    state.launcher_remote_time = Some(uploaded.modified_time.clone());
    save_state(&state)?;
    Ok(UploadResult { status: "uploaded".into(), remote: Some(uploaded) })
}

/// Downloads the Drive backup and merges it into this PC's launcher data.
/// What is here now is saved to store/launcher_backups first.
#[tauri::command]
pub async fn gdrive_launcher_restore() -> Result<RestoreReport, String> {
    let mut state = load_state();
    let token = access_token(&mut state).await?;
    let folder = find_or_create_folder(&mut state, &token).await?;
    let remote = find_named(&token, &folder, FILE_NAME)
        .await?
        .ok_or("There's no launcher backup on Google Drive yet.")?;

    let resp = client()
        .get(format!("{}/{}", FILES_URL, remote.id))
        .bearer_auth(&token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = check(resp).await?.bytes().await.map_err(|e| e.to_string())?;

    let device = device_name();
    let report = tokio::task::spawn_blocking(move || apply(&Paths::current(), &bytes, &device))
        .await
        .map_err(|e| e.to_string())??;

    let mut state = load_state();
    state.launcher_hash = Some(report.hash.clone());
    state.launcher_remote_time = Some(remote.modified_time);
    save_state(&state)?;
    Ok(report)
}

/// Mods restored from another PC that still need to be reimported here.
fn pending_mods(p: &Paths) -> Vec<WaitingMod> {
    files_in(&p.pending())
        .into_iter()
        .filter_map(|file| {
            let name = file.file_stem()?.to_string_lossy().into_owned();
            if p.mods.join(&name).is_dir() {
                return None;
            }
            let config = read_json(&file)?;
            let reddit = config.get("reddit").and_then(Value::as_str).unwrap_or_default().to_string();
            Some(WaitingMod { name, reddit })
        })
        .collect()
}

#[tauri::command]
pub async fn launcher_pending_list() -> Vec<WaitingMod> {
    pending_mods(&Paths::current())
}

/// Drops the saved settings of mods you don't want to reimport.
#[tauri::command]
pub async fn launcher_forget_pending(names: Vec<String>) -> usize {
    let dir = Paths::current().pending();
    names
        .iter()
        .filter_map(|n| plain_name(n))
        .filter(|n| fs::remove_file(dir.join(format!("{}.json", n))).is_ok())
        .count()
}

/// Settings restored for a mod that wasn't installed yet. Returns them once,
/// then forgets them.
#[tauri::command]
pub async fn launcher_take_pending(mod_name: String) -> Option<Value> {
    let name = plain_name(&mod_name)?;
    let path = Paths::current().pending().join(format!("{}.json", name));
    let config = read_json(&path)?;
    let _ = fs::remove_file(&path);
    Some(Value::Object(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(tag: &str) -> Paths {
        let root = std::env::temp_dir().join(format!("ddmm-launcher-{}-{}", tag, random_string(8)));
        let store = root.join("store");
        let mods = root.join("mods");
        fs::create_dir_all(&store).unwrap();
        fs::create_dir_all(&mods).unwrap();
        Paths { root, store, mods }
    }

    fn put_json(path: &Path, v: Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_string(&v).unwrap()).unwrap();
    }

    #[test]
    fn backup_moves_to_a_new_pc() {
        let a = temp_paths("a");
        put_json(&a.root.join("client-config.json"), serde_json::json!({
            "theme": "NATSUKI", "totalTime": 500, "version": "1.8.1", "user_name": "pc-a",
            "sidebar": {"density": "compact"},
        }));
        let art = a.art().join("Alpha-icon-1.png");
        fs::create_dir_all(a.art()).unwrap();
        fs::write(&art, b"icon").unwrap();
        fs::create_dir_all(a.images()).unwrap();
        fs::write(a.images().join("cover.png"), b"cover").unwrap();
        put_json(&a.mods.join("Alpha/.ddmm.config.json"), serde_json::json!({
            "rating": 4, "status": "completed", "time": 90, "pinned": true,
            "reddit": "https://reddit.com/r/DDLCMods/x", "coverId": "cover.png",
            "executable": "DDLC.exe", "gdrive_synced": "2026-01-01",
            "icon": {"image": art.to_string_lossy()},
        }));
        put_json(&a.mods.join("Beta/.ddmm.config.json"), serde_json::json!({"rating": 2}));
        let built = build(&a, "pc-a").unwrap();

        // PC B: fresh install with Alpha only, more local play time on Alpha
        let b = temp_paths("b");
        put_json(&b.root.join("client-config.json"), serde_json::json!({
            "theme": "MONIKA", "totalTime": 900, "version": "1.9.0", "user_name": "pc-b",
        }));
        put_json(&b.mods.join("Alpha/.ddmm.config.json"), serde_json::json!({
            "time": 120, "executable": "DDLC.exe", "size": 5,
        }));
        let report = apply(&b, &built.bytes, "pc-b").unwrap();

        let program = read_json(&b.root.join("client-config.json")).unwrap();
        assert_eq!(program["theme"], "NATSUKI");
        assert_eq!(program["totalTime"], 900, "keeps the larger play time");
        assert_eq!(program["version"], "1.9.0", "version stays local");
        assert_eq!(program["user_name"], "pc-b");
        assert_eq!(program["sidebar"]["density"], "compact");

        let alpha = read_json(&b.mods.join("Alpha/.ddmm.config.json")).unwrap();
        assert_eq!(alpha["rating"], 4);
        assert_eq!(alpha["status"], "completed");
        assert_eq!(alpha["time"], 120);
        assert_eq!(alpha["size"], 5, "local-only keys untouched");
        assert!(alpha.get("gdrive_synced").is_none());
        let icon = alpha["icon"]["image"].as_str().unwrap();
        assert_eq!(PathBuf::from(icon), b.art().join("Alpha-icon-1.png"));
        assert_eq!(fs::read(icon).unwrap(), b"icon");
        assert_eq!(fs::read(b.images().join("cover.png")).unwrap(), b"cover");

        assert_eq!(report.mods_applied, vec!["Alpha".to_string()]);
        assert_eq!(report.mods_waiting, vec![WaitingMod { name: "Beta".into(), reddit: String::new() }]);
        assert!(PathBuf::from(&report.backup).is_file());

        // Beta's settings wait for Beta, are carried by the next backup, and are handed over once
        let again = build(&b, "pc-b").unwrap();
        let archive = zip::ZipArchive::new(std::io::Cursor::new(again.bytes)).unwrap();
        assert!(archive.file_names().any(|n| n == "mods/Beta.json"));
        assert_eq!(pending_mods(&b), vec![WaitingMod { name: "Beta".into(), reddit: String::new() }]);
        let pending = b.pending().join("Beta.json");
        assert_eq!(read_json(&pending).unwrap()["rating"], 2);

        let _ = fs::remove_dir_all(&a.root);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn hash_ignores_backup_time_but_not_content() {
        let a = temp_paths("h");
        put_json(&a.mods.join("Alpha/.ddmm.config.json"), serde_json::json!({"rating": 1}));
        let first = build(&a, "x").unwrap().hash;
        assert_eq!(first, build(&a, "y").unwrap().hash);
        put_json(&a.mods.join("Alpha/.ddmm.config.json"), serde_json::json!({"rating": 5}));
        assert_ne!(first, build(&a, "x").unwrap().hash);
        let _ = fs::remove_dir_all(&a.root);
    }

    #[test]
    fn unsafe_names_are_refused() {
        assert_eq!(plain_name("Alpha"), Some("Alpha"));
        assert_eq!(plain_name(".."), None);
        assert_eq!(plain_name("../x"), None);
        assert_eq!(plain_name("C:x"), None);
        assert_eq!(plain_name("a\\b"), None);
    }
}

#[cfg(test)]
mod error_tests {
    #[test]
    fn disabled_api_error_is_readable() {
        let body = r#"{"error":{"code":403,"message":"Google Drive API has not been used","errors":[{"reason":"accessNotConfigured"}],"details":[{"reason":"SERVICE_DISABLED","metadata":{"consumer":"projects/123"}}]}}"#;
        let msg = super::super::google_error(403, body);
        assert!(msg.contains("turned off"), "{}", msg);
        assert!(msg.contains("(123)"), "{}", msg);
        assert_eq!(super::super::google_error(404, r#"{"error":{"message":"File not found"}}"#), "Google Drive error 404: File not found");
    }
}
