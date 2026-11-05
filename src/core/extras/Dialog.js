/**
 * In-app dialogs and notifications drawn as DDLC's textbox, voiced by the
 * current theme's character. Drop-in replacement for the dialog plugin's confirm().
 */

const SPEAKERS = {
    NATSUKI: "Natsuki",
    MONIKA: "Monika",
    YURI: "Yuri",
    SAYORI: "Sayori",
};

let speaker = "Natsuki";
let queue = Promise.resolve();
let toastTimer = null;

export function setSpeaker(theme) {
    speaker = SPEAKERS[theme] ?? "Mod Manager";
    const tag = document.querySelector("#ddx-toast .ddx-namebox");
    if (tag) tag.textContent = speaker;
}

function ensureRoot() {
    let root = document.getElementById("ddx-dialog");
    if (root) return root;
    root = document.createElement("div");
    root.id = "ddx-dialog";
    root.className = "ddx-dialog-bg ddx-hidden";
    root.innerHTML = `
        <div class="ddx-textbox" role="alertdialog" aria-modal="true" aria-labelledby="ddx-dialog-title" aria-describedby="ddx-dialog-text">
            <div class="ddx-namebox"></div>
            <div class="ddx-textbox-title" id="ddx-dialog-title"></div>
            <div class="ddx-textbox-text" id="ddx-dialog-text"></div>
            <div class="ddx-choices"></div>
        </div>`;
    (document.getElementById("main") ?? document.body).appendChild(root);
    return root;
}

function show({message, title, buttons, danger}) {
    return new Promise(resolve => {
        const root = ensureRoot();
        const box = root.querySelector(".ddx-textbox");
        box.classList.toggle("ddx-textbox-danger", !!danger);
        root.querySelector(".ddx-namebox").textContent = speaker;
        const titleEl = root.querySelector(".ddx-textbox-title");
        titleEl.textContent = title ?? "";
        titleEl.classList.toggle("ddx-hidden", !title);
        root.querySelector(".ddx-textbox-text").textContent = String(message ?? "");
        const choices = root.querySelector(".ddx-choices");
        choices.replaceChildren();

        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            document.removeEventListener("keydown", onKey, true);
            root.classList.add("ddx-hidden");
            resolve(value);
        };
        const onKey = e => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finish(buttons.find(b => b.cancel)?.value ?? false);
            }
        };

        for (const b of buttons) {
            const button = document.createElement("button");
            button.className = "ddx-choice" + (b.primary ? " ddx-choice-primary" : "") + (b.danger ? " ddx-choice-danger" : "");
            button.textContent = b.label;
            button.addEventListener("click", () => finish(b.value));
            choices.appendChild(button);
        }

        document.addEventListener("keydown", onKey, true);
        root.classList.remove("ddx-hidden");
        // A destructive question starts on the safe answer, so Enter never deletes by accident.
        const first = danger
            ? choices.firstElementChild
            : [...choices.children].find(c => c.classList.contains("ddx-choice-primary")) ?? choices.lastElementChild;
        setTimeout(() => first?.focus(), 30);
    });
}

/**
 * Same call shape as @tauri-apps/plugin-dialog confirm().
 * Without a cancelLabel it is a plain message with one button.
 * @param {string} message
 * @param {{title?: string, okLabel?: string, cancelLabel?: string, kind?: string, danger?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export function confirm(message, options = {}) {
    if (typeof options === "string") options = {title: options};
    const asks = options.cancelLabel !== undefined;
    const buttons = asks
        ? [
            {label: options.cancelLabel, value: false, cancel: true},
            {label: options.okLabel ?? "OK", value: true, primary: true, danger: options.danger},
        ]
        : [{label: options.okLabel ?? "OK", value: true, primary: true, cancel: true}];
    const run = () => show({message, title: options.title, buttons, danger: options.danger});
    const result = queue.then(run, run);
    queue = result.catch(() => {
    });
    return result;
}

export function message(text, options = {}) {
    return confirm(text, options);
}

/**
 * A short notification in a small textbox at the bottom of the window.
 * @param {string} text
 * @param {"info"|"ok"|"error"} [kind]
 * @param {number} [ms] 0 keeps it until the next one
 */
export function notify(text, kind = "info", ms = 3500) {
    const node = document.getElementById("ddx-toast");
    if (!node) return;
    node.querySelector(".ddx-namebox").textContent = speaker;
    node.querySelector(".ddx-toast-text").textContent = text;
    node.dataset.kind = kind;
    node.classList.add("ddx-toast-visible");
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => node.classList.remove("ddx-toast-visible"), ms);
}

export function hideNotify() {
    clearTimeout(toastTimer);
    document.getElementById("ddx-toast")?.classList.remove("ddx-toast-visible");
}
