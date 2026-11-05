//! Counts play time only while the game's window is in front and the player isn't idle.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CHECK_EVERY: Duration = Duration::from_secs(1);
/// Generous, because reading a long passage in a visual novel takes a while without any input.
const IDLE_AFTER_MS: u64 = 5 * 60 * 1000;

static ACTIVE_MS: AtomicU64 = AtomicU64::new(0);

/// Counts until dropped.
pub struct Tracker {
    stop: Arc<AtomicBool>,
}

impl Drop for Tracker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

pub fn reset() {
    ACTIVE_MS.store(0, Ordering::SeqCst);
}

pub fn start(game_dir: PathBuf, exe_name: String) -> Tracker {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();

    std::thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            std::thread::sleep(CHECK_EVERY);
            if thread_stop.load(Ordering::SeqCst) {
                return;
            }
            // The cap keeps time the PC spent asleep from being counted
            let elapsed = last.elapsed().min(CHECK_EVERY * 2);
            last = Instant::now();
            if player_is_active(&game_dir, &exe_name) {
                ACTIVE_MS.fetch_add(elapsed.as_millis() as u64, Ordering::SeqCst);
            }
        }
    });

    Tracker { stop }
}

/// Ren'Py's exe starts a second copy from its lib folder, and that copy owns the window,
/// so anything running from the game's folder counts as the game.
fn is_game_exe(exe: &Path, game_dir: &Path, exe_name: &str) -> bool {
    let lower = |path: &Path| PathBuf::from(path.to_string_lossy().to_lowercase());
    let exe = lower(exe);
    exe.starts_with(lower(game_dir))
        || exe.file_name().is_some_and(|name| name.to_string_lossy() == exe_name.to_lowercase())
}

#[cfg(windows)]
fn player_is_active(game_dir: &Path, exe_name: &str) -> bool {
    win::idle_ms() < IDLE_AFTER_MS
        && win::foreground_exe().is_some_and(|exe| is_game_exe(&exe, game_dir, exe_name))
}

/// Only Windows can check the window and input for now, so other systems count all the time.
#[cfg(not(windows))]
fn player_is_active(_game_dir: &Path, _exe_name: &str) -> bool {
    true
}

#[cfg(windows)]
mod win {
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        time: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, process_id: *mut u32) -> u32;
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// Time since the last keyboard or mouse input anywhere on the PC.
    pub fn idle_ms() -> u64 {
        let mut info = LastInputInfo {
            size: std::mem::size_of::<LastInputInfo>() as u32,
            time: 0,
        };
        unsafe {
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            GetTickCount().wrapping_sub(info.time) as u64
        }
    }

    /// Path of the program that owns the window in front.
    pub fn foreground_exe() -> Option<PathBuf> {
        unsafe {
            let window = GetForegroundWindow();
            if window.is_null() {
                return None;
            }
            let mut process_id = 0u32;
            GetWindowThreadProcessId(window, &mut process_id);
            if process_id == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut name = vec![0u16; 32768];
            let mut size = name.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, name.as_mut_ptr(), &mut size);
            CloseHandle(process);
            (ok != 0).then(|| PathBuf::from(OsString::from_wide(&name[..size as usize])))
        }
    }
}

/// Counted time for the game that's running, for the live timer.
#[tauri::command]
pub fn get_play_time() -> u64 {
    ACTIVE_MS.load(Ordering::SeqCst)
}

/// Counted time for the game that just closed. Hands it out once, so it can't be added twice.
#[tauri::command]
pub fn take_play_time() -> u64 {
    ACTIVE_MS.swap(0, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_files_count_and_others_dont() {
        let dir = Path::new(r"C:\Mods\My Mod");
        // The copy Ren'Py starts from its lib folder, with different capitals
        assert!(is_game_exe(Path::new(r"c:\mods\my mod\lib\py3-windows-x86_64\DDLC.exe"), dir, "DDLC.exe"));
        // Same name somewhere else, which is how a mod's launcher can hand off
        assert!(is_game_exe(Path::new(r"C:\Temp\ddlc.exe"), dir, "DDLC.exe"));
        // A folder that only starts with the same text
        assert!(!is_game_exe(Path::new(r"C:\Mods\My Mod 2\DDLC.exe"), dir, "Other.exe"));
        assert!(!is_game_exe(Path::new(r"C:\Windows\explorer.exe"), dir, "DDLC.exe"));
    }

    #[test]
    fn counted_time_is_handed_out_once() {
        ACTIVE_MS.store(5000, Ordering::SeqCst);
        assert_eq!(get_play_time(), 5000);
        assert_eq!(take_play_time(), 5000);
        assert_eq!(take_play_time(), 0);
    }
}
