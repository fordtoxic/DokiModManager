import {convertFileSrc} from "@tauri-apps/api/core";

/**
 * Sidebar customization: which links show in the Main section, what each mod
 * row shows (status dot, rating, play time), row density and the sort bar.
 */

export const LINKS = [
    {id: "reddit", label: "Reddit"},
    {id: "dokimods", label: "DokiMods"},
    {id: "spreadsheet", label: "SpreadSheet"},
    {id: "update", label: "Updates (Desktop)"},
    {id: "ddx-side-storage", label: "Storage"},
    {id: "ddx-side-cloud", label: "Cloud Saves"},
];

export const DEFAULTS = {
    showStatus: true,
    showRating: true,
    showTime: false,
    density: "comfortable",
    showSortBar: true,
    hiddenLinks: [],
    collapsed: [],
};

/** Sections that can be folded away by clicking their heading. */
export const SECTIONS = ["main", "mods"];

export function isCollapsed(section) {
    return prefs.collapsed.includes(section);
}

export async function toggleSection(section) {
    const collapsed = new Set(prefs.collapsed);
    if (collapsed.has(section)) collapsed.delete(section); else collapsed.add(section);
    await set({collapsed: [...collapsed]});
}

let prefs = {...DEFAULTS};
let getProgramConfig = () => null;
let saveProgramConfig = async () => {
};

export function init(configGetter, configSaver) {
    getProgramConfig = configGetter;
    saveProgramConfig = configSaver;
}

export function get() {
    return prefs;
}

export function loadSaved() {
    const saved = getProgramConfig()?.get("sidebar");
    prefs = {...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {})};
    applyLayout();
}

export async function set(patch) {
    prefs = {...prefs, ...patch};
    getProgramConfig()?.set("sidebar", prefs);
    applyLayout();
    await saveProgramConfig();
}

/** Link visibility, density and the sort bar. Row details are drawn by decorate(). */
export function applyLayout() {
    for (const link of LINKS) {
        document.getElementById(link.id)?.classList.toggle("ddx-hidden", prefs.hiddenLinks.includes(link.id));
    }
    document.getElementById("modlist")?.classList.toggle("ddx-compact", prefs.density === "compact");
    document.getElementById("ddx-library-bar")?.classList.toggle("ddx-hidden", !prefs.showSortBar);
    for (const section of SECTIONS) {
        const collapsed = isCollapsed(section);
        document.getElementById("modlist")?.classList.toggle("ddx-collapsed-" + section, collapsed);
        const toggle = document.getElementById("ddx-fold-" + section);
        if (toggle) {
            toggle.setAttribute("aria-expanded", String(!collapsed));
            toggle.title = (collapsed ? "Show " : "Hide ") + (section === "main" ? "Main links" : "mod list");
        }
    }
}

function formatHours(ms) {
    const minutes = Math.floor((ms ?? 0) / 60000);
    if (minutes < 60) return minutes + "m";
    return Math.floor(minutes / 60) + "h";
}

/** Swaps the row's leading icon for the mod's chosen icon or image. */
function drawIcon(item, icon) {
    const span = item.querySelector(":scope > span");
    if (!span) return;
    if (span.dataset.original === undefined) span.dataset.original = span.innerHTML;
    if (icon?.image) {
        const img = document.createElement("img");
        img.className = "ddx-row-icon";
        img.alt = "";
        img.src = convertFileSrc(icon.image);
        span.replaceChildren(img);
    } else if (icon?.glyph) {
        span.textContent = String.fromCodePoint(icon.glyph);
    } else {
        span.innerHTML = span.dataset.original;
    }
}

/** Adds the icon, status dot, rating and play time to a mod's sidebar row. */
export function decorate(item, config) {
    if (!item) return;
    drawIcon(item, config.icon);
    let meta = item.querySelector(".ddx-row-meta");
    if (!meta) {
        meta = document.createElement("span");
        meta.className = "ddx-row-meta";
        item.appendChild(meta);
    }
    const parts = [];
    if (prefs.showTime && (config.time ?? 0) >= 60000) {
        parts.push(`<span class="ddx-row-time">${formatHours(config.time)}</span>`);
    }
    if (prefs.showRating && (config.rating ?? 0) > 0) {
        parts.push(`<span class="ddx-row-rating">★${config.rating}</span>`);
    }
    if (prefs.showStatus && config.status) {
        parts.push(`<span class="ddx-dot" data-status="${config.status}"></span>`);
    }
    meta.innerHTML = parts.join("");
    item.dataset.status = config.status ?? "";
}

/** Message shown in the mod list when it is empty or the filter hides everything. */
export function setEmptyState(total, shown) {
    const node = document.getElementById("ddx-empty");
    if (!node) return;
    if (total === 0) {
        node.textContent = "No mods yet. Drop a mod's .zip onto this window, or use Import Mod on the home page.";
        node.classList.remove("ddx-hidden");
    } else if (shown === 0) {
        node.textContent = "No mods match this filter.";
        node.classList.remove("ddx-hidden");
    } else {
        node.classList.add("ddx-hidden");
    }
}
