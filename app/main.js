import {
  CATEGORY_ORDER,
  DEFAULT_FILTERS,
  REST_DURATION,
  SNACK_DURATION,
  createEmptyExercise,
  describeFilters,
  ensureHistoryEntry,
  filterExercises,
  findHistoryEntry,
  formatDayTitle,
  formatLongDate,
  formatMetaText,
  formatMonthDay,
  formatShortDate,
  formatSizeLabel,
  formatTime,
  formatTimerSeconds,
  getLoad,
  groupByStack,
  hydrateExercise,
  hydrateSnack,
  pickStack,
  resolveSnacks,
  sortHistoryDescending,
  summarizeEntries,
  todayKey,
} from "./model.js";
import { hydrateSnapshot, loadAppState, loadSettings, saveAppState } from "./storage.js";
import { SnaxSync, buildDeviceLink, createLinkRoom, fetchLinkState, nextClock, normalizeCode, observeClock } from "./sync.js";

const loadedState = loadAppState();
const state = {
  settings: loadSettings(),
  filters: { ...DEFAULT_FILTERS },
  settingsFilters: {
    category: "any",
    intensity: "any",
    query: "",
  },
  stack: [],
  runIdx: 0,
  secondsLeft: SNACK_DURATION,
  snackEndTime: 0,
  restEndTime: 0,
  pauseStartTime: 0,
  paused: false,
  timerHandle: null,
  restHandle: null,
  completed: [],
  currentStackId: "",
  history: loadedState.history,
  library: loadedState.library,
  deviceId: loadedState.deviceId,
  clock: loadedState.clock,
  sync: loadedState.sync,
  syncStatus: loadedState.sync.code ? "synced" : "local",
  linkPanelOpen: false,
  linkBusy: false,
  linkError: "",
  linkCodeInput: "",
  editingIndex: null,
  currentView: "home",
  collapsedMonths: new Set(),
  pendingImport: null,
  importModes: {
    history: "merge",
    library: "merge",
  },
};

const $ = (id) => document.getElementById(id);
const CATEGORY_COLOR_CLASSES = CATEGORY_ORDER.map((category) => `cat-${category}`);
const EXPORT_SCHEMA = "snax.history.v1";
const TIMER_WAKE_LOCK_TYPE = "screen";

let toastTimer;
let syncClient = null;
let timerWakeLock = null;
let timerWakeLockRequest = null;
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {}
  }
}

function beep(frequency, duration, startOffset = 0) {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime + startOffset;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = frequency;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  } catch (_) {}
}

try {
  screen.orientation.lock("portrait-primary").catch(() => {});
} catch (_) {}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function save(markChange = true) {
  if (markChange) {
    const next = nextClock(state.clock, state.deviceId);
    state.clock = next.clock;
    state.sync.stateVersion = next.version;
  }

  saveAppState({
    history: state.history,
    library: state.library,
    deviceId: state.deviceId,
    clock: state.clock,
    sync: state.sync,
  });

  renderLinkPanel();
  syncClient?.flush();
}

function persistRemoteState() {
  saveAppState({
    history: state.history,
    library: state.library,
    deviceId: state.deviceId,
    clock: state.clock,
    sync: state.sync,
  });

  renderLinkPanel();
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove("visible");
  }, 1800);
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  $(`view-${name}`).classList.add("active");
  state.currentView = name;
  syncTimerWakeLock();
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

function isTimerViewActive() {
  return state.currentView === "run" || state.currentView === "rest";
}

function syncTimerWakeLock() {
  if (!isTimerViewActive() || document.visibilityState === "hidden") {
    releaseTimerWakeLock();
    return;
  }

  acquireTimerWakeLock();
}

function acquireTimerWakeLock() {
  if (!("wakeLock" in navigator) || !window.isSecureContext) {
    return;
  }

  if (
    !isTimerViewActive() ||
    document.visibilityState === "hidden" ||
    (timerWakeLock && !timerWakeLock.released) ||
    timerWakeLockRequest
  ) {
    return;
  }

  timerWakeLockRequest = navigator.wakeLock
    .request(TIMER_WAKE_LOCK_TYPE)
    .then((wakeLock) => {
      if (!isTimerViewActive() || document.visibilityState === "hidden") {
        wakeLock.release().catch(() => {});
        return;
      }

      timerWakeLock = wakeLock;
      timerWakeLock.addEventListener("release", handleTimerWakeLockRelease, { once: true });
    })
    .catch(() => {})
    .finally(() => {
      timerWakeLockRequest = null;
    });
}

function releaseTimerWakeLock() {
  const wakeLock = timerWakeLock;
  timerWakeLock = null;

  if (!wakeLock || wakeLock.released) {
    return;
  }

  wakeLock.release().catch(() => {});
}

function handleTimerWakeLockRelease() {
  timerWakeLock = null;

  if (isTimerViewActive() && document.visibilityState === "visible") {
    acquireTimerWakeLock();
  }
}

function handleVisibilityChange() {
  syncTimerWakeLock();
}

function todayEntry() {
  return ensureHistoryEntry(state.history, todayKey());
}

function resolveEntrySnacks(entry) {
  return entry ? resolveSnacks(entry.snacks, state.library) : [];
}

function renderSparkBars(snacks, variant, emptyLabel) {
  if (snacks.length === 0) {
    return `<span class="spark-empty">${esc(emptyLabel)}</span>`;
  }

  const unit = variant === "archive" ? 7 : variant === "day" ? 12 : 10;
  return snacks
    .map(
      (snack, index) =>
        `<span class="spark-bar spark-bar-${variant} cat-${esc(snack.category)}" style="height: ${8 + snack.intensity * unit}px; animation-delay: ${index * 0.04}s"></span>`,
    )
    .join("");
}

function renderIntensityPips(intensity, category) {
  let html = `<span class="int-pips cat-${esc(category)}">`;
  for (let value = 1; value <= 3; value += 1) {
    html += `<span class="pip ${value <= intensity ? "on" : ""}"></span>`;
  }
  html += "</span>";
  return html;
}

function renderHome() {
  renderDate();
  renderLinkPanel();
  renderToday();
  renderArchive();
}

function renderLinkPanel() {
  const panel = $("link-panel");
  const toggle = $("link-btn");
  const linkUrl = state.sync.code ? buildDeviceLink(window.location.href, state.sync.code) : "";
  const linkCode = state.sync.code || "";

  panel.hidden = !state.linkPanelOpen;
  toggle?.setAttribute("aria-expanded", String(state.linkPanelOpen));

  if (!state.linkPanelOpen) {
    return;
  }

  $("link-helper").textContent = linkHelperText(linkUrl);
  $("link-code-box").textContent = state.linkBusy && !linkCode ? "preparing..." : linkCode || "not ready yet";
  $("link-url-box").textContent = state.linkBusy ? "preparing link..." : linkUrl || "not ready yet";
  $("link-code-input").value = state.linkCodeInput;
  $("link-code-input").disabled = state.linkBusy;
  $("link-connect-btn").disabled = state.linkBusy || !extractLinkCode(state.linkCodeInput);
  $("copy-link-btn").hidden = !linkUrl;
  $("copy-link-btn").disabled = state.linkBusy || !linkUrl;
}

function linkHelperText(linkUrl) {
  if (state.linkError) {
    return state.linkError;
  }

  if (!state.settings.syncBaseUrl) {
    return "linking is not available here yet";
  }

  if (state.linkBusy) {
    return "preparing a link for another device";
  }

  if (linkUrl) {
    return "copy this URL or type this code on another device";
  }

  return "enter a code from another device below to sync";
}

function closeLinkPanel() {
  state.linkPanelOpen = false;
  renderLinkPanel();
}

function renderDate() {
  $("home-date").textContent = formatLongDate(todayKey());
}

function renderToday() {
  const entry = findHistoryEntry(state.history, todayKey());
  const snacks = resolveEntrySnacks(entry);
  const panel = $("today-panel");
  $("today-meta").textContent = formatMetaText(snacks);
  $("today-spark").innerHTML = renderSparkBars(snacks, "today", "quiet so far");
  panel.classList.toggle("clickable", snacks.length > 0);
}

function monthKeyForDate(dateKey) {
  return String(dateKey || "").slice(0, 7);
}

function formatMonthTitle(monthKey) {
  const [year, month] = String(monthKey).split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1, 12, 0, 0, 0));
}

function groupEntriesByMonth(entries) {
  const groups = [];
  const groupsByKey = new Map();

  entries.forEach((entry) => {
    const monthKey = monthKeyForDate(entry.dateKey);
    if (!monthKey) {
      return;
    }

    let group = groupsByKey.get(monthKey);
    if (!group) {
      group = { monthKey, entries: [] };
      groupsByKey.set(monthKey, group);
      groups.push(group);
    }

    group.entries.push(entry);
  });

  return groups;
}

function renderArchive() {
  const entries = state.history.map((entry) => ({
    dateKey: entry.dateKey,
    snacks: resolveEntrySnacks(entry),
  }));
  const archiveSection = $("archive-section");

  archiveSection.hidden = entries.length === 0;
  if (entries.length === 0) {
    $("archive-list").innerHTML = "";
    $("archive-stats").textContent = "";
    return;
  }

  const stats = summarizeEntries(entries);

  $("archive-stats").textContent = `${entries.length} days / ${stats.count} snacks / load ${stats.load}`;
  $("archive-list").innerHTML = groupEntriesByMonth(entries)
    .map((group) => {
      const monthStats = summarizeEntries(group.entries);
      const isCollapsed = state.collapsedMonths.has(group.monthKey);
      return `
        <section class="archive-month">
          <button class="archive-month-toggle" type="button" data-month="${esc(group.monthKey)}" aria-expanded="${esc(String(!isCollapsed))}">
            <span class="archive-month-title">${esc(formatMonthTitle(group.monthKey))}</span>
            <span class="archive-month-meta">${group.entries.length} days / ${monthStats.count} snacks / load ${monthStats.load}</span>
          </button>
          <div class="archive-month-days" ${isCollapsed ? "hidden" : ""}>
            ${group.entries
              .map((entry) => {
                const hasSnacks = entry.snacks.length > 0;
                return `
                  <div class="archive-row ${hasSnacks ? "has-snacks" : ""}" ${hasSnacks ? `data-date="${esc(entry.dateKey)}"` : ""}>
                    <span class="archive-date">${esc(formatShortDate(entry.dateKey))}</span>
                    <div class="archive-spark">${renderSparkBars(entry.snacks, "archive", "quiet")}</div>
                  </div>
                `;
              })
              .join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function toggleArchiveMonth(monthKey) {
  if (state.collapsedMonths.has(monthKey)) {
    state.collapsedMonths.delete(monthKey);
  } else {
    state.collapsedMonths.add(monthKey);
  }

  renderArchive();
}

function currentSnapshot() {
  return {
    history: state.history,
    library: state.library,
  };
}

function ensureLocalVersion() {
  if (state.sync.stateVersion) {
    return;
  }

  const next = nextClock(state.clock, state.deviceId);
  state.clock = next.clock;
  state.sync.stateVersion = next.version;
}

function refreshVisibleViews() {
  renderLinkPanel();
  renderHome();

  if ($("view-settings").classList.contains("active")) {
    renderSettings();
    renderSettingsEditor();
  }

  if ($("view-day").classList.contains("active")) {
    goHome();
  }
}

function applyRemoteSnapshot(snapshot, version) {
  const hydrated = hydrateSnapshot(snapshot);
  state.history = hydrated.history;
  state.library = hydrated.library;
  state.editingIndex = null;
  state.clock = observeClock(state.clock, version);
  state.sync.stateVersion = version || state.sync.stateVersion;
  persistRemoteState();
  refreshVisibleViews();
}

function ensureSyncClient() {
  if (syncClient) {
    return syncClient;
  }

  syncClient = new SnaxSync({
    settings: state.settings,
    deviceId: state.deviceId,
    code: state.sync.code,
    getVersion: () => state.sync.stateVersion,
    getSnapshot: currentSnapshot,
    applyRemote: (snapshot, version) => {
      applyRemoteSnapshot(snapshot, version);
    },
    onStatus: (status) => {
      state.syncStatus = status;
      renderLinkPanel();
    },
    onError: (message) => {
      state.linkError = message;
      renderLinkPanel();
    },
  });

  return syncClient;
}

function startSync() {
  ensureLocalVersion();
  ensureSyncClient().start(state.sync.code);
}

function shakeJar() {
  const pool = filterExercises(state.library, state.filters);
  if (pool.length === 0) {
    toast("no snacks match those filters");
    return;
  }

  state.stack = pickStack(pool, state.filters.size);
  renderPreview();
  showView("preview");
}

function renderPreview() {
  $("preview-title").textContent = formatStackLabel(state.stack.length);
  $("preview-sub").textContent = describeFilters(state.filters);
  $("preview-list").innerHTML = state.stack
    .map(
      (exercise, index) => `
        <article class="preview-item">
          <span class="idx">${String(index + 1).padStart(2, "0")}</span>
          <div class="body">
            <div class="preview-name-row">
              <span class="day-bar cat-${esc(exercise.category)}" data-intensity="${exercise.intensity}"></span>
              <p class="name">${esc(exercise.name)}</p>
            </div>
            <div class="meta">
              <span class="cue">${esc(exercise.tagline)}</span>
            </div>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderSettingsFilterChips() {
  document.querySelectorAll(".settings-chip").forEach((chip) => {
    const group = chip.dataset.settingsGroup;
    const rawValue = chip.dataset.val;
    if (!group || !rawValue) {
      return;
    }

    const isActive = state.settingsFilters[group] === rawValue;
    chip.classList.toggle("active", isActive);
    chip.classList.remove(...CATEGORY_COLOR_CLASSES);

    if (isActive && group === "category" && rawValue !== "any") {
      chip.classList.add(`cat-${rawValue}`);
    }
  });
}

function renderSettings() {
  renderSettingsFilterChips();
  const visibleSnacks = getVisibleLibrarySnacks();
  const visibleEnabledCount = visibleSnacks.filter(({ exercise }) => exercise.enabled !== false).length;
  const hasActiveFilters =
    state.settingsFilters.category !== "any" ||
    state.settingsFilters.intensity !== "any" ||
    state.settingsFilters.query.trim().length > 0;

  $("settings-search-input").value = state.settingsFilters.query;
  const totalActive = state.library.filter((exercise) => !exercise.deleted).length;
  $("settings-count").textContent = formatSettingsCount(visibleSnacks.length, totalActive, hasActiveFilters);
  $("settings-visible-toggle").checked = visibleSnacks.length > 0 && visibleEnabledCount === visibleSnacks.length;
  $("settings-visible-toggle").indeterminate =
    visibleEnabledCount > 0 && visibleEnabledCount < visibleSnacks.length;
  $("settings-visible-toggle").disabled = visibleSnacks.length === 0;

  $("settings-list").innerHTML =
    visibleSnacks.length === 0
      ? `<p class="settings-empty">no snacks match those filters</p>`
      : visibleSnacks
          .map(
            ({ exercise, index }) => `
              <article class="settings-card ${exercise.enabled === false ? "is-disabled" : ""}">
                <button class="settings-card-button" data-action="edit-snack" data-index="${index}" type="button">
                  <div class="settings-snack-row">
                    <span class="day-bar cat-${esc(exercise.category)}" data-intensity="${exercise.intensity}"></span>
                    <div class="settings-card-copy">
                      <p class="name">${esc(exercise.name || "untitled snack")}</p>
                      <div class="meta">
                        <span class="cue">${esc(exercise.tagline || "add a tagline")}</span>
                      </div>
                    </div>
                  </div>
                </button>
                <button
                  class="settings-go-btn"
                  data-action="run-single-snack"
                  data-index="${index}"
                  type="button"
                >go</button>
                <label class="settings-enabled-toggle">
                  <input
                    data-action="toggle-snack-enabled"
                    data-index="${index}"
                    type="checkbox"
                    ${exercise.enabled === false ? "" : "checked"}
                  />
                </label>
              </article>
            `,
          )
          .join("");
}

function getVisibleLibrarySnacks() {
  const query = state.settingsFilters.query.trim().toLowerCase();

  return state.library.map((exercise, index) => ({ exercise, index })).filter(({ exercise }) => {
    if (exercise.deleted) return false;
    const matchesCategory =
      state.settingsFilters.category === "any" || exercise.category === state.settingsFilters.category;
    const matchesIntensity =
      state.settingsFilters.intensity === "any" || exercise.intensity === Number(state.settingsFilters.intensity);
    const matchesQuery = !query || exercise.name.toLowerCase().includes(query);
    return matchesCategory && matchesIntensity && matchesQuery;
  });
}

function formatSettingsCount(visibleCount, totalCount, isFiltered) {
  const snackWord = totalCount === 1 ? "snack" : "snacks";
  if (!isFiltered) {
    return `${totalCount} ${snackWord}`;
  }

  return `${visibleCount} of ${totalCount} ${snackWord}`;
}

function renderSettingsEditor() {
  const overlay = $("settings-overlay");
  const exercise = state.editingIndex == null ? null : state.library[state.editingIndex];

  overlay.hidden = !exercise;
  document.body.classList.toggle("settings-overlay-open", Boolean(exercise));

  if (!exercise) {
    return;
  }

  $("settings-name-input").value = exercise.name;
  $("settings-tagline-input").value = exercise.tagline;
  $("settings-category-select").value = exercise.category;
  $("settings-intensity-select").value = String(exercise.intensity);
  $("settings-dialog-name").textContent = exercise.name || "untitled snack";
  $("settings-dialog-tagline").textContent = exercise.tagline || "add a tagline";
  $("settings-edit-bar").className = `day-bar cat-${exercise.category}`;
  $("settings-edit-bar").dataset.intensity = String(exercise.intensity);
  $("settings-remove-btn").disabled =
    state.library.filter((item) => !item.deleted).length <= 1;
}

function runSingleSnack(index) {
  const exercise = state.library[index];
  if (!exercise) {
    return;
  }
  state.stack = [exercise];
  beginRun();
}

function beginRun() {
  if (state.stack.length === 0) {
    toast("shake the jar first");
    return;
  }

  initAudio();
  state.runIdx = 0;
  state.completed = [];
  state.paused = false;
  state.currentStackId = `r-${Date.now()}`;
  startRest();
}

function startSnack() {
  clearInterval(state.restHandle);
  clearInterval(state.timerHandle);

  const snack = state.stack[state.runIdx];
  if (!snack) {
    return;
  }

  $("timer-step").textContent = `snack ${state.runIdx + 1} / ${state.stack.length}`;
  $("timer-category").textContent = snack.category;
  $("timer-category").className = `timer-category cat-${snack.category}`;
  $("timer-name").textContent = snack.name;
  $("timer-intensity").innerHTML = renderIntensityPips(snack.intensity, snack.category);
  $("timer-stack").innerHTML = state.stack
    .map((snack, i) => {
      const cls = i < state.runIdx ? "is-done" : i === state.runIdx ? "is-current" : "";
      return `<li class="timer-stack-item${cls ? ` ${cls}` : ""}">${esc(snack.name)}</li>`;
    })
    .join("");
  $("timer-fill").className = `timer-progress-fill cat-${snack.category}`;

  state.secondsLeft = SNACK_DURATION;
  state.snackEndTime = Date.now() + SNACK_DURATION * 1000;
  state.paused = false;
  $("btn-pause").textContent = "pause";
  $("btn-pause").classList.remove("pause-active");
  $("rest-btn-pause").textContent = "pause";
  $("rest-btn-pause").classList.remove("pause-active");

  updateTimerDisplay();
  state.timerHandle = window.setInterval(tickSnack, 1000);
}

function tickSnack() {
  if (state.paused) return;
  const prev = state.secondsLeft;
  state.secondsLeft = Math.max(0, Math.round((state.snackEndTime - Date.now()) / 1000));
  if (prev > 30 && state.secondsLeft <= 30) beep(660, 0.08);
  updateTimerDisplay();
  if (state.secondsLeft <= 0) {
    beep(880, 0.5);
    completeCurrentSnack(false);
  }
}

function updateTimerDisplay() {
  $("timer-seconds").innerHTML = `${formatTimerSeconds(state.secondsLeft)}<span class="s">s</span>`;
  $("timer-fill").style.transform = `scaleX(${state.secondsLeft / SNACK_DURATION})`;
}

function completeCurrentSnack(skipped) {
  clearInterval(state.timerHandle);

  state.completed.push({
    id: state.stack[state.runIdx].id,
    at: new Date().toISOString(),
    stack: state.currentStackId,
    skipped,
  });

  if (state.runIdx >= state.stack.length - 1) {
    finishRun();
    return;
  }

  state.runIdx += 1;
  startRest();
}

function startRest() {
  clearInterval(state.restHandle);
  showView("rest");

  state.restEndTime = Date.now() + REST_DURATION * 1000;
  const beeped = new Set();

  $("rest-seconds").textContent = String(REST_DURATION);
  $("rest-fill").style.transform = "scaleX(0)";
  $("rest-stack").innerHTML = state.stack
    .map((snack, i) => {
      const cls = i < state.runIdx ? "is-done" : i === state.runIdx ? "is-current" : "";
      return `<li class="timer-stack-item${cls ? ` ${cls}` : ""}">${esc(snack.name)}</li>`;
    })
    .join("");

  state.restHandle = window.setInterval(() => {
    if (state.paused) return;
    const seconds = Math.max(0, Math.round((state.restEndTime - Date.now()) / 1000));
    $("rest-seconds").textContent = String(seconds);
    $("rest-fill").style.transform = `scaleX(${1 - seconds / REST_DURATION})`;

    if (!beeped.has(seconds)) {
      beeped.add(seconds);
      if (seconds === 2) beep(880, 0.08);
      if (seconds === 1) beep(880, 0.08);
      if (seconds === 0) beep(880, 0.35);
    }

    if (seconds <= 0) {
      clearInterval(state.restHandle);
      showView("run");
      startSnack();
    }
  }, 1000);
}

function finishRun() {
  const entry = todayEntry();
  entry.snacks.push(...state.completed);
  save();
  renderDone();
  showView("done");
}

function renderDone() {
  const completed = resolveSnacks(state.completed, state.library);
  $("done-title").textContent = `${formatSizeLabel(completed.length)} complete`;
  $("done-spark").innerHTML = renderSparkBars(completed, "done", "");
  $("done-list").innerHTML = completed
    .map(
      (snack, index) => `
        <div class="done-list-item">
          <span>${String(index + 1).padStart(2, "0")}. ${esc(snack.name)}</span>
          <span class="meta cat-tag cat-${esc(snack.category)}">${esc(snack.category)} / ${snack.intensity}</span>
        </div>
      `,
    )
    .join("");
  $("done-stats").textContent = `load ${getLoad(completed)}`;
}

function togglePause() {
  if (state.paused) {
    const pausedFor = Date.now() - state.pauseStartTime;
    if (state.currentView === "run") state.snackEndTime += pausedFor;
    if (state.currentView === "rest") state.restEndTime += pausedFor;
    state.paused = false;
  } else {
    state.pauseStartTime = Date.now();
    state.paused = true;
  }
  $("btn-pause").textContent = state.paused ? "resume" : "pause";
  $("btn-pause").classList.toggle("pause-active", state.paused);
  $("rest-btn-pause").textContent = state.paused ? "resume" : "pause";
  $("rest-btn-pause").classList.toggle("pause-active", state.paused);
}

function skipSnack() {
  completeCurrentSnack(true);
}

function prevSnack() {
  if (state.runIdx === 0) {
    toast("already at the first snack");
    return;
  }

  state.runIdx -= 1;
  state.completed.pop();
  startSnack();
}

function quitRun() {
  if (state.completed.length > 0) {
    const confirmed = window.confirm(
      `Quit? You've finished ${state.completed.length} of ${state.stack.length}. They'll still be logged.`,
    );
    if (!confirmed) {
      return;
    }

    const entry = todayEntry();
    entry.snacks.push(...state.completed);
    save();
  }

  clearInterval(state.timerHandle);
  clearInterval(state.restHandle);
  renderHome();
  showView("home");
}

function showDay(dateKey) {
  const entry = findHistoryEntry(state.history, dateKey);
  if (!entry || entry.snacks.length === 0) {
    return;
  }

  const snacks = resolveEntrySnacks(entry);

  $("day-title").textContent = formatDayTitle(dateKey);
  $("day-sub").textContent = `${formatMonthDay(dateKey)} / ${snacks.length} snack${snacks.length === 1 ? "" : "s"} / load ${getLoad(snacks)}`;
  $("day-hero-spark").innerHTML = renderSparkBars(snacks, "day", "");
  $("day-list").innerHTML = groupByStack(snacks)
    .map(
      (group) => `
        <div class="day-group">
          <div class="day-group-time">${group.at ? esc(formatTime(group.at)) : "--"}</div>
          <div class="day-group-snacks">
            ${group.snacks
              .map(
                (snack) => `
                  <div class="day-snack">
                    <span class="day-bar cat-${esc(snack.category)}" data-intensity="${snack.intensity}"></span>
                    <span class="day-snack-name">${esc(snack.name)}${snack.skipped ? '<span class="skipped-tag"> skipped</span>' : ""}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      `,
    )
    .join("");

  showView("day");
}

function openSettings() {
  renderSettings();
  renderSettingsEditor();
  showView("settings");
}

function goHome() {
  state.editingIndex = null;
  renderSettingsEditor();
  renderHome();
  showView("home");
}

async function toggleLinkPanel() {
  state.linkPanelOpen = !state.linkPanelOpen;
  renderLinkPanel();

  if (!state.linkPanelOpen || state.sync.code || state.linkBusy) {
    return;
  }

  await prepareLink();
}

async function prepareLink() {
  if (!state.settings.syncBaseUrl) {
    state.linkError = "linking is not available here yet";
    renderLinkPanel();
    return;
  }

  state.linkBusy = true;
  state.linkError = "";
  renderLinkPanel();

  try {
    ensureLocalVersion();
    const payload = await createLinkRoom(state.settings.syncBaseUrl, {
      deviceId: state.deviceId,
      version: state.sync.stateVersion,
      snapshot: currentSnapshot(),
    });

    state.sync.code = normalizeCode(payload.code);
    state.sync.stateVersion = payload.version || state.sync.stateVersion;
    state.clock = observeClock(state.clock, payload.version);
    state.syncStatus = "synced";
    persistRemoteState();
    startSync();
  } catch (error) {
    state.linkError = error instanceof Error ? error.message : "Link could not be prepared.";
  } finally {
    state.linkBusy = false;
    renderLinkPanel();
  }
}

async function copyLinkUrl() {
  const linkUrl = state.sync.code ? buildDeviceLink(window.location.href, state.sync.code) : "";
  if (!linkUrl) {
    if (!state.linkBusy) {
      await prepareLink();
    }
    return;
  }

  await copyText(linkUrl);
  toast("link copied");
}

async function handleIncomingLink() {
  const url = new URL(window.location.href);
  const code = normalizeCode(url.searchParams.get("link"));

  if (!code) {
    if (state.sync.code) {
      startSync();
    }
    return;
  }

  await connectToLinkCode(code, { sourceUrl: url });
}

async function connectToLinkCode(value, options = {}) {
  const code = extractLinkCode(value);

  if (!state.settings.syncBaseUrl) {
    state.linkError = "linking is not available here yet";
    state.linkPanelOpen = true;
    renderLinkPanel();
    return;
  }

  if (!code) {
    state.linkError = "enter a link code";
    state.linkPanelOpen = true;
    renderLinkPanel();
    return;
  }

  state.linkBusy = true;
  state.linkError = "";
  state.linkPanelOpen = true;
  state.linkCodeInput = code;
  renderLinkPanel();

  try {
    const payload = await fetchLinkState(state.settings.syncBaseUrl, code);
    state.sync.code = normalizeCode(payload.code || code);
    applyRemoteSnapshot(payload.snapshot, payload.version || "");
    state.syncStatus = "synced";
    state.linkCodeInput = "";
    persistRemoteState();
    startSync();
    if (options.sourceUrl) {
      stripIncomingLinkParam(options.sourceUrl);
    }
    toast("device linked");
  } catch (error) {
    state.linkError = error instanceof Error ? error.message : "Device could not be linked.";
  } finally {
    state.linkBusy = false;
    renderLinkPanel();
  }
}

function stripIncomingLinkParam(url) {
  url.searchParams.delete("link");
  window.history.replaceState({}, "", url.toString());
}

function extractLinkCode(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (/[?&]link=/i.test(raw) || /^[a-z]+:\/\//i.test(raw)) {
    try {
      const url = new URL(raw, window.location.href);
      const code = normalizeCode(url.searchParams.get("link"));
      if (code) {
        return code;
      }
    } catch {
      // Fall through and treat the input as a raw code.
    }
  }

  return normalizeCode(raw);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "true");
    input.style.position = "absolute";
    input.style.left = "-9999px";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function formatStackLabel(size) {
  if (size === 1) {
    return "single";
  }

  if (size === 3) {
    return "triple";
  }

  if (size === 5) {
    return "high five";
  }

  return formatSizeLabel(size);
}

function attachChipHandlers() {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const group = chip.dataset.group;
      const rawValue = chip.dataset.val;
      if (!group || !rawValue) {
        return;
      }

      state.filters[group] = group === "size" ? Number(rawValue) : rawValue;

      document.querySelectorAll(`.chip[data-group="${group}"]`).forEach((other) => {
        other.classList.remove("active", ...CATEGORY_COLOR_CLASSES);
      });

      chip.classList.add("active");
      if (group === "category" && rawValue !== "any") {
        chip.classList.add(`cat-${rawValue}`);
      }
    });
  });
}

function attachSizeHandlers() {
  document.querySelectorAll(".size-bubble").forEach((button) => {
    button.addEventListener("click", () => {
      const size = Number(button.dataset.size);
      if (!size) {
        return;
      }

      state.filters.size = size;
      shakeJar();
    });
  });
}

function updateSettingsFilter(group, rawValue) {
  if (!group || !rawValue) {
    return;
  }

  state.settingsFilters[group] = rawValue;
  renderSettings();
}

function openSnackEditor(index) {
  if (!Number.isInteger(index) || !state.library[index]) {
    return;
  }

  state.editingIndex = index;
  renderSettingsEditor();
  window.requestAnimationFrame(() => {
    $("settings-name-input").focus();
  });
}

function closeSnackEditor() {
  state.editingIndex = null;
  renderSettings();
  renderSettingsEditor();
}

function updateLibraryField(index, field, value) {
  const exercise = state.library[index];
  if (!exercise) {
    return;
  }

  if (field === "intensity") {
    exercise[field] = Number(value);
  } else if (field === "enabled") {
    exercise[field] = Boolean(value);
  } else {
    exercise[field] = value;
  }

  save();
  renderSettings();
  if (state.editingIndex === index) {
    renderSettingsEditor();
  }
}

function setVisibleSnacksEnabled(enabled) {
  const visibleSnacks = getVisibleLibrarySnacks();
  if (visibleSnacks.length === 0) {
    return;
  }

  visibleSnacks.forEach(({ exercise }) => {
    exercise.enabled = enabled;
  });

  save();
  renderSettings();
  if (state.editingIndex != null) {
    renderSettingsEditor();
  }
}

function addSnack() {
  const exercise = createEmptyExercise();
  if (state.settingsFilters.category !== "any") {
    exercise.category = state.settingsFilters.category;
  }
  if (state.settingsFilters.intensity !== "any") {
    exercise.intensity = Number(state.settingsFilters.intensity);
  }

  state.library.push(exercise);
  save();
  renderSettings();
  openSnackEditor(state.library.length - 1);
}

function deleteSnack(index) {
  const activeCount = state.library.filter((exercise) => !exercise.deleted).length;
  if (activeCount <= 1) {
    toast("keep at least one snack");
    return;
  }

  const exercise = state.library[index];
  if (!exercise || exercise.deleted) {
    return;
  }

  exercise.deleted = true;
  save();
  if (state.editingIndex === index) {
    state.editingIndex = null;
  }
  renderSettings();
  renderSettingsEditor();
}

function exportJson() {
  const payload = {
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    history: state.history,
    library: state.library,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `snax-history-${todayKey()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  toast("snax json exported");
}

async function importJsonFile(file) {
  if (!file) {
    return;
  }

  try {
    const imported = parseImportPayload(JSON.parse(await file.text()));
    openImportDialog(imported, file.name || "snax import");
  } catch (error) {
    toast(error instanceof Error ? error.message : "could not import json");
  }
}

function parseImportPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      history: hydrateImportedHistory(payload),
      library: [],
    };
  }

  const snapshot = payload?.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : payload;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("that json does not look like snax data");
  }

  const hasHistory = Array.isArray(snapshot.history);
  const hasLibrary = Array.isArray(snapshot.library);
  if (!hasHistory && !hasLibrary) {
    throw new Error("that json does not include snax history or library");
  }

  return {
    history: hasHistory ? hydrateImportedHistory(snapshot.history) : [],
    library: hasLibrary ? hydrateImportedLibrary(snapshot.library) : [],
  };
}

function hydrateImportedHistory(history) {
  const entriesByDate = new Map();

  history
    .filter((entry) => entry && typeof entry === "object")
    .forEach((entry) => {
      const dateKey = String(entry.dateKey || entry.date || "");
      if (!dateKey) {
        return;
      }

      const existing = entriesByDate.get(dateKey) || { dateKey, snacks: [] };
      const existingSnackKeys = new Set(existing.snacks.map((snack) => snackImportKey(snack)));
      const snacks = Array.isArray(entry.snacks) ? entry.snacks.map((snack) => hydrateSnack(snack)) : [];
      snacks.forEach((snack) => {
        const key = snackImportKey(snack);
        if (existingSnackKeys.has(key)) {
          return;
        }

        existing.snacks.push(snack);
        existingSnackKeys.add(key);
      });
      entriesByDate.set(dateKey, existing);
    });

  return sortHistoryDescending([...entriesByDate.values()]);
}

function hydrateImportedLibrary(library) {
  return library
    .filter((exercise) => exercise && typeof exercise === "object")
    .map((exercise, index) => hydrateExercise(exercise, index));
}

function mergeKeyForExerciseName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function countNewHistoryEntries(importedHistory) {
  const localDateKeys = new Set(state.history.map((entry) => entry.dateKey));
  return importedHistory.filter((entry) => !localDateKeys.has(entry.dateKey)).length;
}

function countNewLibraryExercises(importedLibrary) {
  const localNames = new Set(state.library.map((exercise) => mergeKeyForExerciseName(exercise.name)));
  const seenImportedNames = new Set();
  let count = 0;

  importedLibrary.forEach((exercise) => {
    const key = mergeKeyForExerciseName(exercise.name);
    if (!key || seenImportedNames.has(key)) {
      return;
    }

    seenImportedNames.add(key);
    if (!localNames.has(key)) {
      count += 1;
    }
  });

  return count;
}

function openImportDialog(imported, fileName) {
  state.pendingImport = {
    fileName,
    data: imported,
    stats: {
      historyEntries: imported.history.length,
      newHistoryEntries: countNewHistoryEntries(imported.history),
      libraryExercises: imported.library.length,
      newLibraryExercises: countNewLibraryExercises(imported.library),
    },
  };
  state.importModes = {
    history: "merge",
    library: "merge",
  };
  renderImportDialog();
}

function closeImportDialog() {
  state.pendingImport = null;
  $("import-overlay").hidden = true;
  document.body.classList.remove("settings-overlay-open");
}

function renderImportDialog() {
  const pendingImport = state.pendingImport;
  const overlay = $("import-overlay");
  overlay.hidden = !pendingImport;
  document.body.classList.toggle("settings-overlay-open", Boolean(pendingImport));

  if (!pendingImport) {
    return;
  }

  const { stats } = pendingImport;
  const historyDisabled = stats.historyEntries === 0;
  const libraryDisabled = stats.libraryExercises === 0;

  $("import-file-name").textContent = pendingImport.fileName;
  $("import-history-meta").textContent = `${stats.historyEntries} entr${stats.historyEntries === 1 ? "y" : "ies"} / ${stats.newHistoryEntries} new`;
  $("import-library-meta").textContent = `${stats.libraryExercises} exercise${stats.libraryExercises === 1 ? "" : "s"} / ${stats.newLibraryExercises} new`;
  setImportModeControl("history", state.importModes.history, historyDisabled);
  setImportModeControl("library", state.importModes.library, libraryDisabled);
  $("import-warning").textContent = importWarningText(historyDisabled, libraryDisabled);
  $("import-confirm-btn").disabled = historyDisabled && libraryDisabled;
}

function setImportModeControl(kind, mode, disabled) {
  document.querySelectorAll(`input[name="import-${kind}-mode"]`).forEach((input) => {
    input.checked = input.value === mode;
    input.disabled = disabled;
  });
}

function importWarningText(historyDisabled, libraryDisabled) {
  if (historyDisabled && libraryDisabled) {
    return "there is no history or library data to import";
  }

  const warnings = [];
  if (state.importModes.history === "overwrite" && !historyDisabled) {
    warnings.push("history overwrite replaces all local history");
  }
  if (state.importModes.library === "overwrite" && !libraryDisabled) {
    warnings.push("library overwrite replaces local exercises");
  }
  if (state.importModes.history === "merge" && state.importModes.library === "overwrite" && !libraryDisabled) {
    warnings.push("local history may show unknown snacks for exercises not in the imported library");
  }

  return warnings.join(" / ");
}

function updateImportMode(kind, mode) {
  if (!state.pendingImport || !["history", "library"].includes(kind) || (mode !== "merge" && mode !== "overwrite")) {
    return;
  }

  state.importModes[kind] = mode;
  renderImportDialog();
}

function confirmImport() {
  const pendingImport = state.pendingImport;
  if (!pendingImport) {
    return;
  }

  const imported = pendingImport.data;
  const hasImportedHistory = imported.history.length > 0;
  const hasImportedLibrary = imported.library.length > 0;
  const libraryResult =
    hasImportedLibrary && state.importModes.library === "overwrite"
      ? overwriteImportedLibrary(imported.library)
      : mergeImportedLibrary(state.library, imported.library);
  const baseHistory =
    hasImportedLibrary && state.importModes.library === "overwrite"
      ? remapHistoryEntries(state.history, libraryResult.localIdMap)
      : state.history;
  const importedHistory = remapHistoryEntries(imported.history, libraryResult.importIdMap);
  const historyResult =
    !hasImportedHistory
      ? { history: sortHistoryDescending(baseHistory), addedDays: 0, addedSnacks: 0 }
      : state.importModes.history === "overwrite"
      ? overwriteImportedHistory(importedHistory)
      : mergeImportedHistory(baseHistory, importedHistory);

  state.library = libraryResult.library;
  state.history = historyResult.history;
  closeImportDialog();
  save();
  renderHome();
  renderSettings();
  const historyAction = hasImportedHistory ? describeImportMode(state.importModes.history) : "kept";
  const libraryAction = hasImportedLibrary ? describeImportMode(state.importModes.library) : "kept";
  toast(`${historyAction} history / ${libraryAction} library`);
}

function describeImportMode(mode) {
  return mode === "overwrite" ? "overwrote" : "merged";
}

function uniqueExerciseId(id, existingIds) {
  const base = String(id || "snack").trim() || "snack";
  if (!existingIds.has(base)) {
    return base;
  }

  let index = 2;
  let next = `${base}-import`;
  while (existingIds.has(next)) {
    next = `${base}-import-${index}`;
    index += 1;
  }

  return next;
}

function mergeImportedLibrary(baseLibrary, importedLibrary) {
  const library = baseLibrary.map((exercise) => ({ ...exercise }));
  const importIdMap = new Map();
  const localIdMap = new Map();
  const existingIds = new Set(library.map((exercise) => exercise.id));
  const exercisesByName = new Map();
  let added = 0;

  library.forEach((exercise) => {
    localIdMap.set(exercise.id, exercise.id);
    const key = mergeKeyForExerciseName(exercise.name);
    if (key && !exercisesByName.has(key)) {
      exercisesByName.set(key, exercise);
    }
  });

  importedLibrary.forEach((importedExercise) => {
    const key = mergeKeyForExerciseName(importedExercise.name);
    const existingExercise = key ? exercisesByName.get(key) : null;
    if (existingExercise) {
      importIdMap.set(importedExercise.id, existingExercise.id);
      return;
    }

    const exercise = {
      ...importedExercise,
      id: uniqueExerciseId(importedExercise.id, existingIds),
    };
    existingIds.add(exercise.id);
    if (key) {
      exercisesByName.set(key, exercise);
    }
    importIdMap.set(importedExercise.id, exercise.id);
    library.push(exercise);
    added += 1;
  });

  return { added, importIdMap, library, localIdMap };
}

function overwriteImportedLibrary(importedLibrary) {
  const importIdMap = new Map();
  const localIdMap = new Map();
  const importedByName = new Map();
  const existingIds = new Set();
  const library = [];

  importedLibrary.forEach((importedExercise) => {
    const key = mergeKeyForExerciseName(importedExercise.name);
    const existingExercise = importedByName.get(key);
    if (existingExercise) {
      importIdMap.set(importedExercise.id, existingExercise.id);
      return;
    }

    const exercise = {
      ...importedExercise,
      id: uniqueExerciseId(importedExercise.id, existingIds),
    };
    existingIds.add(exercise.id);
    importedByName.set(key, exercise);
    importIdMap.set(importedExercise.id, exercise.id);
    library.push(exercise);
  });

  state.library.forEach((exercise) => {
    const importedExercise = importedByName.get(mergeKeyForExerciseName(exercise.name));
    localIdMap.set(exercise.id, importedExercise ? importedExercise.id : exercise.id);
  });

  return { added: library.length, importIdMap, library, localIdMap };
}

function snackImportKey(snack) {
  return [snack.id, snack.at || "", snack.stack || "", snack.skipped ? "1" : "0"].join("|");
}

function remapHistoryEntries(history, idMap) {
  return history.map((entry) => ({
    dateKey: entry.dateKey,
    snacks: entry.snacks.map((snack) => ({
      ...snack,
      id: idMap.get(snack.id) || snack.id,
    })),
  }));
}

function overwriteImportedHistory(importedHistory) {
  return {
    history: sortHistoryDescending(importedHistory),
    addedDays: importedHistory.length,
    addedSnacks: importedHistory.reduce((total, entry) => total + entry.snacks.length, 0),
  };
}

function mergeImportedHistory(baseHistory, importedHistory) {
  const entriesByDate = new Map(
    baseHistory.map((entry) => [
      entry.dateKey,
      {
        dateKey: entry.dateKey,
        snacks: entry.snacks.map((snack) => ({ ...snack })),
      },
    ]),
  );
  let addedDays = 0;
  let addedSnacks = 0;

  importedHistory.forEach((importedEntry) => {
    let entry = entriesByDate.get(importedEntry.dateKey);
    if (!entry) {
      entry = { dateKey: importedEntry.dateKey, snacks: [] };
      entriesByDate.set(importedEntry.dateKey, entry);
      addedDays += 1;
    }

    const existingSnackKeys = new Set(entry.snacks.map((snack) => snackImportKey(snack)));
    importedEntry.snacks.forEach((snack) => {
      const key = snackImportKey(snack);
      if (existingSnackKeys.has(key)) {
        return;
      }

      entry.snacks.push({ ...snack });
      existingSnackKeys.add(key);
      addedSnacks += 1;
    });
  });

  return { history: sortHistoryDescending([...entriesByDate.values()]), addedDays, addedSnacks };
}

async function init() {
  attachChipHandlers();
  attachSizeHandlers();
  renderHome();
  document.addEventListener("visibilitychange", handleVisibilityChange);

  $("link-btn").addEventListener("click", () => {
    toggleLinkPanel().catch((error) => {
      state.linkError = error instanceof Error ? error.message : "Link could not be prepared.";
      state.linkBusy = false;
      renderLinkPanel();
    });
  });
  $("close-link-btn").addEventListener("click", closeLinkPanel);
  $("settings-btn").addEventListener("click", openSettings);
  $("copy-link-btn").addEventListener("click", () => {
    copyLinkUrl().catch((error) => {
      state.linkError = error instanceof Error ? error.message : "Link could not be copied.";
      renderLinkPanel();
    });
  });
  $("link-code-input").addEventListener("input", (event) => {
    state.linkCodeInput = event.target.value;
    if (state.linkError) {
      state.linkError = "";
      renderLinkPanel();
      return;
    }

    $("link-connect-btn").disabled = state.linkBusy || !extractLinkCode(state.linkCodeInput);
  });
  $("link-join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connectToLinkCode(state.linkCodeInput).catch((error) => {
      state.linkError = error instanceof Error ? error.message : "Device could not be linked.";
      state.linkBusy = false;
      renderLinkPanel();
    });
  });
  $("begin-btn").addEventListener("click", beginRun);
  $("btn-prev").addEventListener("click", prevSnack);
  $("btn-pause").addEventListener("click", togglePause);
  $("rest-btn-pause").addEventListener("click", togglePause);
  $("btn-skip").addEventListener("click", skipSnack);
  $("timer-quit").addEventListener("click", quitRun);
  $("add-snack-btn").addEventListener("click", addSnack);
  $("export-json-btn").addEventListener("click", exportJson);
  $("import-json-btn").addEventListener("click", () => {
    $("import-json-input").click();
  });
  $("import-json-input").addEventListener("change", (event) => {
    importJsonFile(event.target.files?.[0]).finally(() => {
      event.target.value = "";
    });
  });
  $("import-cancel-btn").addEventListener("click", closeImportDialog);
  $("import-overlay-scrim").addEventListener("click", closeImportDialog);
  $("import-confirm-btn").addEventListener("click", confirmImport);
  document.querySelectorAll('input[name="import-history-mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        updateImportMode("history", input.value);
      }
    });
  });
  document.querySelectorAll('input[name="import-library-mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        updateImportMode("library", input.value);
      }
    });
  });
  $("settings-close-btn").addEventListener("click", closeSnackEditor);
  $("settings-overlay-scrim").addEventListener("click", closeSnackEditor);
  $("settings-remove-btn").addEventListener("click", () => {
    if (state.editingIndex != null) {
      deleteSnack(state.editingIndex);
    }
  });
  $("settings-name-input").addEventListener("input", (event) => {
    updateLibraryField(state.editingIndex, "name", event.target.value);
  });
  $("settings-tagline-input").addEventListener("input", (event) => {
    updateLibraryField(state.editingIndex, "tagline", event.target.value);
  });
  $("settings-category-select").addEventListener("change", (event) => {
    updateLibraryField(state.editingIndex, "category", event.target.value);
  });
  $("settings-intensity-select").addEventListener("change", (event) => {
    updateLibraryField(state.editingIndex, "intensity", event.target.value);
  });
  $("settings-search-input").addEventListener("input", (event) => {
    state.settingsFilters.query = event.target.value;
    renderSettings();
  });
  $("settings-visible-toggle").addEventListener("change", (event) => {
    setVisibleSnacksEnabled(event.target.checked);
  });

  document.querySelectorAll('[data-action="home"]').forEach((button) => {
    button.addEventListener("click", goHome);
  });

  $("more-toggle").addEventListener("click", () => {
    const advanced = $("advanced");
    const isOpen = advanced.classList.toggle("open");
    $("more-toggle").setAttribute("aria-expanded", String(isOpen));
  });

  $("today-panel").addEventListener("click", () => {
    const entry = findHistoryEntry(state.history, todayKey());
    if (entry && entry.snacks.length > 0) {
      showDay(todayKey());
    }
  });

  $("archive-list").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const monthToggle = target ? target.closest(".archive-month-toggle") : null;
    if (monthToggle && monthToggle.dataset.month) {
      toggleArchiveMonth(monthToggle.dataset.month);
      return;
    }

    const row = target ? target.closest(".archive-row.has-snacks") : null;
    if (row && row.dataset.date) {
      showDay(row.dataset.date);
    }
  });

  document.querySelector(".settings-filters").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target ? target.closest(".settings-chip") : null;
    if (!chip) {
      return;
    }

    updateSettingsFilter(chip.dataset.settingsGroup, chip.dataset.val);
  });

  $("settings-list").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const goBtn = target ? target.closest('[data-action="run-single-snack"]') : null;
    if (goBtn) {
      runSingleSnack(Number(goBtn.dataset.index));
      return;
    }
    const button = target ? target.closest('[data-action="edit-snack"]') : null;
    if (!button) {
      return;
    }

    openSnackEditor(Number(button.dataset.index));
  });
  $("settings-list").addEventListener("change", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const checkbox = target ? target.closest('[data-action="toggle-snack-enabled"]') : null;
    if (!(checkbox instanceof HTMLInputElement)) {
      return;
    }

    updateLibraryField(Number(checkbox.dataset.index), "enabled", checkbox.checked);
  });

  document.addEventListener("keydown", (event) => {
    if (state.pendingImport && event.key === "Escape") {
      event.preventDefault();
      closeImportDialog();
      return;
    }

    if (state.editingIndex != null && event.key === "Escape") {
      event.preventDefault();
      closeSnackEditor();
      return;
    }

    if ($("view-home").classList.contains("active") && event.key === " ") {
      event.preventDefault();
      shakeJar();
    }

    if ($("view-run").classList.contains("active")) {
      if (event.key === " ") {
        event.preventDefault();
        togglePause();
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        skipSnack();
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        prevSnack();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        quitRun();
      }
    }
  });

  await handleIncomingLink();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.currentView === "run" && !state.paused && state.snackEndTime) {
    state.secondsLeft = Math.max(0, Math.round((state.snackEndTime - Date.now()) / 1000));
    updateTimerDisplay();
    if (state.secondsLeft <= 0) completeCurrentSnack(false);
  } else if (state.currentView === "rest" && !state.paused && state.restEndTime) {
    const left = Math.max(0, Math.round((state.restEndTime - Date.now()) / 1000));
    if (left <= 0) {
      clearInterval(state.restHandle);
      showView("run");
      startSnack();
    }
  }
});

init();
registerServiceWorker();

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // The app can still run normally without offline install support.
    });
  });
}
