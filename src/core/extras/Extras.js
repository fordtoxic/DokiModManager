import {convertFileSrc, invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {confirm, notify} from "./Dialog";
import {openUrl} from "@tauri-apps/plugin-opener";
import {open as openFileDialog} from "@tauri-apps/plugin-dialog";
import {mkdir, readFile, remove, writeFile} from "@tauri-apps/plugin-fs";
import {isExist} from "tauri-plugin-fs-pro-api";
import {getLauncher, getLaunchers} from "../Launchers";
import {fileTerminator, terminatePath} from "../utils/FileSystem";
import {WARN_GENERIC_DATA_PATHS} from "../Constants";
import Logger from "../utils/Logger";
import Hud from "../utils/HTMLHelper";
import * as Library from "./Library";
import * as Sidebar from "./Sidebar";
import "./extras.css";

/**
 * Extra features: rating, status, Reddit link, sort/filter bar, storage cleanup,
 * drag-and-drop overlay, duplicate warning and Google Drive save sync.
 */

let ctx = {
    getCurrentEntry: () => "",
    getLocalPath: () => "",
    refreshCurrent: async () => {
    },
};

let driveStatus = {configured: false, signed_in: false, email: null, auto_sync: false};
let deviceName = "";

// ---------- small DOM helpers ----------

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key.startsWith("on")) node.addEventListener(key.substring(2).toLowerCase(), value);
        else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

function formatBytes(bytes) {
    if (!bytes) return "0 MB";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
    if (mb >= 10) return Math.round(mb) + " MB";
    if (mb >= 0.1) return mb.toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function formatDate(value) {
    if (!value) return "never";
    const date = new Date(value);
    if (isNaN(date.getTime())) return "never";
    return date.toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"});
}

function currentLauncher() {
    const entry = ctx.getCurrentEntry();
    return entry ? getLauncher(entry) : undefined;
}

// ---------- toast ----------

export function toast(message, kind = "info", ms = 3500) {
    notify(message, kind, ms);
}

// ---------- modal ----------

function openModal(title, build, wide = false) {
    stopPasteListening();
    const bg = document.getElementById("ddx-modal-bg");
    const modal = bg.querySelector(".ddx-modal");
    modal.classList.toggle("ddx-modal-wide", wide);
    bg.querySelector(".ddx-modal-title").textContent = title;
    const body = bg.querySelector(".ddx-modal-body");
    body.replaceChildren();
    build(body);
    bg.classList.remove("ddx-hidden");
}

function closeModal() {
    stopPasteListening();
    document.getElementById("ddx-modal-bg")?.classList.add("ddx-hidden");
}

function isModalOpen() {
    return !document.getElementById("ddx-modal-bg")?.classList.contains("ddx-hidden");
}

// ---------- mod page: rating, status, Reddit, cloud ----------

function renderStars(rating, preview = null) {
    const shown = preview ?? rating;
    document.querySelectorAll("#ddx-stars .ddx-star").forEach((star, index) => {
        star.classList.toggle("ddx-star-on", index < shown);
        star.classList.toggle("ddx-star-preview", preview !== null);
    });
    const label = document.getElementById("ddx-rating-label");
    if (label) label.textContent = rating > 0 ? rating + "/5" : "Not rated";
}

export async function showMeta(entry) {
    const meta = document.getElementById("ddx-meta");
    const launcher = getLauncher(entry);
    if (!meta || !launcher) return;
    const config = launcher.getFunctions().getConfig();
    renderStars(config.rating ?? 0);
    document.getElementById("ddx-status").value = config.status ?? "";
    const reddit = document.getElementById("ddx-reddit");
    const hasLink = !!config.reddit;
    reddit.textContent = hasLink ? "Reddit post" : "Add Reddit link";
    reddit.classList.toggle("ddx-chip-empty", !hasLink);
    reddit.title = hasLink ? config.reddit : "Save this mod's Reddit post";
    document.getElementById("ddx-reddit-edit").classList.toggle("ddx-hidden", !hasLink);
    document.getElementById("ddx-grab-reddit")?.classList.toggle("ddx-hidden", !hasLink);
    const cloud = document.getElementById("ddx-cloud");
    cloud.title = config.gdrive_synced ? "Last synced " + formatDate(config.gdrive_synced) : "Google Drive saves";
    meta.classList.remove("ddx-hidden");
    applyModBackground(config);
}

export function hideMeta() {
    document.getElementById("ddx-meta")?.classList.add("ddx-hidden");
    // The home page sets its own background right after this.
    homeBackground = null;
}

async function setRating(value) {
    const launcher = currentLauncher();
    if (!launcher) return;
    const config = launcher.getFunctions().getConfig();
    const rating = config.rating === value ? 0 : value;
    await launcher.getFunctions().update({rating});
    renderStars(rating);
    Library.apply();
}

async function setStatus(value) {
    const launcher = currentLauncher();
    if (!launcher) return;
    await launcher.getFunctions().update({status: value});
    Library.apply();
}

function normalizeRedditLink(raw) {
    let link = raw.trim();
    if (!link) return "";
    if (!/^https?:\/\//i.test(link)) link = "https://" + link;
    let url;
    try {
        url = new URL(link);
    } catch {
        return null;
    }
    if (!/(^|\.)reddit\.com$|^redd\.it$/i.test(url.hostname)) return null;
    url.protocol = "https:";
    return url.toString();
}

function redditSearchUrl(modName) {
    return "https://www.reddit.com/r/DDLCMods/search/?restrict_sr=1&q=" + encodeURIComponent(modName);
}

function openRedditEditor() {
    const launcher = currentLauncher();
    if (!launcher) return;
    const functions = launcher.getFunctions();
    const config = functions.getConfig();
    const modName = functions.getName();

    openModal("Reddit link", body => {
        const input = el("input", {
            class: "ddx-input",
            placeholder: "https://www.reddit.com/r/DDLCMods/comments/...",
            spellcheck: "false",
            autocomplete: "off",
        });
        input.value = config.reddit ?? "";
        const error = el("p", {class: "ddx-error ddx-hidden"});
        const save = async () => {
            const link = normalizeRedditLink(input.value);
            if (link === null) {
                error.textContent = "That isn't a reddit.com or redd.it link.";
                error.classList.remove("ddx-hidden");
                return;
            }
            await functions.update({reddit: link});
            closeModal();
            await showMeta(modName);
            toast(link ? "Reddit link saved" : "Reddit link removed");
        };
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") save();
        });
        body.append(
            el("p", {class: "ddx-text", text: "Paste the link to this mod's Reddit post. Leave it empty to remove it."}),
            input,
            error,
            config.reddit ? el("button", {
                class: "ddx-link", text: "Grab images from this post",
                onClick: () => {
                    closeModal();
                    grabRedditImages(modName);
                },
            }) : null,
            el("div", {class: "ddx-actions"}, [
                el("button", {
                    class: "ddx-button ddx-button-ghost",
                    text: "Search r/DDLCMods",
                    onClick: () => openUrl(redditSearchUrl(modName)),
                }),
                el("button", {class: "ddx-button ddx-button-ghost", text: "Cancel", onClick: closeModal}),
                el("button", {class: "ddx-button", text: "Save", onClick: save}),
            ]),
        );
        setTimeout(() => input.focus(), 50);
    });
}

async function onRedditClick() {
    const launcher = currentLauncher();
    if (!launcher) return;
    const link = launcher.getFunctions().getConfig().reddit;
    if (link) {
        await openUrl(link);
    } else {
        openRedditEditor();
    }
}

// ---------- save folders ----------

/**
 * The folders that hold a mod's saves:
 *  - "renpy": %APPDATA%\RenPy\<save_directory> (read from the mod's options, then cached)
 *  - "game":  <mod>\game\saves
 */
export async function getSaveFolders(launcher) {
    const functions = launcher.getFunctions();
    const config = functions.getConfig();
    const absolute = functions.absolute_location;
    let renpyDir = config.save_dir;

    if (!renpyDir) {
        let scripts = absolute + fileTerminator + terminatePath("game\\scripts.rpa");
        if (!await isExist(scripts)) {
            scripts = absolute + fileTerminator + terminatePath("game\\options.rpyc");
        }
        if (await isExist(scripts)) {
            try {
                renpyDir = await invoke("rpa_data", {path: scripts, out: absolute, option: "save_directory"});
            } catch (e) {
                Logger.warn("Could not read save directory for " + functions.getName() + ": " + e);
            }
            if (renpyDir) await functions.update({save_dir: renpyDir});
        }
    }

    const folders = [];
    if (renpyDir) folders.push({role: "renpy", path: renpyDir});
    folders.push({role: "game", path: absolute + fileTerminator + "game" + fileTerminator + "saves"});
    return folders;
}

function isGenericSaveDir(path) {
    return !!path && WARN_GENERIC_DATA_PATHS.some(generic => path.endsWith(generic));
}

// ---------- Google Drive ----------

async function refreshDriveStatus() {
    try {
        driveStatus = await invoke("gdrive_status");
        deviceName = driveStatus.device ?? "";
    } catch (e) {
        Logger.warn("Drive status failed: " + e);
    }
    document.getElementById("ddx-side-cloud")?.classList.toggle("ddx-side-active", driveStatus.signed_in);
    return driveStatus;
}

async function uploadSaves(launcher, quiet = false) {
    const functions = launcher.getFunctions();
    const name = functions.getName();
    if (!quiet) toast("Uploading saves for " + name + "…", "info", 0);
    const folders = await getSaveFolders(launcher);
    const remote = await invoke("gdrive_upload", {modId: name, folders});
    await functions.update({gdrive_synced: remote.modified_time});
    toast("Saves for " + name + " uploaded to Google Drive", "ok");
    return remote;
}

async function downloadSaves(launcher) {
    const functions = launcher.getFunctions();
    const name = functions.getName();
    toast("Downloading saves for " + name + "…", "info", 0);
    const folders = await getSaveFolders(launcher);
    const backup = await invoke("gdrive_download", {modId: name, folders});
    const remote = await invoke("gdrive_remote_info", {modId: name});
    await functions.update({gdrive_synced: remote?.modified_time ?? new Date().toISOString()});
    toast(backup ? "Saves restored. Your old saves were backed up first." : "Saves restored from Google Drive", "ok", 5000);
}

/** Called before a mod launches: offers to pull newer saves from another PC. */
export async function beforeGameLaunch(launcher) {
    if (!driveStatus.signed_in || !driveStatus.auto_sync) return;
    const functions = launcher.getFunctions();
    try {
        const remote = await invoke("gdrive_remote_info", {modId: functions.getName()});
        if (!remote) return;
        const synced = functions.getConfig().gdrive_synced;
        const fromOtherPc = remote.device && remote.device !== deviceName;
        if (remote.modified_time !== synced && fromOtherPc) {
            const yes = await confirm(
                "Google Drive has saves for " + functions.getName() + " from " + remote.device +
                " (" + formatDate(remote.modified_time) + ").\n\nDownload them before playing? Your current saves will be backed up first.",
                {title: "Newer saves on Google Drive", okLabel: "Download", cancelLabel: "Keep mine"},
            );
            if (yes) await downloadSaves(launcher);
        }
    } catch (e) {
        toast("Couldn't check Google Drive: " + e, "error", 6000);
    }
}

/** Called after a mod closes: uploads its saves when auto-sync is on. */
export async function afterGameClosed(launcher) {
    if (!driveStatus.signed_in || !driveStatus.auto_sync) return;
    try {
        await uploadSaves(launcher, false);
    } catch (e) {
        if (!String(e).includes("no save files")) toast("Auto-sync failed: " + e, "error", 6000);
    }
    await autoBackupLauncher();
}

function openModCloud() {
    const launcher = currentLauncher();
    if (!launcher) return;
    if (!driveStatus.signed_in) {
        openDriveSettings();
        return;
    }
    const functions = launcher.getFunctions();
    const name = functions.getName();

    openModal("Cloud saves · " + name, async body => {
        const info = el("div", {class: "ddx-kv"}, [el("p", {class: "ddx-text", text: "Checking Google Drive…"})]);
        const upload = el("button", {class: "ddx-button", text: "Upload my saves"});
        const download = el("button", {class: "ddx-button ddx-button-ghost", text: "Download from Drive"});
        body.append(info, el("div", {class: "ddx-actions"}, [download, upload]));

        const busy = on => [upload, download].forEach(b => b.disabled = on);

        upload.addEventListener("click", async () => {
            busy(true);
            try {
                await uploadSaves(launcher);
                closeModal();
                await showMeta(name);
            } catch (e) {
                toast(String(e), "error", 7000);
                busy(false);
            }
        });
        download.addEventListener("click", async () => {
            const yes = await confirm(
                "Replace the saves on this PC with the Google Drive copy?\n\nYour current saves are zipped to store\\save_backups first, so you can undo this.",
                {title: "Download saves", okLabel: "Replace", cancelLabel: "Cancel"},
            );
            if (!yes) return;
            busy(true);
            try {
                await downloadSaves(launcher);
                closeModal();
                await showMeta(name);
            } catch (e) {
                toast(String(e), "error", 7000);
                busy(false);
            }
        });

        try {
            const [remote, folders] = await Promise.all([
                invoke("gdrive_remote_info", {modId: name}),
                getSaveFolders(launcher),
            ]);
            const sizes = await invoke("ddx_measure", {paths: folders.map(f => f.path)});
            const localSize = sizes.reduce((a, b) => a + b, 0);
            const rows = [
                ["On this PC", localSize > 0 ? formatBytes(localSize) : "no saves yet"],
                ["On Google Drive", remote ? formatBytes(remote.size) + " · " + formatDate(remote.modified_time) + (remote.device ? " · from " + remote.device : "") : "nothing uploaded yet"],
                ["Last synced here", formatDate(functions.getConfig().gdrive_synced)],
            ];
            info.replaceChildren(...rows.map(([k, v]) => el("div", {class: "ddx-kv-row"}, [el("span", {text: k}), el("span", {text: v})])));
            const renpy = folders.find(f => f.role === "renpy");
            if (isGenericSaveDir(renpy?.path)) {
                info.append(el("p", {
                    class: "ddx-warning",
                    text: "This mod uses a shared save folder name, so other mods using the same template share these saves.",
                }));
            }
            download.disabled = !remote;
        } catch (e) {
            info.replaceChildren(el("p", {class: "ddx-error", text: String(e)}));
        }
    });
}

function openDriveSettings() {
    openModal("Google Drive saves", async body => {
        await refreshDriveStatus();
        const s = driveStatus;

        if (!s.configured) {
            const id = el("input", {class: "ddx-input", placeholder: "Client ID (…apps.googleusercontent.com)", spellcheck: "false", autocomplete: "off"});
            const secret = el("input", {class: "ddx-input", placeholder: "Client secret", spellcheck: "false", autocomplete: "off", type: "password"});
            const error = el("p", {class: "ddx-error ddx-hidden"});
            body.append(
                el("p", {class: "ddx-text", text: "One-time setup. Google needs a free sign-in key for this app:"}),
                el("ol", {class: "ddx-steps"}, [
                    el("li", {}, ["In Google Cloud Console, create a project and enable the ", el("b", {text: "Google Drive API"}), "."]),
                    el("li", {}, ["Set up the ", el("b", {text: "OAuth consent screen"}), " (External) and add your Google account as a test user."]),
                    el("li", {}, ["Create an ", el("b", {text: "OAuth client ID"}), " of type ", el("b", {text: "Desktop app"}), " and paste its ID and secret below."]),
                ]),
                el("button", {
                    class: "ddx-link",
                    text: "Open Google Cloud Console",
                    onClick: () => openUrl("https://console.cloud.google.com/apis/credentials"),
                }),
                id, secret, error,
                el("div", {class: "ddx-actions"}, [
                    el("button", {class: "ddx-button ddx-button-ghost", text: "Cancel", onClick: closeModal}),
                    el("button", {
                        class: "ddx-button", text: "Save", onClick: async () => {
                            try {
                                await invoke("gdrive_configure", {clientId: id.value, clientSecret: secret.value});
                                openDriveSettings();
                            } catch (e) {
                                error.textContent = String(e);
                                error.classList.remove("ddx-hidden");
                            }
                        },
                    }),
                ]),
            );
            return;
        }

        if (!s.signed_in) {
            const status = el("p", {class: "ddx-text", text: "Sign in with the Google account you want your saves stored in. Your browser will open."});
            const signIn = el("button", {class: "ddx-button", text: "Sign in with Google"});
            signIn.addEventListener("click", async () => {
                signIn.disabled = true;
                status.textContent = "Waiting for you to finish signing in in your browser…";
                try {
                    const email = await invoke("gdrive_sign_in");
                    toast("Signed in to Google Drive as " + email, "ok");
                    openDriveSettings();
                } catch (e) {
                    status.textContent = String(e);
                    status.classList.add("ddx-error");
                    signIn.disabled = false;
                }
            });
            body.append(
                status,
                el("div", {class: "ddx-actions"}, [
                    el("button", {
                        class: "ddx-button ddx-button-ghost", text: "Change client ID", onClick: async () => {
                            await invoke("gdrive_reset_client");
                            openDriveSettings();
                        },
                    }),
                    signIn,
                ]),
            );
            return;
        }

        const auto = el("input", {type: "checkbox", class: "ddx-check"});
        auto.checked = s.auto_sync;
        auto.addEventListener("change", async () => {
            await invoke("gdrive_set_auto_sync", {enabled: auto.checked});
            await refreshDriveStatus();
            toast(auto.checked ? "Auto-sync on" : "Auto-sync off");
        });
        const uploadAll = el("button", {class: "ddx-button ddx-button-ghost", text: "Upload all mods now"});
        uploadAll.addEventListener("click", async () => {
            uploadAll.disabled = true;
            let done = 0, skipped = 0, failed = 0;
            for (const name of Object.keys(getLaunchers())) {
                uploadAll.textContent = "Uploading " + (done + skipped + failed + 1) + "/" + Object.keys(getLaunchers()).length + "…";
                try {
                    await uploadSaves(getLauncher(name), true);
                    done++;
                } catch (e) {
                    if (String(e).includes("no save files")) skipped++;
                    else {
                        failed++;
                        Logger.warn("Upload failed for " + name + ": " + e);
                    }
                }
            }
            toast("Uploaded " + done + " mod" + (done === 1 ? "" : "s") + (skipped ? ", " + skipped + " had no saves" : "") + (failed ? ", " + failed + " failed" : ""), failed ? "error" : "ok", 6000);
            uploadAll.textContent = "Upload all mods now";
            uploadAll.disabled = false;
        });

        body.append(
            el("div", {class: "ddx-kv"}, [
                el("div", {class: "ddx-kv-row"}, [el("span", {text: "Signed in as"}), el("span", {text: s.email ?? "unknown"})]),
                el("div", {class: "ddx-kv-row"}, [el("span", {text: "Drive folder"}), el("span", {text: "Doki Doki Mod Manager Saves"})]),
            ]),
            launcherDataSection(),
            el("label", {class: "ddx-toggle"}, [
                auto,
                el("span", {}, [
                    el("b", {text: "Auto-sync"}),
                    el("span", {class: "ddx-subtle", text: " — upload saves when you close a mod, back up launcher data as it changes, and offer newer copies from your other PCs"}),
                ]),
            ]),
            el("div", {class: "ddx-actions"}, [
                el("button", {
                    class: "ddx-button ddx-button-ghost", text: "Sign out", onClick: async () => {
                        await invoke("gdrive_sign_out");
                        await refreshDriveStatus();
                        openDriveSettings();
                    },
                }),
                uploadAll,
            ]),
        );
    });
}

// ---------- launcher data (settings, ratings, icons, covers) ----------

const LAUNCHER_BACKUP_EVERY = 10 * 60 * 1000;
let launcherTimer = null;
let launcherBusy = false;

/** Backs up launcher data when it changed. Never overwrites a newer backup from another PC. */
async function autoBackupLauncher() {
    if (!driveStatus.signed_in || !driveStatus.auto_sync || launcherBusy) return;
    launcherBusy = true;
    try {
        const result = await invoke("gdrive_launcher_upload", {force: false});
        if (result.status === "uploaded") Logger.info("Launcher data backed up to Google Drive");
    } catch (e) {
        Logger.warn("Launcher backup failed: " + e);
    } finally {
        launcherBusy = false;
    }
}

async function backupLauncherNow(remote, syncedTime) {
    if (remote && remote.modified_time !== syncedTime) {
        const yes = await confirm(
            "Google Drive has launcher data from " + (remote.device ?? "another PC") + " (" + formatDate(remote.modified_time) + ") that this PC hasn't restored.\n\n" +
            "Backing up now replaces it with this PC's ratings, icons, covers and settings.",
            {title: "Replace the Drive backup?", okLabel: "Replace it", cancelLabel: "Cancel", danger: true},
        );
        if (!yes) return;
    }
    toast("Backing up launcher data…", "info", 0);
    await invoke("gdrive_launcher_upload", {force: true});
    toast("Launcher data backed up to Google Drive", "ok");
}

async function restoreLauncher() {
    toast("Restoring launcher data…", "info", 0);
    const report = await invoke("gdrive_launcher_restore");
    toast("Launcher data restored", "ok");
    showRestoreReport(report);
}

/** What was restored, which mods still need installing, then a reload to show it. */
function showRestoreReport(report) {
    openModal("Launcher data restored", body => {
        const applied = report.mods_applied.length;
        body.append(el("p", {
            class: "ddx-text",
            text: "Restored your launcher settings" +
                (applied ? ", and ratings, icons and backgrounds for " + applied + " mod" + (applied === 1 ? "" : "s") : "") +
                (report.covers ? ", plus " + report.covers + " cover image" + (report.covers === 1 ? "" : "s") : "") + ".",
        }));
        if (report.mods_waiting.length > 0) body.append(...reimportList(report.mods_waiting));
        body.append(
            el("p", {class: "ddx-subtle", text: "What was here before is saved in store\\launcher_backups."}),
            el("div", {class: "ddx-actions"}, [
                el("button", {class: "ddx-button", text: "Reload launcher", onClick: () => location.reload()}),
            ]),
        );
    }, true);
}

/** The "reimport these mods" explanation and list, shared by the restore report and the reminder. */
function reimportList(mods) {
    const many = mods.length !== 1;
    return [
        el("p", {
            class: "ddx-text",
            text: (many ? "These " + mods.length + " mods aren't" : "This mod isn't") + " on this PC. " +
                "Reimport " + (many ? "them" : "it") + " with Import Mod, using the same zip as before. " +
                "Ratings, icons, backgrounds and play time come back by themselves once the mod is added.",
        }),
        el("ul", {class: "ddx-waiting-list"}, mods.map(mod => el("li", {}, [
            el("span", {text: mod.name}),
            mod.reddit ? el("button", {class: "ddx-link", text: "Reddit post", onClick: () => openUrl(mod.reddit)}) : null,
        ]))),
    ];
}

let pendingMods = [];

/** Reminder in the sidebar while restored mods still need reimporting. */
export async function refreshReimportReminder() {
    try {
        pendingMods = await invoke("launcher_pending_list");
    } catch (e) {
        pendingMods = [];
    }
    const button = document.getElementById("ddx-side-reimport");
    if (!button) return;
    button.classList.toggle("ddx-hidden", pendingMods.length === 0);
    const label = button.querySelector(".ddx-reimport-label");
    if (label) label.textContent = "Reimport " + pendingMods.length + " mod" + (pendingMods.length === 1 ? "" : "s");
}

function openReimport() {
    if (pendingMods.length === 0) return;
    openModal("Reimport your mods", body => {
        body.append(
            ...reimportList(pendingMods),
            el("div", {class: "ddx-actions"}, [
                el("button", {
                    class: "ddx-button ddx-button-ghost", text: "Forget these", onClick: async () => {
                        const yes = await confirm(
                            "Stop reminding you about these mods? Their restored ratings, icons and play time are removed from this PC.",
                            {title: "Forget these mods?", okLabel: "Forget them", cancelLabel: "Keep them", danger: true},
                        );
                        if (!yes) return;
                        await invoke("launcher_forget_pending", {names: pendingMods.map(m => m.name)});
                        await refreshReimportReminder();
                        closeModal();
                    },
                }),
                el("button", {
                    class: "ddx-button", text: "Import mod", onClick: () => {
                        closeModal();
                        document.getElementById("import")?.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, button: 0}));
                    },
                }),
            ]),
        );
    }, true);
}

const DRIVE_API_PAGE = "https://console.cloud.google.com/apis/library/drive.googleapis.com";

/** Shows a Drive error, with a shortcut when the fix is enabling the Drive API. */
function showDriveProblem(container, error) {
    const text = String(error);
    container.replaceChildren(el("p", {class: "ddx-error", text}));
    if (text.includes("Google Drive API is turned off")) {
        const project = text.match(/project \((\d+)\)/)?.[1];
        const url = DRIVE_API_PAGE + (project ? "?project=" + project : "");
        container.append(el("button", {class: "ddx-link", text: "Open the Google Drive API page", onClick: () => openUrl(url)}));
    }
}

/** The "Launcher data" part of the Google Drive panel. */
function launcherDataSection() {
    const state = el("span", {text: "Checking…"});
    const problem = el("div", {class: "ddx-drive-problem"});
    const backup = el("button", {class: "ddx-button ddx-button-ghost", text: "Back up now", disabled: true});
    const restore = el("button", {class: "ddx-button ddx-button-ghost", text: "Restore from Drive", disabled: true});
    let info = {remote: null, synced_time: null};

    const refresh = async () => {
        try {
            info = await invoke("gdrive_launcher_info");
            const remote = info.remote;
            if (!remote) {
                state.textContent = "Not backed up yet";
            } else {
                const newer = remote.modified_time !== info.synced_time;
                state.textContent = formatDate(remote.modified_time) + (remote.device ? " from " + remote.device : "") +
                    (newer ? " (not on this PC yet)" : "");
            }
            backup.disabled = false;
            restore.disabled = !remote;
            problem.replaceChildren();
        } catch (e) {
            state.textContent = "Couldn't check";
            showDriveProblem(problem, e);
            backup.disabled = false;
        }
    };
    const run = async action => {
        backup.disabled = restore.disabled = true;
        try {
            await action();
        } catch (e) {
            toast(String(e), "error", 6000);
        }
        await refresh();
    };
    backup.addEventListener("click", () => run(() => backupLauncherNow(info.remote, info.synced_time)));
    restore.addEventListener("click", () => run(async () => {
        const yes = await confirm(
            "Bring back ratings, statuses, Reddit links, icons, backgrounds, covers, play time and launcher settings from " +
            (info.remote?.device ?? "Google Drive") + "?\n\nWhat's on this PC now is backed up first.",
            {title: "Restore launcher data?", okLabel: "Restore", cancelLabel: "Cancel"},
        );
        if (yes) await restoreLauncher();
    }));
    refresh();

    return el("div", {class: "ddx-launcher-sync"}, [
        el("div", {class: "ddx-kv"}, [
            el("div", {class: "ddx-kv-row"}, [el("span", {text: "Launcher data"}), state]),
        ]),
        el("p", {class: "ddx-subtle", text: "Ratings, statuses, Reddit links, pins, icons, backgrounds, covers, play time and launcher settings. The mods themselves aren't uploaded."}),
        problem,
        el("div", {class: "ddx-actions"}, [backup, restore]),
    ]);
}

/**
 * After the library loads: offer a newer launcher backup from another PC
 * (or to a fresh install), then keep backing up while auto-sync is on.
 */
let launcherSyncStarted = false;

async function startLauncherSync() {
    if (launcherSyncStarted || !driveStatus.signed_in) return;
    launcherSyncStarted = true;
    try {
        const info = await invoke("gdrive_launcher_info");
        const remote = info.remote;
        if (remote && remote.modified_time !== info.synced_time) {
            const yes = await confirm(
                "Google Drive has launcher data from " + (remote.device ?? "another PC") + " (" + formatDate(remote.modified_time) + "): " +
                "ratings, icons, backgrounds, covers and settings.\n\n" +
                (info.synced_time ? "It's newer than what this PC has. Restore it?" : "Restore it on this PC?") +
                " What's here now is backed up first.",
                {title: "Restore launcher data?", okLabel: "Restore", cancelLabel: "Not now"},
            );
            if (yes) {
                await restoreLauncher();
                return;
            }
        }
    } catch (e) {
        Logger.warn("Launcher data check failed: " + e);
    }
    await autoBackupLauncher();
    clearInterval(launcherTimer);
    launcherTimer = setInterval(autoBackupLauncher, LAUNCHER_BACKUP_EVERY);
}

// ---------- storage ----------

const JUNK = [
    {path: "log.txt", label: "Logs"},
    {path: "traceback.txt", label: "Crash reports"},
    {path: "errors.txt", label: "Crash reports"},
    {path: "game\\cache", label: "Ren'Py cache"},
    {path: "deobf", label: "Extracted scripts"},
    {path: "ddmm-temp-options", label: "Manager temp files"},
];

async function scanStorage() {
    const names = Object.keys(getLaunchers());
    const junkPaths = [];
    const modPaths = [];
    const rows = names.map(name => {
        const functions = getLauncher(name).getFunctions();
        const roots = [...new Set([functions.absolute_location, functions.location])];
        const junk = [];
        for (const root of roots) {
            for (const item of JUNK) {
                junk.push({path: root + fileTerminator + terminatePath(item.path), label: item.label});
            }
        }
        modPaths.push(functions.location);
        junkPaths.push(...junk.map(j => j.path));
        return {name, functions, junk};
    });

    const localPath = ctx.getLocalPath();
    const managerTemp = localPath + fileTerminator + terminatePath("store\\temp");
    const backups = localPath + fileTerminator + terminatePath("store\\save_backups");

    const [modSizes, junkSizes, managerSizes] = await Promise.all([
        invoke("ddx_measure", {paths: modPaths}),
        invoke("ddx_measure", {paths: junkPaths}),
        invoke("ddx_measure", {paths: [managerTemp, backups]}),
    ]);

    let cursor = 0;
    for (let i = 0; i < rows.length; i++) {
        rows[i].size = modSizes[i];
        for (const junk of rows[i].junk) junk.size = junkSizes[cursor++];
        rows[i].junk = rows[i].junk.filter(j => j.size > 0);
        rows[i].junkSize = rows[i].junk.reduce((a, j) => a + j.size, 0);
        await rows[i].functions.update({size: rows[i].size});
    }
    rows.sort((a, b) => b.size - a.size);
    return {
        rows,
        managerTemp: {path: managerTemp, size: managerSizes[0]},
        backups: {path: backups, size: managerSizes[1]},
    };
}

function describeJunk(junk) {
    const byLabel = new Map();
    for (const j of junk) byLabel.set(j.label, (byLabel.get(j.label) ?? 0) + j.size);
    return [...byLabel.entries()].map(([label, size]) => label + " (" + formatBytes(size) + ")").join(", ");
}

async function cleanPaths(paths, summary) {
    if (paths.length === 0) return false;
    const yes = await confirm(
        "Delete " + summary + "?\n\nThese are files mods and Ren'Py recreate when needed. Saves are not touched.",
        {title: "Clean up", okLabel: "Delete", cancelLabel: "Cancel"},
    );
    if (!yes) return false;
    const removed = await invoke("ddx_remove", {paths});
    toast("Cleaned up " + removed + " item" + (removed === 1 ? "" : "s"), "ok");
    return true;
}

function openStorage() {
    openModal("Storage", async body => {
        body.append(el("p", {class: "ddx-text", text: "Measuring your mods…"}));
        let data;
        try {
            data = await scanStorage();
        } catch (e) {
            body.replaceChildren(el("p", {class: "ddx-error", text: String(e)}));
            return;
        }
        Library.apply();

        const total = data.rows.reduce((a, r) => a + r.size, 0);
        const totalJunk = data.rows.reduce((a, r) => a + r.junkSize, 0) + data.managerTemp.size;
        const max = Math.max(1, ...data.rows.map(r => r.size));

        const cleanAll = el("button", {class: "ddx-button", text: "Clean up " + formatBytes(totalJunk), disabled: totalJunk === 0});
        cleanAll.addEventListener("click", async () => {
            const paths = data.rows.flatMap(r => r.junk.map(j => j.path));
            if (data.managerTemp.size > 0) paths.push(data.managerTemp.path);
            if (await cleanPaths(paths, formatBytes(totalJunk) + " of logs, caches and temp files across all mods")) openStorage();
        });

        const list = el("div", {class: "ddx-storage-list"}, data.rows.map(row => {
            const clean = el("button", {class: "ddx-mini", text: "Clean " + formatBytes(row.junkSize), title: describeJunk(row.junk)});
            clean.disabled = row.junkSize === 0;
            if (row.junkSize === 0) clean.textContent = "Clean";
            clean.addEventListener("click", async () => {
                if (await cleanPaths(row.junk.map(j => j.path), describeJunk(row.junk) + " from " + row.name)) openStorage();
            });
            return el("div", {class: "ddx-storage-row"}, [
                el("div", {class: "ddx-storage-name", text: row.name, title: row.name}),
                el("div", {class: "ddx-storage-bar"}, [el("div", {class: "ddx-storage-fill", style: "width:" + (row.size / max * 100).toFixed(1) + "%"})]),
                el("div", {class: "ddx-storage-size", text: formatBytes(row.size)}),
                clean,
            ]);
        }));

        body.replaceChildren(
            el("div", {class: "ddx-kv"}, [
                el("div", {class: "ddx-kv-row"}, [el("span", {text: "Mods"}), el("span", {text: data.rows.length + " using " + formatBytes(total)})]),
                el("div", {class: "ddx-kv-row"}, [el("span", {text: "Can be cleaned"}), el("span", {text: formatBytes(totalJunk)})]),
                el("div", {class: "ddx-kv-row"}, [el("span", {text: "Save backups"}), el("span", {text: formatBytes(data.backups.size) + " (kept)"})]),
            ]),
            list,
            el("div", {class: "ddx-actions"}, [
                el("button", {
                    class: "ddx-button ddx-button-ghost", text: "Open backups folder", onClick: async () => {
                        if (await isExist(data.backups.path)) await invoke("open_path", {path: data.backups.path});
                        else toast("No save backups yet");
                    },
                }),
                cleanAll,
            ]),
        );
    }, true);
}

// ---------- per-mod icon and background ----------

const ICONS = [
    ["Heart", 60943], ["Filled heart", 60938], ["Quill", 61514], ["Pen", 61406], ["Pencil", 61408],
    ["Open book", 60123], ["Book", 60115], ["Bookmark", 60133], ["Star", 61835], ["Sparkles", 62317],
    ["Magic", 61162], ["Moon", 61301], ["Sun", 61887], ["Flower", 62475], ["Plant", 61447],
    ["Leaf", 61091], ["Cupcake", 60187], ["Tea", 60422], ["Knife", 61051], ["Ghost", 60853],
    ["Smiling ghost", 60855], ["Skull", 61770], ["Music", 61315], ["Headphones", 60933], ["Gamepad", 60843],
    ["Sword", 61903], ["Fire", 60723], ["Cloud", 60317], ["Rain", 61526], ["Umbrella", 62019],
    ["Rainbow", 61524], ["Happy", 60557], ["Sad", 60564], ["Unhappy", 60566], ["Bear", 60088],
    ["Mind", 61232], ["Eye", 60597], ["Key", 61039], ["Open door", 60492], ["Home", 60970],
    ["School", 62298], ["Picture", 61003], ["Folder", 60778], ["Film", 60705], ["Chat", 60255],
    ["Computer", 60362], ["Bug", 60167], ["Rocket", 61590], ["Planet", 62367], ["Mouse ears", 61268],
];

const IMAGE_FILTER = [{name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"]}];

function artFolder() {
    return ctx.getLocalPath() + fileTerminator + terminatePath("store\\mod_art");
}

function isManagedArt(path) {
    return !!path && path.startsWith(artFolder());
}

/** Copies an image into store\mod_art so it keeps working if the original moves. */
async function copyArt(source, modName, kind) {
    const folder = artFolder();
    await mkdir(folder, {recursive: true});
    const ext = (source.split(".").pop() || "png").toLowerCase();
    const safe = modName.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40);
    const target = folder + fileTerminator + safe + "-" + kind + "-" + Date.now() + "." + ext;
    await writeFile(target, await readFile(source));
    return target;
}

async function forgetArt(path) {
    if (isManagedArt(path)) {
        await remove(path).catch(() => {
        });
    }
}

function artUrl(path) {
    return convertFileSrc(path);
}

function openIconPicker(name) {
    const launcher = name ? getLauncher(name) : undefined;
    if (!launcher) return;
    const functions = launcher.getFunctions();
    const current = functions.getConfig().icon;

    const setIcon = async icon => {
        if (current?.image && current.image !== icon?.image) await forgetArt(current.image);
        await functions.update({icon});
        Library.apply();
        closeModal();
    };

    openModal("Icon for " + name, body => {
        const grid = el("div", {class: "ddx-icon-grid", role: "listbox", "aria-label": "Icons"}, ICONS.map(([label, code]) => {
            const button = el("button", {
                class: "ddx-icon-choice" + (current?.glyph === code ? " ddx-icon-current" : ""),
                title: label, "aria-label": label, role: "option",
                "aria-selected": String(current?.glyph === code),
                text: String.fromCodePoint(code),
            });
            button.addEventListener("click", () => setIcon({glyph: code}));
            return button;
        }));
        body.append(
            grid,
            el("div", {class: "ddx-actions"}, [
                el("button", {class: "ddx-button ddx-button-ghost", text: "Reset to default", onClick: () => setIcon(null)}),
                el("button", {
                    class: "ddx-button", text: "Use an image…", onClick: async () => {
                        const picked = await openFileDialog({multiple: false, directory: false, filters: IMAGE_FILTER, title: "Choose an icon image"});
                        if (!picked) return;
                        try {
                            await setIcon({image: await copyArt(picked, name, "icon")});
                        } catch (e) {
                            toast("Couldn't use that image: " + e, "error", 6000);
                        }
                    },
                }),
            ]),
        );
    }, true);
}

let homeBackground = null;

/** Shows the current mod's own background, or puts the home background back. */
function applyModBackground(config) {
    const bg = document.getElementById("bg");
    if (!bg) return;
    if (config?.background) {
        if (!homeBackground) {
            homeBackground = {
                image: bg.style.backgroundImage,
                height: bg.style.height,
                position: bg.style.backgroundPositionY,
            };
        }
        bg.style.backgroundImage = 'url("' + artUrl(config.background) + '")';
        bg.style.height = "100%";
        bg.style.backgroundPositionY = "center";
    } else if (homeBackground) {
        bg.style.backgroundImage = homeBackground.image;
        bg.style.height = homeBackground.height;
        bg.style.backgroundPositionY = homeBackground.position;
        homeBackground = null;
    }
    document.getElementById("ddx-remove-bg")?.classList.toggle("ddx-hidden", !config?.background);
}

async function chooseBackground() {
    const launcher = currentLauncher();
    if (!launcher) return;
    const functions = launcher.getFunctions();
    const picked = await openFileDialog({
        multiple: false, directory: false, filters: IMAGE_FILTER, title: "Choose a background for " + functions.getName(),
        defaultPath: ctx.getLocalPath() + fileTerminator + terminatePath("store\\images") + fileTerminator,
    });
    if (!picked) return;
    try {
        const old = functions.getConfig().background;
        const path = await copyArt(picked, functions.getName(), "background");
        await functions.update({background: path});
        await forgetArt(old);
        applyModBackground(functions.getConfig());
        toast("Background set for " + functions.getName(), "ok");
    } catch (e) {
        toast("Couldn't use that image: " + e, "error", 6000);
    }
}

async function removeBackground() {
    const launcher = currentLauncher();
    if (!launcher) return;
    const functions = launcher.getFunctions();
    const old = functions.getConfig().background;
    await functions.update({background: ""});
    await forgetArt(old);
    applyModBackground(functions.getConfig());
    toast("Background removed");
}

// ---------- grab images from a mod's Reddit post ----------

const PASTE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"};
let pasteHandler = null;

function stopPasteListening() {
    if (pasteHandler) document.removeEventListener("paste", pasteHandler, true);
    pasteHandler = null;
}

/** Saves a pasted picture into store\temp\reddit_images and returns its path. */
async function savePastedImage(file) {
    const ext = PASTE_TYPES[file.type];
    if (!ext) throw new Error("That clipboard item isn't a PNG, JPG, WebP or GIF picture.");
    if (file.size > 20 * 1024 * 1024) throw new Error("That picture is bigger than 20 MB.");
    const folder = ctx.getLocalPath() + fileTerminator + terminatePath("store\\temp\\reddit_images");
    await mkdir(folder, {recursive: true});
    const path = folder + fileTerminator + "paste-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
    await writeFile(path, new Uint8Array(await file.arrayBuffer()));
    return path;
}

/** One picture in the grabber grid, with buttons to use it for this mod. */
function grabbedImageCard(name, path) {
    const functions = getLauncher(name).getFunctions();
    const done = (button, label) => {
        button.textContent = label;
        button.disabled = true;
    };
    const guard = action => async event => {
        try {
            await action(event.currentTarget);
        } catch (e) {
            toast(String(e), "error", 6000);
        }
    };
    const useBackground = el("button", {class: "ddx-mini", text: "Background"});
    const useIcon = el("button", {class: "ddx-mini", text: "Icon"});
    const useCover = el("button", {class: "ddx-mini", text: "Cover"});
    useBackground.addEventListener("click", guard(async button => {
        const old = functions.getConfig().background;
        await functions.update({background: await copyArt(path, name, "background")});
        await forgetArt(old);
        if (ctx.getCurrentEntry() === name) applyModBackground(functions.getConfig());
        done(button, "Background set");
    }));
    useIcon.addEventListener("click", guard(async button => {
        const old = functions.getConfig().icon?.image;
        await functions.update({icon: {image: await copyArt(path, name, "icon")}});
        await forgetArt(old);
        Library.apply();
        done(button, "Icon set");
    }));
    useCover.addEventListener("click", guard(async button => {
        const coverId = await ctx.addCover(path);
        if (coverId >= 0) {
            if (ctx.getCurrentEntry() === name) await functions.setCover(coverId);
            else await functions.update({coverId});
        }
        done(button, "Cover set");
    }));
    return el("figure", {class: "ddx-grab-item"}, [
        el("img", {src: convertFileSrc(path), alt: "Picture for " + name, loading: "lazy"}),
        el("figcaption", {class: "ddx-grab-actions"}, [useBackground, useIcon, useCover]),
    ]);
}

/**
 * Get pictures from a mod's Reddit post: open it in your own browser, copy a
 * picture (or its link) and paste it here. Reddit blocks the app from reading
 * posts directly, so the pictures come through the clipboard instead.
 */
function grabRedditImages(name) {
    const launcher = name ? getLauncher(name) : undefined;
    if (!launcher) return;
    const link = launcher.getFunctions().getConfig().reddit;

    openModal("Images from Reddit · " + name, body => {
        const grid = el("div", {class: "ddx-grab-grid"});
        const empty = el("p", {class: "ddx-grab-empty", text: "Pasted pictures show up here."});
        const status = el("p", {class: "ddx-text ddx-grab-status", role: "status", "aria-live": "polite"});
        const linkInput = el("input", {
            class: "ddx-input", placeholder: "…or paste a picture link (i.redd.it, preview.redd.it, i.imgur.com)",
            spellcheck: "false", autocomplete: "off",
        });

        const addPaths = paths => {
            empty.remove();
            for (const path of paths) grid.prepend(grabbedImageCard(name, path));
        };
        const addLinks = async text => {
            const urls = text.split(/\s+/).filter(u => /^https:\/\//i.test(u));
            if (urls.length === 0) return false;
            status.textContent = "Downloading…";
            try {
                const images = await invoke("ddx_fetch_images", {urls});
                if (images.length === 0) {
                    status.textContent = "Couldn't download that. Only picture links from i.redd.it, preview.redd.it and i.imgur.com work, so try Copy image instead.";
                } else {
                    addPaths(images.map(i => i.path));
                    status.textContent = "Added " + images.length + " picture" + (images.length === 1 ? "" : "s") + ".";
                }
            } catch (e) {
                status.textContent = String(e);
            }
            return true;
        };

        pasteHandler = async event => {
            const items = [...(event.clipboardData?.items ?? [])];
            const files = items.filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
            if (files.length > 0) {
                event.preventDefault();
                try {
                    const paths = [];
                    for (const file of files) paths.push(await savePastedImage(file));
                    addPaths(paths);
                    status.textContent = "Added " + paths.length + " picture" + (paths.length === 1 ? "" : "s") + ".";
                } catch (e) {
                    status.textContent = String(e);
                }
                return;
            }
            // Text pasted outside the link box: treat it as picture links
            if (event.target !== linkInput) {
                const text = event.clipboardData?.getData("text") ?? "";
                if (text && await addLinks(text)) event.preventDefault();
            }
        };
        document.addEventListener("paste", pasteHandler, true);

        linkInput.addEventListener("keydown", async e => {
            if (e.key === "Enter" && linkInput.value.trim()) {
                await addLinks(linkInput.value);
                linkInput.value = "";
            }
        });

        body.append(
            el("ol", {class: "ddx-steps"}, [
                el("li", {}, [link
                    ? el("button", {class: "ddx-link", text: "Open the post in your browser", onClick: () => openUrl(link)})
                    : "Open the mod's Reddit post in your browser"]),
                el("li", {}, ["Right-click a picture and choose ", el("b", {text: "Copy image"}), "."]),
                el("li", {}, ["Come back here and press ", el("b", {text: "Ctrl+V"}), ". Repeat for as many pictures as you like."]),
            ]),
            linkInput,
            status,
            grid,
            empty,
            el("div", {class: "ddx-actions"}, [el("button", {class: "ddx-button", text: "Done", onClick: closeModal})]),
        );
    }, true);
}

// ---------- right-click menu on sidebar mods ----------

function closeRowMenu() {
    const menu = document.getElementById("ddx-row-menu");
    if (!menu || menu.classList.contains("ddx-hidden")) return;
    menu.classList.add("ddx-hidden");
    menu.replaceChildren();
}

/** Opens a mod's page if it isn't the one showing, so page-based actions apply to it. */
async function ensureOpen(name) {
    if (ctx.getCurrentEntry() !== name) await getLauncher(name)?.getFunctions().leftClick();
}

/** Pin/favorite also update the open page's pin and heart; keep those on the open mod. */
function restorePageMarkers() {
    const current = currentLauncher();
    if (!current) {
        // Home page: no pin or heart is shown there
        Hud.setPinned(false);
        const heart = document.getElementById("covertext");
        if (heart) heart.innerHTML = "";
        return;
    }
    const config = current.getFunctions().getConfig();
    Hud.setPinned(!!config.pinned);
    Hud.setHeart(!!config.favorite);
}

async function updateMod(name, patch) {
    const launcher = getLauncher(name);
    if (!launcher) return;
    await launcher.getFunctions().update(patch);
    Library.apply();
    if (ctx.getCurrentEntry() === name) await showMeta(name);
}

function openRowMenu(name, x, y) {
    const launcher = getLauncher(name);
    const menu = document.getElementById("ddx-row-menu");
    if (!launcher || !menu) return;
    // Not over an open panel or dialog: its actions would happen behind it
    const dialogOpen = document.getElementById("ddx-dialog")?.classList.contains("ddx-hidden") === false;
    if (isModalOpen() || dialogOpen) return;
    const functions = launcher.getFunctions();
    const config = functions.getConfig();
    const icon = code => el("span", {class: "ddx-side-icon", text: String.fromCodePoint(code)});
    const item = (code, label, action, extra = "") => el("button", {
        class: "ddx-menu-item" + extra, role: "menuitem", onClick: async () => {
            closeRowMenu();
            try {
                await action();
            } catch (e) {
                toast(String(e), "error", 6000);
            }
        },
    }, [icon(code), " " + label]);
    const divider = () => el("div", {class: "ddx-menu-divider", role: "separator"});

    const stars = el("div", {class: "ddx-menu-row", role: "group", "aria-label": "Rating"}, [
        el("span", {class: "ddx-menu-label", text: "Rate"}),
        ...[1, 2, 3, 4, 5].map(n => el("button", {
            class: "ddx-menu-star" + (n <= (config.rating ?? 0) ? " ddx-star-on" : ""),
            text: "★", title: n + " star" + (n > 1 ? "s" : ""), "aria-label": n + " stars",
            onClick: async () => {
                closeRowMenu();
                await updateMod(name, {rating: config.rating === n ? 0 : n});
            },
        })),
    ]);
    const statuses = el("div", {class: "ddx-menu-row ddx-menu-chips", role: "group", "aria-label": "Status"},
        Library.STATUSES.filter(s => s.id).map(s => el("button", {
            class: "ddx-menu-chip" + (config.status === s.id ? " ddx-menu-chip-on" : ""),
            "aria-pressed": String(config.status === s.id),
            onClick: async () => {
                closeRowMenu();
                await updateMod(name, {status: config.status === s.id ? "" : s.id});
            },
        }, [el("span", {class: "ddx-dot", "data-status": s.id}), " " + s.label])));

    menu.replaceChildren(...[
        el("div", {class: "ddx-menu-title", text: name}),
        item(61450, "Play", async () => {
            await ensureOpen(name);
            document.getElementById("play").dispatchEvent(new MouseEvent("mouseup", {bubbles: true, button: 0}));
        }),
        item(config.pinned ? 62327 : 61497, config.pinned ? "Unpin" : "Pin to top", async () => {
            await functions.setPinned();
            restorePageMarkers();
            Library.apply();
        }),
        item(60943, config.favorite ? "Remove from favorites" : "Add to favorites", async () => {
            await functions.onFavorite();
            restorePageMarkers();
            Library.apply();
        }),
        divider(),
        stars,
        statuses,
        divider(),
        item(62317, "Change icon…", () => openIconPicker(name)),
        item(61003, "Set background…", async () => {
            await ensureOpen(name);
            await chooseBackground();
        }),
        config.background ? item(61568, "Remove background", async () => {
            await ensureOpen(name);
            await removeBackground();
        }) : null,
        config.reddit ? item(60591, "Open Reddit post", () => openUrl(config.reddit)) : null,
        config.reddit
            ? item(61003, "Grab images from Reddit…", () => grabRedditImages(name))
            : item(61106, "Add Reddit link…", async () => {
                await ensureOpen(name);
                openRedditEditor();
            }),
        item(60784, "Open mod folder", () => functions.path()),
        driveStatus.signed_in ? item(62028, "Upload saves to Drive", () => uploadSaves(launcher)) : null,
        item(60550, "Rename…", async () => {
            await ensureOpen(name);
            const title = document.getElementById("modtitle");
            title.focus();
            title.select();
        }),
        divider(),
        item(61568, "Reset save data…", async () => {
            await ensureOpen(name);
            document.getElementById("reset-save").dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
        }),
        item(60458, "Delete mod…", async () => {
            await ensureOpen(name);
            document.getElementById("delete").dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
        }, " ddx-menu-danger"),
    ].filter(Boolean));

    // Up/Down move between the menu's buttons
    menu.onkeydown = e => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const buttons = [...menu.querySelectorAll("button")];
        const index = buttons.indexOf(document.activeElement);
        const next = e.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
    };

    // Place it at the pointer, kept inside the window
    menu.classList.remove("ddx-hidden");
    menu.style.left = "0px";
    menu.style.top = "0px";
    const box = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.querySelector(".ddx-menu-item")?.focus();
}

// ---------- sidebar customization ----------

function openMainLinksSettings() {
    openModal("Main links", body => {
        const list = el("div", {class: "ddx-link-list"}, Sidebar.LINKS.map(link => {
            const box = el("input", {type: "checkbox", class: "ddx-check"});
            box.checked = !Sidebar.get().hiddenLinks.includes(link.id);
            box.addEventListener("change", async () => {
                const hidden = new Set(Sidebar.get().hiddenLinks);
                if (box.checked) hidden.delete(link.id); else hidden.add(link.id);
                await Sidebar.set({hiddenLinks: [...hidden]});
            });
            return el("label", {class: "ddx-toggle"}, [box, el("span", {text: link.label})]);
        }));
        body.append(
            el("p", {class: "ddx-text", text: "Untick a link to hide it from the sidebar. Home always stays."}),
            list,
            el("div", {class: "ddx-actions"}, [
                el("button", {
                    class: "ddx-button ddx-button-ghost", text: "Show all", onClick: async () => {
                        await Sidebar.set({hiddenLinks: []});
                        openMainLinksSettings();
                    },
                }),
                el("button", {class: "ddx-button", text: "Done", onClick: closeModal}),
            ]),
        );
    });
}

function openSidebarSettings() {
    openModal("Customize sidebar", body => {
        const prefs = Sidebar.get();
        const check = (label, hint, checked, onChange) => {
            const box = el("input", {type: "checkbox", class: "ddx-check"});
            box.checked = checked;
            box.addEventListener("change", () => onChange(box.checked));
            return el("label", {class: "ddx-toggle"}, [box, el("span", {}, [label, hint ? el("span", {class: "ddx-subtle", text: " " + hint}) : null])]);
        };
        const update = async patch => {
            await Sidebar.set(patch);
            Library.apply();
        };

        const density = el("div", {class: "ddx-segment", role: "radiogroup", "aria-label": "Row size"},
            [["comfortable", "Comfortable"], ["compact", "Compact"]].map(([value, label]) => {
                const button = el("button", {class: "ddx-segment-item", role: "radio", text: label, "aria-checked": String(prefs.density === value)});
                button.addEventListener("click", async () => {
                    density.querySelectorAll("button").forEach(b => b.setAttribute("aria-checked", String(b === button)));
                    await update({density: value});
                });
                return button;
            }));

        body.append(
            el("h3", {class: "ddx-section", text: "Each mod row shows"}),
            check("Status dot", "(playing, plan to play, completed, dropped)", prefs.showStatus, v => update({showStatus: v})),
            check("Rating", null, prefs.showRating, v => update({showRating: v})),
            check("Play time", null, prefs.showTime, v => update({showTime: v})),
            el("h3", {class: "ddx-section", text: "Row size"}),
            density,
            el("h3", {class: "ddx-section", text: "Main links"}),
            el("div", {class: "ddx-grid2"}, Sidebar.LINKS.map(link => check(link.label, null, !Sidebar.get().hiddenLinks.includes(link.id), v => {
                const hidden = new Set(Sidebar.get().hiddenLinks);
                if (v) hidden.delete(link.id); else hidden.add(link.id);
                return update({hiddenLinks: [...hidden]});
            }))),
            el("h3", {class: "ddx-section", text: "Library"}),
            check("Sort and filter bar", null, prefs.showSortBar, v => update({showSortBar: v})),
            el("div", {class: "ddx-actions"}, [
                el("button", {
                    class: "ddx-button ddx-button-ghost", text: "Reset to default", onClick: async () => {
                        await update({...Sidebar.DEFAULTS});
                        openSidebarSettings();
                    },
                }),
                el("button", {class: "ddx-button", text: "Done", onClick: closeModal}),
            ]),
        );
    });
}

// ---------- duplicate warning ----------

/** Returns false if the user chose not to import a mod that looks like one they already have. */
export async function confirmNotDuplicate(path) {
    const fileName = path.split(/[\\/]/).pop();
    const matches = Library.findSimilarMods(fileName);
    if (matches.length === 0) return true;
    const list = matches.slice(0, 5).map(m => "• " + m).join("\n");
    return await confirm(
        "\"" + fileName + "\" looks like a mod you already have:\n\n" + list + "\n\nImport it anyway?",
        {title: "Possible duplicate", okLabel: "Import anyway", cancelLabel: "Cancel"},
    );
}

// ---------- drag and drop overlay ----------

async function setupDropOverlay() {
    const overlay = document.getElementById("ddx-drop");
    const show = () => overlay.classList.add("ddx-drop-visible");
    const hide = () => overlay.classList.remove("ddx-drop-visible");
    await listen("tauri://drag-enter", show);
    await listen("tauri://drag-over", show);
    await listen("tauri://drag-leave", hide);
    await listen("tauri://drag-drop", hide);
}

// ---------- build ----------

function buildDom() {
    const main = document.getElementById("main");
    const container = document.getElementById("container");
    const modcount = document.getElementById("modcount");

    // Sidebar sort / filter bar
    const sort = el("select", {id: "ddx-sort", class: "ddx-select", title: "Sort mods"},
        Library.SORTS.map(s => el("option", {value: s.id, text: "Sort: " + s.label})));
    const filter = el("select", {id: "ddx-filter", class: "ddx-select", title: "Show mods"},
        Library.FILTERS.map(f => el("option", {value: f.id, text: f.label})));
    sort.addEventListener("change", () => Library.setSort(sort.value));
    filter.addEventListener("change", () => Library.setFilter(filter.value));
    const gear = el("button", {
        id: "ddx-sidebar-settings", class: "ddx-gear", title: "Customize sidebar", "aria-label": "Customize sidebar",
        text: String.fromCodePoint(61670), onClick: openSidebarSettings,
    });
    const bar = el("div", {id: "ddx-library-bar", class: "sticky ddx-library-bar"}, [sort, filter]);
    const foldButton = section => el("button", {
        id: "ddx-fold-" + section, class: "ddx-fold", "aria-expanded": "true",
        "aria-label": section === "main" ? "Main links" : "Mod list",
        text: String.fromCodePoint(59982),
        onClick: e => {
            e.stopPropagation();
            Sidebar.toggleSection(section);
        },
    });
    const mainHeader = document.getElementById("main-text").closest("header");
    mainHeader.append(foldButton("main"), el("button", {
        id: "ddx-main-settings", class: "ddx-gear", title: "Choose Main links", "aria-label": "Choose Main links",
        text: String.fromCodePoint(61670), onClick: openMainLinksSettings,
    }));
    modcount.append(foldButton("mods"), gear);
    // Clicking the heading word folds too
    for (const [labelId, section] of [["main-text", "main"], ["mods-text", "mods"]]) {
        const label = document.getElementById(labelId);
        label.classList.add("ddx-fold-label");
        label.addEventListener("click", () => Sidebar.toggleSection(section));
    }
    modcount.after(bar);
    bar.after(el("p", {id: "ddx-empty", class: "sticky ddx-empty ddx-hidden"}));

    // Right-click (or the Menu key / Shift+F10) on a mod in the sidebar opens its quick menu
    const modlist = document.getElementById("modlist");
    modlist.addEventListener("contextmenu", e => {
        const row = e.target.closest?.("header.sidebutton");
        if (!row?.id.startsWith("mod-")) return;
        e.preventDefault();
        const box = row.getBoundingClientRect();
        const fromKeyboard = e.button !== 2 || (e.clientX === 0 && e.clientY === 0);
        openRowMenu(row.id.substring(4), fromKeyboard ? box.left + 24 : e.clientX, fromKeyboard ? box.bottom : e.clientY);
    });
    modlist.addEventListener("keydown", e => {
        const row = e.target.closest?.("header.sidebutton");
        if (!row?.id.startsWith("mod-")) return;
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            const box = row.getBoundingClientRect();
            openRowMenu(row.id.substring(4), box.left + 24, box.bottom);
        }
    });
    document.getElementById("main").append(el("div", {id: "ddx-row-menu", class: "ddx-menu ddx-row-menu ddx-hidden", role: "menu"}));
    document.addEventListener("mousedown", e => {
        const menu = document.getElementById("ddx-row-menu");
        if (menu && !menu.contains(e.target)) closeRowMenu();
    });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeRowMenu();
    });

    // Mod page meta row
    const stars = el("div", {id: "ddx-stars", class: "ddx-stars", title: "Your rating"},
        [1, 2, 3, 4, 5].map(n => {
            const star = el("button", {class: "ddx-star", text: "★", "aria-label": n + " star" + (n > 1 ? "s" : "")});
            star.addEventListener("mouseenter", () => renderStars(currentLauncher()?.getFunctions().getConfig().rating ?? 0, n));
            star.addEventListener("click", () => setRating(n));
            return star;
        }));
    stars.addEventListener("mouseleave", () => renderStars(currentLauncher()?.getFunctions().getConfig().rating ?? 0));
    const status = el("select", {id: "ddx-status", class: "ddx-select ddx-status", title: "Status"},
        Library.STATUSES.map(s => el("option", {value: s.id, text: s.label})));
    status.addEventListener("change", () => setStatus(status.value));

    container.appendChild(el("div", {id: "ddx-meta", class: "ddx-meta ddx-hidden"}, [
        stars,
        el("span", {id: "ddx-rating-label", class: "ddx-rating-label"}),
        status,
        el("button", {id: "ddx-reddit", class: "ddx-chip", onClick: onRedditClick}),
        el("button", {id: "ddx-reddit-edit", class: "ddx-chip ddx-chip-icon", title: "Edit Reddit link", text: "✎", onClick: openRedditEditor}),
        el("button", {id: "ddx-cloud", class: "ddx-chip", text: "☁ Cloud saves", onClick: openModCloud}),
    ]));

    // Top bar pills
    const sideLink = (id, icon, label, title, onClick) => el("button", {id, class: "sidebutton sidebutton2 sticky", title, onClick}, [
        el("span", {class: "ddx-side-icon", text: String.fromCodePoint(icon)}),
        " " + label,
    ]);
    document.getElementById("update").after(
        sideLink("ddx-side-storage", 60921, "Storage", "See what your mods use and clean up", openStorage),
        sideLink("ddx-side-cloud", 60317, "Cloud Saves", "Google Drive save sync", openDriveSettings),
        el("button", {
            id: "ddx-side-reimport", class: "sidebutton sidebutton2 sticky ddx-reimport ddx-hidden",
            title: "Mods restored from Google Drive that aren't on this PC yet", onClick: openReimport,
        }, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(60802)}),
            " ",
            el("span", {class: "ddx-reimport-label", text: "Reimport mods"}),
        ]),
    );

    // "More" menu with the destructive actions, beside the Profiles button
    const more = el("button", {id: "ddx-more", class: "ddx-more hide", title: "More actions", "aria-haspopup": "menu", text: String.fromCodePoint(61302)});
    const fire = id => {
        menu.classList.add("ddx-hidden");
        document.getElementById(id)?.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}));
    };
    const run = action => () => {
        menu.classList.add("ddx-hidden");
        action();
    };
    const menu = el("div", {id: "ddx-more-menu", class: "ddx-menu ddx-hidden", role: "menu"}, [
        el("button", {class: "ddx-menu-item", role: "menuitem", onClick: run(() => openIconPicker(ctx.getCurrentEntry()))}, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(62317)}), " Change icon…",
        ]),
        el("button", {class: "ddx-menu-item", role: "menuitem", onClick: run(chooseBackground)}, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(61003)}), " Set background…",
        ]),
        el("button", {id: "ddx-remove-bg", class: "ddx-menu-item", role: "menuitem", onClick: run(removeBackground)}, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(61568)}), " Remove background",
        ]),
        el("button", {id: "ddx-grab-reddit", class: "ddx-menu-item", role: "menuitem", onClick: run(() => grabRedditImages(ctx.getCurrentEntry()))}, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(60591)}), " Grab images from Reddit…",
        ]),
        el("div", {class: "ddx-menu-divider", role: "separator"}),
        el("button", {class: "ddx-menu-item", role: "menuitem", onClick: () => fire("reset-save")}, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(61568)}), " Reset save data…",
        ]),
        el("button", {class: "ddx-menu-item ddx-menu-danger", role: "menuitem", onClick: () => fire("delete")}, [
            el("span", {class: "ddx-side-icon", text: String.fromCodePoint(60458)}), " Delete mod…",
        ]),
    ]);
    more.addEventListener("click", e => {
        e.stopPropagation();
        menu.classList.toggle("ddx-hidden");
        if (!menu.classList.contains("ddx-hidden")) menu.querySelector("button")?.focus();
    });
    document.addEventListener("click", e => {
        if (!menu.contains(e.target) && e.target !== more) menu.classList.add("ddx-hidden");
    });
    menu.addEventListener("keydown", e => {
        if (e.key === "Escape") {
            menu.classList.add("ddx-hidden");
            more.focus();
        }
    });
    container.append(more, menu);
    new MutationObserver(() => more.classList.toggle("hide", document.getElementById("play").classList.contains("hide")))
        .observe(document.getElementById("play"), {attributes: true, attributeFilter: ["class"]});

    // Modal, toast, drop overlay
    const bg = el("div", {id: "ddx-modal-bg", class: "ddx-modal-bg ddx-hidden"}, [
        el("div", {class: "ddx-modal"}, [
            el("header", {class: "ddx-modal-title"}),
            el("button", {class: "ddx-modal-close", text: "✕", title: "Close", onClick: closeModal}),
            el("div", {class: "ddx-modal-body"}),
        ]),
    ]);
    bg.addEventListener("mousedown", e => {
        if (e.target === bg) closeModal();
    });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && isModalOpen()) closeModal();
    });
    main.append(
        bg,
        el("div", {id: "ddx-toast", class: "ddx-toast", role: "status", "aria-live": "polite"}, [
            el("div", {class: "ddx-namebox"}),
            el("div", {class: "ddx-toast-text"}),
        ]),
        el("div", {id: "ddx-drop", class: "ddx-drop"}, [
            el("div", {class: "ddx-drop-box"}, [
                el("div", {class: "ddx-drop-title", text: "Drop to import"}),
                el("div", {class: "ddx-drop-sub", text: "Mods: .zip, .rar, .rpa  ·  Covers: images"}),
            ]),
        ]),
    );
}

/** Syncs the sort/filter dropdowns with the saved choice and reorders the list. */
export function onLibraryLoaded() {
    Sidebar.loadSaved();
    Library.loadSaved();
    const sort = document.getElementById("ddx-sort");
    const filter = document.getElementById("ddx-filter");
    if (sort) sort.value = Library.getSort();
    if (filter) filter.value = Library.getFilter();
    Library.apply();
    refreshReimportReminder();
    startLauncherSync();
}

/**
 * Most of the original buttons listen for "mouseup", which keyboards never send.
 * Enter/Space on such a button sends one, and Enter on a mod row opens it.
 */
function setupKeyboard() {
    document.addEventListener("keydown", e => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const target = e.target;
        if (!(target instanceof HTMLElement) || target.closest("#ddx-dialog, #ddx-modal-bg, #ddx-more-menu")) return;
        if (target.matches("header.sidebutton")) {
            e.preventDefault();
            target.click();
        } else if (target.matches("button") && !target.id.startsWith("ddx-")) {
            target.dispatchEvent(new MouseEvent("mouseup", {bubbles: true, button: 0}));
        }
    });
}

/**
 * The original screen blur can be left on with nothing above it (a panel that
 * never opened). Clicking it or pressing Escape then clears it.
 */
function setupBlurRescue() {
    const blur = document.getElementById("profile-blur");
    if (!blur) return;
    const panelOpen = () =>
        !document.getElementById("profile-bg")?.classList.contains("hide") ||
        !document.getElementById("report-bg")?.classList.contains("hide") ||
        document.getElementById("image-picker-bg")?.classList.contains("image-picker-visible") ||
        !document.getElementById("input-prompt")?.classList.contains("hide");
    const rescue = () => {
        if (!blur.classList.contains("hide") && !panelOpen()) blur.classList.add("hide");
    };
    blur.addEventListener("mouseup", e => {
        if (e.target === blur) rescue();
    });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && !isModalOpen() && document.getElementById("ddx-dialog")?.classList.contains("ddx-hidden") !== false) rescue();
    });
}

export async function init(context) {
    ctx = {...ctx, ...context};
    Library.init(context.getProgramConfig, context.saveProgramConfig);
    Sidebar.init(context.getProgramConfig, context.saveProgramConfig);
    buildDom();
    setupKeyboard();
    setupBlurRescue();
    await setupDropOverlay();
    await refreshDriveStatus();
}
