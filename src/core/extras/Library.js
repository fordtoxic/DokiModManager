import {getLauncher, getLaunchers} from "../Launchers";
import * as Sidebar from "./Sidebar";

/**
 * Sorting, status filtering and duplicate detection for the mod list.
 *
 * Sidebar items are ordered with the CSS `order` property. Each launcher's
 * getOrder() asks rankOf() for its position, then adds the pinned/favorite offset.
 */

export const STATUSES = [
    {id: "", label: "No status"},
    {id: "playing", label: "Playing"},
    {id: "planned", label: "Plan to play"},
    {id: "completed", label: "Completed"},
    {id: "dropped", label: "Dropped"},
];

export const SORTS = [
    {id: "name", label: "Name"},
    {id: "rating", label: "Rating"},
    {id: "time", label: "Play time"},
    {id: "recent", label: "Last played"},
    {id: "size", label: "Size"},
];

export const FILTERS = [
    {id: "all", label: "All mods"},
    ...STATUSES.filter(s => s.id !== "").map(s => ({id: s.id, label: s.label})),
    {id: "none", label: "No status"},
    {id: "rated", label: "Rated"},
    {id: "unrated", label: "Unrated"},
];

let sortMode = "name";
let filterMode = "all";
let ranks = new Map();
let getProgramConfig = () => null;
let saveProgramConfig = async () => {
};

export function statusLabel(id) {
    return (STATUSES.find(s => s.id === (id ?? "")) ?? STATUSES[0]).label;
}

export function init(configGetter, configSaver) {
    getProgramConfig = configGetter;
    saveProgramConfig = configSaver;
}

/** Reads the saved sort/filter choice once the program config is loaded. */
export function loadSaved() {
    const config = getProgramConfig();
    if (!config) return;
    const savedSort = config.get("library_sort");
    const savedFilter = config.get("library_filter");
    if (SORTS.some(s => s.id === savedSort)) sortMode = savedSort;
    if (FILTERS.some(f => f.id === savedFilter)) filterMode = savedFilter;
}

export function getSort() {
    return sortMode;
}

export function getFilter() {
    return filterMode;
}

export async function setSort(mode) {
    sortMode = mode;
    getProgramConfig()?.set("library_sort", mode);
    apply();
    await saveProgramConfig();
}

export async function setFilter(mode) {
    filterMode = mode;
    getProgramConfig()?.set("library_filter", mode);
    apply();
    await saveProgramConfig();
}

/** Position of a mod within its group; falls back to the alphabetical index. */
export function rankOf(name, alphabeticalIndex) {
    return ranks.has(name) ? ranks.get(name) : alphabeticalIndex;
}

function configOf(name) {
    return getLauncher(name)?.getFunctions().getConfig?.() ?? {};
}

function matchesFilter(config) {
    const status = config.status ?? "";
    switch (filterMode) {
        case "all":
            return true;
        case "none":
            return status === "";
        case "rated":
            return (config.rating ?? 0) > 0;
        case "unrated":
            return !((config.rating ?? 0) > 0);
        default:
            return status === filterMode;
    }
}

/** Recomputes ranks, reorders the sidebar and applies the status filter. */
export function apply() {
    const names = Object.keys(getLaunchers());
    const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
    const value = {
        rating: c => c.rating ?? 0,
        time: c => c.time ?? 0,
        recent: c => c.last_played ?? -1,
        size: c => c.size ?? 0,
    }[sortMode];

    // "Name" compares whole names; the original order only looked at the first letter.
    ranks = new Map();
    names
        .slice()
        .sort(value ? (a, b) => (value(configOf(b)) - value(configOf(a))) || byName(a, b) : byName)
        .forEach((name, index) => ranks.set(name, index));

    let shown = 0;
    for (const name of names) {
        const launcher = getLauncher(name).getFunctions();
        launcher.resetOrder();
        const config = configOf(name);
        const visible = matchesFilter(config);
        launcher.item.classList.toggle("ddx-filtered", !visible);
        launcher.item.tabIndex = 0;
        Sidebar.decorate(launcher.item, config);
        if (visible) shown++;
    }
    Sidebar.setEmptyState(names.length, shown);

    const counter = document.getElementById("nummods");
    if (counter) {
        counter.textContent = filterMode === "all" ? names.length.toString() : shown + "/" + names.length;
    }
}

const NOISE_WORDS = new Set([
    "ddlc", "doki", "mod", "demo", "full", "release", "final", "windows", "win", "pc", "mac", "linux",
    "version", "ver", "update", "patch", "fixed", "fix", "edition", "the", "a", "an", "renpy", "8",
]);

/** Turns "Monika After Story v0.12.3 (Windows).zip" into "monikaafterstory". */
export function normalizeModName(name) {
    return name
        .replace(/\.(zip|rar|7z|tar|gz|rpa)$/i, "")
        .replace(/[([{][^)\]}]*[)\]}]/g, " ")
        .replace(/[_\-.+]/g, " ")
        .toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 0)
        .filter(word => !/^v?\d+(\.\d+)*[a-z]?$/.test(word))
        .filter(word => !NOISE_WORDS.has(word))
        .join("")
        .replace(/[^a-z0-9]/g, "");
}

/** Installed mods whose names look like the same mod as `incomingName`. */
export function findSimilarMods(incomingName) {
    const key = normalizeModName(incomingName);
    if (key.length < 3) return [];
    const matches = [];
    for (const name of Object.keys(getLaunchers())) {
        const other = normalizeModName(name);
        if (other.length < 3) continue;
        const shorter = key.length <= other.length ? key : other;
        const longer = key.length <= other.length ? other : key;
        if (other === key || (shorter.length >= 5 && longer.includes(shorter))) {
            matches.push(name);
        }
    }
    return matches;
}
