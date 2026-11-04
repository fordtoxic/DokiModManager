import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {confirm} from "@tauri-apps/plugin-dialog";
import {openUrl} from "@tauri-apps/plugin-opener";
import {isExist} from "tauri-plugin-fs-pro-api";
import {getLauncher, getLaunchers} from "../Launchers";
import {fileTerminator, terminatePath} from "../utils/FileSystem";
import {WARN_GENERIC_DATA_PATHS} from "../Constants";
import Logger from "../utils/Logger";
import * as Library from "./Library";
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

let toastTimer = null;

export function toast(message, kind = "info", ms = 3500) {
    const node = document.getElementById("ddx-toast");
    if (!node) return;
    node.textContent = message;
    node.dataset.kind = kind;
    node.classList.add("ddx-toast-visible");
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => node.classList.remove("ddx-toast-visible"), ms);
}

// ---------- modal ----------

function openModal(title, build, wide = false) {
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
    const cloud = document.getElementById("ddx-cloud");
    cloud.title = config.gdrive_synced ? "Last synced " + formatDate(config.gdrive_synced) : "Google Drive saves";
    meta.classList.remove("ddx-hidden");
}

export function hideMeta() {
    document.getElementById("ddx-meta")?.classList.add("ddx-hidden");
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
    document.getElementById("ddx-cloud-pill")?.classList.toggle("ddx-pill-active", driveStatus.signed_in);
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
            el("label", {class: "ddx-toggle"}, [
                auto,
                el("span", {}, [
                    el("b", {text: "Auto-sync"}),
                    el("span", {class: "ddx-subtle", text: " — upload saves when you close a mod, and offer newer saves from your other PCs before you play"}),
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
    modcount.after(el("div", {id: "ddx-library-bar", class: "sticky ddx-library-bar"}, [sort, filter]));

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
    main.append(el("div", {id: "ddx-top-actions", class: "ddx-top-actions"}, [
        el("button", {id: "ddx-storage-pill", class: "ddx-pill", title: "See what your mods use and clean up", onClick: openStorage}, ["▤ ", "Storage"]),
        el("button", {id: "ddx-cloud-pill", class: "ddx-pill", title: "Google Drive save sync", onClick: openDriveSettings}, ["☁ ", "Cloud Saves"]),
    ]));

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
        el("div", {id: "ddx-toast", class: "ddx-toast"}),
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
    Library.loadSaved();
    const sort = document.getElementById("ddx-sort");
    const filter = document.getElementById("ddx-filter");
    if (sort) sort.value = Library.getSort();
    if (filter) filter.value = Library.getFilter();
    Library.apply();
}

export async function init(context) {
    ctx = {...ctx, ...context};
    Library.init(context.getProgramConfig, context.saveProgramConfig);
    buildDom();
    await setupDropOverlay();
    await refreshDriveStatus();
}
