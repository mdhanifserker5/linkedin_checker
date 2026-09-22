"use strict";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  results: [],
  sortCol: null,
  sortRev: false,
  running: false,
  stop: false,
  total: 0,
  cookies: [],
};

class AuthError extends Error {}

/* Saved in this browser (localStorage) so the next visit starts where you left off. */
const store = {
  get(key, fallback = "") {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* storage full or blocked */ }
  },
};
const SAVED_KEYS = ["lc_pw", "lc_cookie_inputs", "lc_urls", "lc_delay", "lc_retries", "lc_results"];

let saveTimer = null;
function saveResultsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveResultsNow, 400);
}
function saveResultsNow() {
  clearTimeout(saveTimer);
  store.set("lc_results", JSON.stringify(state.results));
}

/* ---------------------------------------------------------------- api */

async function api(payload, signal) {
  const res = await fetch("/api/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Password": store.get("lc_pw"),
    },
    body: JSON.stringify(payload),
    signal,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
  return { status: res.status, data };
}

function errorResult(url, note) {
  return { original_url: url, final_url: "", status: "ERROR", note, http_status: 0 };
}

/* One URL, with retries on network/server trouble (not on LinkedIn answers). */
async function checkOne(url, retries) {
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (state.stop) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const { status, data } = await api({ action: "check", url, cookies: state.cookies }, ctrl.signal);
      clearTimeout(timer);
      if (status === 401) throw new AuthError();
      if (status === 400) return errorResult(url, (data && data.error) || "Bad request");
      if (status === 200 && data) {
        const isNetwork = data.status === "ERROR" && String(data.note).startsWith("Network error");
        if (!isNetwork) return data;
        last = data.note;
      } else {
        last = (data && data.error) || `Server error ${status}`;
      }
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof AuthError) throw e;
      last = e.name === "AbortError" ? "Request timed out" : `Network error: ${e.message}`;
    }
    if (attempt < retries) await sleep(2000 * (attempt + 1));
  }
  return errorResult(url, `${last} (retried ${retries}x)`);
}

/* ---------------------------------------------------------------- password */

const pwDlg = $("pwDlg");
pwDlg.addEventListener("cancel", (e) => e.preventDefault()); // cannot dismiss with Esc

function askPassword(message) {
  $("pwMsg").textContent = message || "";
  $("pwInput").value = "";
  if (!pwDlg.open) pwDlg.showModal();
  $("pwInput").focus();
}

$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  store.set("lc_pw", $("pwInput").value);
  $("pwMsg").textContent = "Checking...";
  try {
    const { status, data } = await api({ action: "ping" });
    if (status === 200) { pwDlg.close(); return; }
    $("pwMsg").textContent = (data && data.error) || `Server error ${status}`;
  } catch (err) {
    $("pwMsg").textContent = "Could not reach the server: " + err.message;
  }
});

async function initAuth() {
  if (!store.get("lc_pw")) return askPassword();
  try {
    const { status } = await api({ action: "ping" });
    if (status !== 200) askPassword();
  } catch (_) { askPassword("Could not reach the server."); }
}

/* ---------------------------------------------------------------- cookies */

const cookieDlg = $("cookieDlg");

function loadCookieInputs() {
  try { return JSON.parse(store.get("lc_cookie_inputs", "{}")); } catch (_) { return {}; }
}

function readCookieForm() {
  return { liAt: $("liAt").value, raw: $("rawCookie").value, json: $("jsonCookie").value };
}

function setCookieMsg(text, cls) {
  const el = $("cookieMsg");
  el.textContent = text;
  el.className = "msg " + (cls || "");
}

function refreshCookieBadge() {
  const n = state.cookies.length;
  $("cookieDot").classList.toggle("on", n > 0);
  $("cookieLabel").textContent = n ? `Cookie: set (${n})` : "Cookie: not set";
}

$("cookieBtn").addEventListener("click", () => {
  const saved = loadCookieInputs();
  $("liAt").value = saved.liAt || "";
  $("rawCookie").value = saved.raw || "";
  $("jsonCookie").value = saved.json || "";
  setCookieMsg("");
  cookieDlg.showModal();
});
$("cancelCookieBtn").addEventListener("click", () => cookieDlg.close());

$("testCookieBtn").addEventListener("click", async () => {
  const parsed = LC.parseCookies(readCookieForm());
  if (parsed.error) return setCookieMsg(parsed.error, "bad");
  if (!parsed.cookies.length) return setCookieMsg("No cookie entered, nothing to test.", "bad");
  setCookieMsg("Testing cookie...");
  try {
    const { status, data } = await api({ action: "test", cookies: parsed.cookies });
    if (status === 401) { cookieDlg.close(); return askPassword("Password is no longer valid."); }
    if (status !== 200 || !data) return setCookieMsg((data && data.error) || `Server error ${status}`, "bad");
    setCookieMsg(data.message, data.ok ? "ok" : "bad");
  } catch (e) {
    setCookieMsg("Could not reach the server: " + e.message, "bad");
  }
});

$("saveCookieBtn").addEventListener("click", () => {
  const inputs = readCookieForm();
  const parsed = LC.parseCookies(inputs);
  if (parsed.error) return setCookieMsg(parsed.error, "bad");
  if (!parsed.cookies.length) return setCookieMsg("Fill in option 1, 2 or 3 first.", "bad");
  state.cookies = parsed.cookies;
  store.set("lc_cookie_inputs", JSON.stringify(inputs));
  refreshCookieBadge();
  cookieDlg.close();
});

/* ---------------------------------------------------------------- input */

function urlList() { return LC.parseUrlList($("urls").value); }
function updateUrlCount() { $("urlCount").textContent = `${urlList().length} URLs`; store.set("lc_urls", $("urls").value); }
$("urls").addEventListener("input", updateUrlCount);
$("delay").addEventListener("input", () => store.set("lc_delay", $("delay").value));
$("retries").addEventListener("input", () => store.set("lc_retries", $("retries").value));

$("loadBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("urls").value = await file.text();
  e.target.value = "";
  updateUrlCount();
});

/* ---------------------------------------------------------------- run */

function setRunning(on) {
  state.running = on;
  $("startBtn").disabled = on;
  $("stopBtn").disabled = !on;
}

function setProgress(text) { $("progressText").textContent = text; }

$("startBtn").addEventListener("click", async () => {
  const urls = urlList();
  if (!urls.length) return setProgress("Add some URLs first.");

  if (!state.cookies.length) {
    if (!confirm("No cookie is set. Checking without a LinkedIn login often gives wrong results.\n\nContinue without a cookie?")) return;
  } else if (state.cookies.length <= 2) {
    if (!confirm(`Only ${state.cookies.length} cookie(s) set. With so few, LinkedIn often does not render the full page and live profiles can look dead.\n\nFor best results paste the full Cookie-Editor JSON export (option 3).\n\nContinue anyway?`)) return;
  }

  clearResults();
  state.stop = false;
  state.total = urls.length;
  setRunning(true);

  const delay = Math.max(0, parseFloat($("delay").value) || 0);
  const retries = Math.min(5, Math.max(0, parseInt($("retries").value, 10) || 0));

  try {
    for (let i = 0; i < urls.length; i++) {
      if (state.stop) break;
      setProgress(`Checking ${i + 1} of ${urls.length}...`);
      const r = await checkOne(urls[i], retries);
      r.checked_at = new Date().toLocaleTimeString([], { hour12: false });
      state.results.push(r);
      saveResultsSoon();
      scheduleRender();
      if (i < urls.length - 1 && !state.stop && delay > 0) await sleep(delay * 1000);
    }
    setProgress(state.stop ? "Stopped." : `Done. ${urls.length} URLs checked.`);
  } catch (e) {
    if (e instanceof AuthError) {
      setProgress("Stopped: password rejected.");
      askPassword("Password was rejected. Enter it again.");
    } else {
      setProgress("Stopped: " + e.message);
    }
  } finally {
    setRunning(false);
    saveResultsNow();
    render();
  }
});

$("stopBtn").addEventListener("click", () => { state.stop = true; $("stopBtn").disabled = true; setProgress("Stopping after the current URL..."); });

function clearResults() {
  state.results = [];
  state.total = 0;
  saveResultsNow();
  render();
}
$("clearBtn").addEventListener("click", () => { if (!state.running) { clearResults(); setProgress("Ready."); } });

/* ---------------------------------------------------------------- table */

const STATUS_CLASS = { LIVE: "live", DEAD: "dead", ERROR: "err" };
const STATUS_LABEL = { LIVE: "Live", DEAD: "Dead", ERROR: "Error" };
const STATUS_ORDER = ["LIVE", "DEAD", "ERROR"];

function visibleRows() {
  const filter = $("filter").value;
  const needle = $("search").value.trim().toLowerCase();
  let rows = state.results;
  if (filter !== "All") rows = rows.filter((r) => r.status === filter);
  if (needle) rows = rows.filter((r) => r.original_url.toLowerCase().includes(needle) || (r.final_url || "").toLowerCase().includes(needle));
  if (state.sortCol) {
    const c = state.sortCol;
    rows = [...rows].sort((a, b) => String(a[c] ?? "").localeCompare(String(b[c] ?? "")) * (state.sortRev ? -1 : 1));
  }
  return rows;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function cell(tag, text, cls) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function render() {
  const rows = visibleRows();
  const tbody = $("tbody");
  tbody.replaceChildren();

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "row-" + STATUS_CLASS[r.status];
    tr.append(cell("td", r.original_url, "url"), cell("td", r.final_url || "", "url"));

    const statusTd = document.createElement("td");
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "badge " + STATUS_CLASS[r.status];
    badge.textContent = STATUS_LABEL[r.status];
    badge.title = "Click to change status";
    badge.addEventListener("click", () => {
      const next = STATUS_ORDER[(STATUS_ORDER.indexOf(r.status) + 1) % STATUS_ORDER.length];
      r.status = next;
      r.note = `Manually set by user: ${STATUS_LABEL[next]}`;
      saveResultsNow();
      render();
    });
    statusTd.append(badge);
    tr.append(statusTd, cell("td", r.note || "", "note"), cell("td", r.checked_at || "", "time"));
    tbody.append(tr);
  }

  $("empty").hidden = rows.length > 0;
  if (!rows.length && state.results.length) $("empty").textContent = "No rows match this filter or search.";
  else if (!rows.length) $("empty").textContent = "No results yet. Paste URLs and press Start test.";

  const count = (s) => state.results.filter((r) => r.status === s).length;
  const live = count("LIVE"), dead = count("DEAD"), err = count("ERROR");
  $("cTotal").textContent = state.results.length;
  $("cLive").textContent = live;
  $("cDead").textContent = dead;
  $("cErr").textContent = err;
  const denom = Math.max(state.total, state.results.length, 1);
  $("bLive").style.width = (live / denom) * 100 + "%";
  $("bDead").style.width = (dead / denom) * 100 + "%";
  $("bErr").style.width = (err / denom) * 100 + "%";

  document.querySelectorAll("#headRow th").forEach((th) => {
    const active = th.dataset.col === state.sortCol;
    th.setAttribute("aria-sort", active ? (state.sortRev ? "descending" : "ascending") : "none");
  });
}

document.querySelectorAll("#headRow th").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (state.sortCol === col) state.sortRev = !state.sortRev;
    else { state.sortCol = col; state.sortRev = false; }
    render();
  });
});
$("filter").addEventListener("change", render);
$("search").addEventListener("input", render);

/* ---------------------------------------------------------------- export */

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("csvBtn").addEventListener("click", () => {
  if (!state.results.length) return setProgress("Nothing to export yet. Run a test first.");
  const rows = visibleRows();
  if (!rows.length) return setProgress("No rows match this filter or search.");
  download("linkedin-url-check.csv", LC.toCsv(rows), "text/csv;charset=utf-8");
  setProgress(`Exported ${rows.length} of ${state.results.length} rows.`);
});

/* Apps Script generator (works on the rows currently visible) */
const scriptDlg = $("scriptDlg");
$("scriptBtn").addEventListener("click", () => {
  if (!state.results.length) return setProgress("Nothing to generate yet. Run a test first.");
  const rows = visibleRows();
  if (!rows.length) return setProgress("No rows match this filter or search.");
  const filter = $("filter").value;
  let source = filter !== "All" ? STATUS_LABEL[filter] : "all results";
  const needle = $("search").value.trim();
  if (needle) source += `, search "${needle}"`;
  $("scriptTitle").textContent = `Apps Script for ${rows.length} URLs (${source})`;
  $("scriptOut").value = LC.generateAppsScript(rows.map((r) => r.original_url));
  $("scriptMsg").textContent = "";
  scriptDlg.showModal();
});
$("closeScriptBtn").addEventListener("click", () => scriptDlg.close());
$("copyScriptBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("scriptOut").value);
    $("scriptMsg").textContent = "Copied to clipboard.";
  } catch (_) {
    $("scriptOut").select();
    $("scriptMsg").textContent = "Copy blocked by the browser. The text is selected, press Ctrl+C.";
  }
});
$("saveScriptBtn").addEventListener("click", () => {
  download("autoMatchCutPaste.js", $("scriptOut").value, "text/javascript;charset=utf-8");
  $("scriptMsg").textContent = "Saved autoMatchCutPaste.js.";
});

/* ---------------------------------------------------------------- forget */

$("forgetBtn").addEventListener("click", () => {
  if (!confirm("Remove the saved password, cookie, URLs and results from this browser?")) return;
  try { SAVED_KEYS.forEach((k) => localStorage.removeItem(k)); } catch (_) { /* ignore */ }
  location.reload();
});

/* ---------------------------------------------------------------- init */

(function init() {
  $("urls").value = store.get("lc_urls");
  const d = store.get("lc_delay"); if (d !== "") $("delay").value = d;
  const rt = store.get("lc_retries"); if (rt !== "") $("retries").value = rt;
  try {
    const prev = JSON.parse(store.get("lc_results", "[]"));
    if (Array.isArray(prev)) {
      state.results = prev.filter((r) => r && typeof r.original_url === "string" && STATUS_ORDER.includes(r.status));
      state.total = state.results.length;
    }
  } catch (_) { /* ignore corrupt data */ }

  const saved = loadCookieInputs();
  if (saved.liAt || saved.raw || saved.json) {
    const parsed = LC.parseCookies(saved);
    if (parsed.cookies) state.cookies = parsed.cookies;
  }
  refreshCookieBadge();
  updateUrlCount();
  render();
  initAuth();
})();
