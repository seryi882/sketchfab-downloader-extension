/**
 * Lightweight developer log for a single download session.
 * Not persisted long-term — only kept in memory (+ optional last-run in storage
 * when dev mode is on, overwritten each run).
 */

const MAX_LINES = 400;
let session = [];
let devModeCache = null;

export async function isDevMode() {
  if (devModeCache !== null) return devModeCache;
  try {
    const { sf_dev_mode } = await chrome.storage.local.get("sf_dev_mode");
    devModeCache = !!sf_dev_mode;
  } catch (_) {
    devModeCache = false;
  }
  return devModeCache;
}

export async function setDevMode(on) {
  devModeCache = !!on;
  try {
    await chrome.storage.local.set({ sf_dev_mode: devModeCache });
  } catch (_) {}
  return devModeCache;
}

/** Call when storage changes from another page */
export function setDevModeCache(on) {
  devModeCache = !!on;
}

export function clearSessionLog() {
  session = [];
}

export function getSessionLog() {
  return session.slice();
}

export function formatSessionLog() {
  return session
    .map((e) => {
      const ts = new Date(e.t).toISOString().slice(11, 23);
      const extra =
        e.data !== undefined
          ? " " +
            (typeof e.data === "string" ? e.data : safeJson(e.data))
          : "";
      return `${ts} [${e.level}] ${e.msg}${extra}`;
    })
    .join("\n");
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} msg
 * @param {any} [data]
 */
export function devLog(level, msg, data) {
  const entry = {
    t: Date.now(),
    level: level || "info",
    msg: String(msg || ""),
    data,
  };
  session.push(entry);
  if (session.length > MAX_LINES) session = session.slice(-MAX_LINES);

  const line = `[sf-dl] ${entry.msg}`;
  if (level === "error") console.error(line, data !== undefined ? data : "");
  else if (level === "warn") console.warn(line, data !== undefined ? data : "");
  else console.log(line, data !== undefined ? data : "");

  return entry;
}

export async function persistLastRunLog() {
  if (!(await isDevMode())) return;
  try {
    await chrome.storage.session?.set?.({
      sf_last_log: formatSessionLog(),
      sf_last_log_at: Date.now(),
    });
  } catch (_) {
    // session storage may be unavailable — ignore
  }
  try {
    // tiny last-run snapshot for popup reopen (overwrite only)
    await chrome.storage.local.set({
      sf_last_log: formatSessionLog().slice(0, 120000),
      sf_last_log_at: Date.now(),
    });
  } catch (_) {}
}

export async function readLastRunLog() {
  try {
    const s = await chrome.storage.local.get(["sf_last_log", "sf_last_log_at"]);
    return { text: s.sf_last_log || "", at: s.sf_last_log_at || 0 };
  } catch (_) {
    return { text: "", at: 0 };
  }
}
