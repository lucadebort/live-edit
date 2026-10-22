/**
 * Injected by the live-edit server into every HTML page it serves.
 * Every element that exists in the source carries a `data-le` id; an edit is
 * sent as an operation on that id and the server patches only that spot.
 */

interface Config {
  page: string;
  hash: string;
  scope: string | null;
}

type Op =
  | { type: "text"; id: number; html: string }
  | {
      type: "attrs";
      id: number;
      set: Record<string, string>;
      remove: string[];
    };

type Status = "idle" | "saving" | "saved" | "error" | "stale";

type Message =
  | { source: "live-edit"; type: "hello" }
  | { source: "live-edit"; type: "mode"; on: boolean }
  | { source: "live-edit"; type: "set"; on: boolean }
  | { source: "live-edit"; type: "status"; status: Status; detail: string };

declare global {
  interface Window {
    __LIVE_EDIT__?: Config;
  }
}

const ID = "data-le";
const UI = "data-live-edit-ui";
const API = "/__live-edit";
const HOVER = "__le-hover";
const ON = "__le-on";
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "HTML",
  "BODY",
  "HEAD",
]);

const config = window.__LIVE_EDIT__;
const isTop = window === window.top;

let hash = config?.hash ?? "";
let editMode = false;
let editing: HTMLElement | null = null;
let hovered: Element | null = null;
let stale = false;
let pending = 0;
let queue: Promise<void> = Promise.resolve();
let toolbar: Toolbar | null = null;

function boot() {
  injectPageStyles();
  if (isTop) toolbar = new Toolbar(() => setEditMode(!editMode));
  else post(window.parent, { source: "live-edit", type: "hello" });

  window.addEventListener("message", onMessage);
  window.addEventListener("keydown", onShortcut, true);
  window.addEventListener("beforeunload", (e) => {
    if (pending > 0) e.preventDefault();
  });
}

// ─── Mode, shared across same-origin iframes ─────────────────────────────────

function setEditMode(on: boolean) {
  if (!isTop)
    return post(window.top!, { source: "live-edit", type: "set", on });
  applyMode(on);
}

function applyMode(on: boolean) {
  editMode = on;
  document.documentElement.classList.toggle(ON, on);
  toolbar?.setMode(on);
  for (let i = 0; i < window.frames.length; i++) {
    post(window.frames[i]!, { source: "live-edit", type: "mode", on });
  }
  if (on) {
    window.addEventListener("click", onClick, true);
    window.addEventListener("mouseover", onHover, true);
  } else {
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("mouseover", onHover, true);
    setHovered(null);
    editing?.blur();
  }
}

function post(target: Window, message: Message) {
  target.postMessage(message, location.origin);
}

function onMessage(e: MessageEvent<Message>) {
  if (e.origin !== location.origin || e.data?.source !== "live-edit") return;
  const msg = e.data;
  if (msg.type === "mode") applyMode(msg.on);
  else if (msg.type === "hello" && e.source)
    post(e.source as Window, {
      source: "live-edit",
      type: "mode",
      on: editMode,
    });
  else if (msg.type === "set" && isTop) applyMode(msg.on);
  else if (msg.type === "status" && isTop)
    toolbar?.setStatus(msg.status, msg.detail);
}

function setStatus(status: Status, detail = "") {
  if (isTop) toolbar?.setStatus(status, detail);
  else
    post(window.top!, { source: "live-edit", type: "status", status, detail });
}

function onShortcut(e: KeyboardEvent) {
  if (e.altKey && e.code === "KeyE" && !editing) {
    e.preventDefault();
    e.stopPropagation();
    setEditMode(!editMode);
  } else if (e.key === "Escape" && editMode && !editing) {
    e.stopPropagation();
    setEditMode(false);
  }
}

// ─── Targeting ───────────────────────────────────────────────────────────────

function inScope(el: Element): boolean {
  if (el.closest(`[${UI}]`)) return false;
  return !config?.scope || !!el.closest(config.scope);
}

/** The nearest source element that holds text of its own. */
function textTarget(start: EventTarget | null): HTMLElement | null {
  for (
    let el = start instanceof Element ? start : null;
    el;
    el = el.parentElement
  ) {
    if (!(el instanceof HTMLElement) || !el.hasAttribute(ID)) continue;
    if (SKIP_TAGS.has(el.tagName) || !inScope(el)) return null;
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim(),
    );
    if (ownText) return el;
  }
  return null;
}

function imageTarget(start: EventTarget | null): HTMLImageElement | null {
  return start instanceof HTMLImageElement &&
    start.hasAttribute(ID) &&
    inScope(start)
    ? start
    : null;
}

function setHovered(el: Element | null) {
  if (hovered === el) return;
  hovered?.classList.remove(HOVER);
  hovered = el;
  hovered?.classList.add(HOVER);
}

function onHover(e: MouseEvent) {
  if (editing) return;
  setHovered(imageTarget(e.target) ?? textTarget(e.target));
}

function onClick(e: MouseEvent) {
  const target = e.target;
  if (target instanceof Element && target.closest(`[${UI}]`)) return;

  const img = imageTarget(target);
  const text = img ? null : textTarget(target);
  if (img || text || (target instanceof Element && target.closest("a"))) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (img) pickImage(img);
  else if (text) startEditing(text);
}

// ─── Text ────────────────────────────────────────────────────────────────────

function startEditing(el: HTMLElement) {
  if (el === editing) return;
  editing?.blur();
  setHovered(null);

  const before = el.innerHTML;
  let reverted = false;
  el.contentEditable = "plaintext-only";
  el.spellcheck = false;
  el.focus();
  // Hidden elements can't take focus, and without focus there is no blur to end the edit.
  if (document.activeElement !== el) {
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    return;
  }
  editing = el;
  const range = document.createRange();
  range.selectNodeContents(el);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);

  const stop = (e: Event) => e.stopPropagation();

  function onKey(e: KeyboardEvent) {
    // Keep the page's own shortcuts (slide navigation and the like) out of the way.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      reverted = true;
      el.innerHTML = before;
      el.blur();
    }
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    document.execCommand(
      "insertText",
      false,
      e.clipboardData?.getData("text/plain") ?? "",
    );
  }

  function onBlur() {
    el.removeEventListener("keydown", onKey);
    el.removeEventListener("keyup", stop);
    el.removeEventListener("keypress", stop);
    el.removeEventListener("paste", onPaste);
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    editing = null;
    if (!reverted && el.innerHTML !== before) {
      submit(
        { type: "text", id: Number(el.getAttribute(ID)), html: el.innerHTML },
        el,
      );
    }
  }

  el.addEventListener("keydown", onKey);
  el.addEventListener("keyup", stop);
  el.addEventListener("keypress", stop);
  el.addEventListener("paste", onPaste);
  el.addEventListener("blur", onBlur, { once: true });
}

// ─── Images ──────────────────────────────────────────────────────────────────

function pickImage(img: HTMLImageElement) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || !config) return;
    setStatus("saving", "Uploading");
    pending++;
    try {
      const res = await fetch(
        `${API}/upload?page=${encodeURIComponent(config.page)}`,
        {
          method: "POST",
          headers: { "X-Filename": encodeURIComponent(file.name) },
          body: file,
        },
      );
      if (!res.ok) throw new Error(await res.text());
      const { src } = (await res.json()) as { src: string };
      submit(
        {
          type: "attrs",
          id: Number(img.getAttribute(ID)),
          set: { src },
          remove: ["srcset"],
        },
        img,
      );
    } catch (err) {
      setStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      pending--;
    }
  });
  input.click();
}

// ─── Saving ──────────────────────────────────────────────────────────────────

function submit(op: Op, el: HTMLElement) {
  pending++;
  queue = queue.then(() => send(op, el)).finally(() => pending--);
}

async function send(op: Op, el: HTMLElement) {
  if (stale || !config) return;
  setStatus("saving");
  try {
    const res = await fetch(`${API}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: config.page, hash, op }),
    });
    const body = await res.text();
    if (res.status === 409) {
      stale = true;
      return setStatus("stale", body);
    }
    if (!res.ok) return setStatus("error", body);

    const result = JSON.parse(body) as {
      hash: string;
      oldCount: number;
      newCount: number;
    };
    hash = result.hash;
    if (op.type === "attrs") {
      op.remove.forEach((name) => el.removeAttribute(name));
      Object.entries(op.set).forEach(([name, value]) =>
        el.setAttribute(name, value),
      );
    } else if (!renumber(el, op.id, result.oldCount, result.newCount)) {
      stale = true;
      return setStatus(
        "stale",
        "The page is out of sync with the file. Reload it.",
      );
    }
    setStatus("saved");
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Ids are positions in the source, so an edit that adds or removes elements
 * (deleting a <strong>, say) shifts every id after it. Mirror that shift here
 * instead of reloading the page.
 */
function renumber(
  el: HTMLElement,
  id: number,
  oldCount: number,
  newCount: number,
): boolean {
  const inner = [...el.querySelectorAll(`[${ID}]`)];
  if (inner.length !== newCount) return false;
  const delta = newCount - oldCount;
  if (delta !== 0) {
    const innerSet = new Set(inner);
    document.querySelectorAll(`[${ID}]`).forEach((node) => {
      const value = Number(node.getAttribute(ID));
      if (!innerSet.has(node) && value > id + oldCount)
        node.setAttribute(ID, String(value + delta));
    });
  }
  inner.forEach((node, i) => node.setAttribute(ID, String(id + 1 + i)));
  return true;
}

// ─── UI ──────────────────────────────────────────────────────────────────────

function injectPageStyles() {
  const style = document.createElement("style");
  style.setAttribute(UI, "");
  style.textContent = `
    :root { --le-accent: #3b82f6; }
    .${ON} .${HOVER} {
      outline: 1.5px dashed var(--le-accent) !important;
      outline-offset: 3px !important;
      cursor: text !important;
    }
    .${ON} img.${HOVER} { cursor: copy !important; }
    .${ON} [${ID}][contenteditable] {
      outline: 2px solid var(--le-accent) !important;
      outline-offset: 3px !important;
      cursor: text !important;
    }
  `;
  document.head.appendChild(style);
}

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready",
  saving: "Saving",
  saved: "Saved",
  error: "Not saved",
  stale: "Reload needed",
};

class Toolbar {
  private toggle: HTMLButtonElement;
  private status: HTMLElement;

  constructor(onToggle: () => void) {
    const host = document.createElement("live-edit-bar");
    host.setAttribute(UI, "");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          --bg: rgb(24 24 27 / 0.92);
          --border: rgb(255 255 255 / 0.1);
          --fg: #f4f4f5;
          --muted: #a1a1aa;
          --hover: rgb(255 255 255 / 0.08);
          --accent: #3b82f6;
          --ok: #4ade80;
          --warn: #fbbf24;
          --bad: #f87171;
          position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
          font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .bar {
          display: flex; align-items: center; gap: 4px;
          padding: 4px; border-radius: 999px;
          background: var(--bg); border: 1px solid var(--border);
          backdrop-filter: blur(12px);
          box-shadow: 0 8px 24px rgb(0 0 0 / 0.25), 0 1px 2px rgb(0 0 0 / 0.2);
          color: var(--fg); user-select: none;
        }
        button {
          all: unset; cursor: pointer;
          display: inline-flex; align-items: center; gap: 8px;
          height: 28px; padding: 0 12px; border-radius: 999px;
          transition: background-color 120ms ease, color 120ms ease;
        }
        button:hover { background: var(--hover); }
        button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        button[aria-pressed="true"] { background: var(--accent); color: #fff; }
        kbd { font: inherit; color: var(--muted); }
        button[aria-pressed="true"] kbd { color: rgb(255 255 255 / 0.75); }
        .status {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 0 12px 0 8px; color: var(--muted); max-width: 320px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .status::before {
          content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%;
          background: var(--muted);
        }
        .status[data-state="saved"]::before { background: var(--ok); }
        .status[data-state="saving"]::before { background: var(--accent); animation: pulse 900ms ease-in-out infinite; }
        .status[data-state="error"]::before { background: var(--bad); }
        .status[data-state="stale"]::before { background: var(--warn); }
        .status[data-state="error"], .status[data-state="stale"] { color: var(--fg); }
        @keyframes pulse { 50% { opacity: 0.3; } }
        @media (prefers-reduced-motion: reduce) { .status::before { animation: none !important; } }
      </style>
      <div class="bar">
        <button type="button" aria-pressed="false">Edit <kbd>⌥E</kbd></button>
        <span class="status" role="status" data-state="idle">Ready</span>
      </div>
    `;
    this.toggle = shadow.querySelector("button")!;
    this.status = shadow.querySelector(".status")!;
    this.toggle.addEventListener("click", onToggle);
    document.body.appendChild(host);
  }

  setMode(on: boolean) {
    this.toggle.setAttribute("aria-pressed", String(on));
  }

  setStatus(state: Status, detail = "") {
    this.status.dataset.state = state;
    this.status.textContent =
      state === "saving" && detail ? detail : STATUS_LABEL[state];
    this.status.title = detail;
  }
}

// Last, so the Toolbar class and constants above are initialized.
if (config) boot();

export {};
