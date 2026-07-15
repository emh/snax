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
  formatLongDate,
  formatMetaText,
  formatShortDate,
  formatSizeLabel,
  formatTime,
  formatTimerSeconds,
  getLoad,
  hydrateExercise,
  hydrateSnack,
  hydrateWorkout,
  pickStack,
  resolveSnacks,
  sortHistoryDescending,
  todayKey,
  toDateKey,
} from "./model.js";
import { hydrateSnapshot, loadAppState, loadSettings, saveAppState } from "./storage.js";
import { SnaxSync, buildDeviceLink, createLinkRoom, fetchLinkState, nextClock, normalizeCode, observeClock } from "./sync.js";

const loadedState = loadAppState();
const state = {
  settings: loadSettings(),
  filters: { ...DEFAULT_FILTERS },
  settingsFilters: {
    categories: [...CATEGORY_ORDER],
    intensities: [1, 2, 3],
    query: "",
  },
  filterSheetScope: null,
  expandedHistoryMonths: new Set(),
  expandedHistoryDays: new Set(),
  animatedHistoryDays: new Set(),
  baseStack: [],
  stack: [],
  rounds: 1,
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
  adminPanelOpen: false,
  cancelPanelOpen: false,
  cancelWasPaused: false,
  linkBusy: false,
  linkError: "",
  linkCodeInput: "",
  editingIndex: null,
  editingIsNew: false,
  editingDraft: null,
  currentView: "home",
  pendingImport: null,
  importModes: {
    history: "merge",
    library: "merge",
  },
};

const $ = (id) => document.getElementById(id);
const EXPORT_SCHEMA = "snax.history.v2";
const TIMER_WAKE_LOCK_TYPE = "screen";

let toastTimer;
let syncClient = null;
let timerWakeLock = null;
let timerWakeLockRequest = null;
let audioCtx = null;
let filterSheetTimer = null;
let linkPanelTimer = null;
let adminPanelTimer = null;
let editorPanelTimer = null;
let cancelPanelTimer = null;

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
  if (state.filterSheetScope && name !== state.currentView) {
    closeFilterSheet(true);
  }
  if (state.linkPanelOpen && name !== "home") {
    closeLinkPanel(true);
  }
  if (state.adminPanelOpen && name !== "settings") {
    closeAdminPanel(true);
  }
  if (state.cancelPanelOpen && !["run", "rest"].includes(name)) {
    closeCancelPanel(true, false);
  }
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  $(`view-${name}`).classList.add("active");
  state.currentView = name;
  renderBottomToolbar();
  syncTimerWakeLock();
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    syncFloatingBackButton();
  });
}

function syncFloatingBackButton() {
  const scrolled = window.scrollY > 40;
  document.querySelectorAll('.back-btn[data-action="home"]').forEach((button) => {
    const shouldFloat = button.closest(".view.active") && scrolled;
    button.classList.toggle("back-btn-floating", Boolean(shouldFloat));
    button.closest(".preview-header")?.classList.toggle("has-floating-back", Boolean(shouldFloat));
  });

  $("link-btn").classList.toggle(
    "header-action-floating",
    Boolean($("view-home").classList.contains("active") && scrolled),
  );
  document.querySelector(".library-header-actions")?.classList.toggle(
    "header-actions-floating",
    Boolean($("view-settings").classList.contains("active") && scrolled),
  );
}

function renderBottomToolbar() {
  const toolbar = $("bottom-toolbar");
  const activeTab = state.currentView === "settings" ? "settings" : state.currentView;
  toolbar.hidden = !["home", "history", "settings"].includes(activeTab);
  toolbar.querySelectorAll("[data-tab]").forEach((button) => {
    const isActive = button.dataset.tab === activeTab;
    button.classList.toggle("active", isActive);
    if (isActive) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
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
  return entry
    ? resolveSnacks(entry.workouts.flatMap((workout) => workout.exercises), state.library).filter((snack) => !snack.skipped)
    : [];
}

function resolveEntryWorkouts(entry) {
  return (entry?.workouts || [])
    .map((workout) => ({
      ...workout,
      exercises: resolveSnacks(workout.exercises, state.library).filter((exercise) => !exercise.skipped),
    }))
    .filter((workout) => workout.exercises.length > 0);
}

function renderSparkBars(snacks, variant, emptyLabel, animate = true) {
  if (snacks.length === 0) {
    return `<span class="spark-empty">${esc(emptyLabel)}</span>`;
  }

  const unit = variant === "archive" ? 7 : 10;
  return snacks
    .map(
      (snack, index) =>
        `<span class="spark-bar spark-bar-${variant} cat-${esc(snack.category)}${animate ? "" : " spark-bar-static"}" style="height: ${8 + snack.intensity * unit}px; animation-delay: ${index * 0.04}s"></span>`,
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
}

function renderLinkPanel() {
  const panel = $("link-panel");
  const toggle = $("link-btn");
  const linkUrl = state.sync.code ? buildDeviceLink(window.location.href, state.sync.code) : "";
  const linkCode = state.sync.code || "";

  toggle?.setAttribute("aria-expanded", String(state.linkPanelOpen));

  if (!state.linkPanelOpen) {
    return;
  }

  window.clearTimeout(linkPanelTimer);
  panel.hidden = false;
  document.body.classList.add("link-sheet-open");
  window.requestAnimationFrame(() => panel.classList.add("open"));

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

function closeLinkPanel(immediate = false) {
  const panel = $("link-panel");
  window.clearTimeout(linkPanelTimer);
  state.linkPanelOpen = false;
  panel.classList.remove("open");
  document.body.classList.remove("link-sheet-open");
  $("link-btn").setAttribute("aria-expanded", "false");

  if (immediate) {
    panel.hidden = true;
    return;
  }

  linkPanelTimer = window.setTimeout(() => {
    panel.hidden = true;
  }, 300);
}

function renderDate() {
  $("home-date").textContent = formatLongDate(todayKey());
}

function renderToday() {
  const entry = findHistoryEntry(state.history, todayKey());
  const snacks = resolveEntrySnacks(entry);
  $("today-meta").textContent = formatMetaText(snacks);
  $("today-spark").innerHTML = renderSparkBars(snacks, "today", "quiet so far");
  $("today-sessions").innerHTML = renderSessionGroups(resolveEntryWorkouts(entry));
}

function renderSessionGroups(workouts) {
  return workouts
    .slice()
    .sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")))
    .map((workout) => {
      return `
        <div class="day-group">
          <div class="day-group-time">${workout.at ? esc(formatTime(workout.at)) : "--"}</div>
          <div class="day-group-snacks">
            ${workout.exercises
              .map(
                (snack) => `
                  <div class="day-snack">
                    <span class="day-bar cat-${esc(snack.category)}" data-intensity="${snack.intensity}"></span>
                    <span class="day-snack-name">${esc(snack.name)}</span>
                  </div>
                `,
              )
              .join("")}
            ${workout.rounds > 1 ? `<div class="day-group-rounds">${workout.rounds} rounds</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
}

function historyMonthKey(dateKey) {
  return String(dateKey).slice(0, 7);
}

function formatHistoryMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(year, month - 1, 1, 12),
  );
}

function getHistoryMonthGroups() {
  const groups = [];
  const byMonth = new Map();

  sortHistoryDescending(state.history).forEach((entry) => {
      const snacks = resolveEntrySnacks(entry);
      if (snacks.length === 0) return;
      const monthKey = historyMonthKey(entry.dateKey);
      let group = byMonth.get(monthKey);
      if (!group) {
        group = { monthKey, entries: [] };
        byMonth.set(monthKey, group);
        groups.push(group);
      }
      group.entries.push({ dateKey: entry.dateKey, snacks, workouts: resolveEntryWorkouts(entry) });
    });

  return groups;
}

function renderHistory() {
  const groups = getHistoryMonthGroups();
  const allSnacks = groups.flatMap((group) => group.entries.flatMap((entry) => entry.snacks));
  $("history-meta").textContent = `${groups.length} month${groups.length === 1 ? "" : "s"} / ${allSnacks.length} snacks / load ${getLoad(allSnacks)}`;

  $("history-list").innerHTML = groups.length
    ? groups
        .map((group) => {
          const monthOpen = state.expandedHistoryMonths.has(group.monthKey);
          const monthSnacks = group.entries.flatMap((entry) => entry.snacks);
          return `
            <section class="history-month">
              <button class="archive-month-toggle" data-history-month="${esc(group.monthKey)}" type="button" aria-expanded="${monthOpen}">
                <span class="archive-month-title">${esc(formatHistoryMonth(group.monthKey))}</span>
                <span class="archive-month-meta">${group.entries.length} days / ${monthSnacks.length} snacks / load ${getLoad(monthSnacks)}</span>
              </button>
              <div class="history-month-days" ${monthOpen ? "" : "hidden"}>
                ${group.entries
                  .map((entry) => {
                    const dayOpen = state.expandedHistoryDays.has(entry.dateKey);
                    const animateSpark = monthOpen && !state.animatedHistoryDays.has(entry.dateKey);
                    return `
                      <article class="history-day">
                        <button class="history-day-toggle" data-history-day="${esc(entry.dateKey)}" type="button" aria-expanded="${dayOpen}">
                          <span class="archive-date">${esc(formatShortDate(entry.dateKey))}</span>
                          <span class="archive-spark">${renderSparkBars(entry.snacks, "archive", "", animateSpark)}</span>
                          <span class="archive-meta">${entry.snacks.length} snacks / load ${getLoad(entry.snacks)}</span>
                        </button>
                        <div class="history-day-details" ${dayOpen ? "" : "hidden"}>${renderSessionGroups(entry.workouts)}</div>
                      </article>
                    `;
                  })
                  .join("")}
              </div>
            </section>
          `;
        })
        .join("")
    : '<p class="settings-empty">no history yet</p>';

  groups
    .filter((group) => state.expandedHistoryMonths.has(group.monthKey))
    .forEach((group) => group.entries.forEach((entry) => state.animatedHistoryDays.add(entry.dateKey)));
}

function toggleHistoryMonth(monthKey) {
  if (state.expandedHistoryMonths.has(monthKey)) state.expandedHistoryMonths.delete(monthKey);
  else state.expandedHistoryMonths.add(monthKey);
  renderHistory();
}

function toggleHistoryDay(dateKey) {
  if (state.expandedHistoryDays.has(dateKey)) state.expandedHistoryDays.delete(dateKey);
  else state.expandedHistoryDays.add(dateKey);
  renderHistory();
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

  if ($("view-history").classList.contains("active")) {
    renderHistory();
  }

}

function applyRemoteSnapshot(snapshot, version) {
  const hydrated = hydrateSnapshot(snapshot);
  state.history = hydrated.history;
  state.library = hydrated.library;
  state.editingIndex = null;
  state.editingIsNew = false;
  state.editingDraft = null;
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

  state.baseStack = pickStack(pool, state.filters.size);
  state.stack = [...state.baseStack];
  state.rounds = 1;
  renderPreview();
  showView("preview");
}

function rebuildWorkoutStack() {
  state.stack = Array.from({ length: state.rounds }, () => state.baseStack).flat();
}

function renderPreview() {
  $("preview-title").textContent = formatStackLabel(state.baseStack.length);
  $("preview-sub").textContent = describeFilters(state.filters);
  $("preview-rounds-options").innerHTML = [1, 2, 3, 4, 5]
    .map(
      (rounds) =>
        `<button class="chip ${state.rounds === rounds ? "active" : ""}" data-rounds="${rounds}" type="button" aria-pressed="${state.rounds === rounds}">${rounds}</button>`,
    )
    .join("");
  $("preview-list").innerHTML = state.baseStack
    .map(
      (exercise, index) => `
        <article class="preview-item">
          <span class="idx">${String(index + 1).padStart(2, "0")}</span>
          <div class="body">
            <div class="preview-name-row">
              <span class="day-bar-slot">
                <span class="day-bar cat-${esc(exercise.category)}" data-intensity="${exercise.intensity}"></span>
              </span>
              <p class="name">${esc(exercise.name)}</p>
            </div>
            <div class="meta">
              <span class="cue">${esc(exercise.tagline)}</span>
            </div>
          </div>
          <button class="preview-retry" data-action="retry-preview" data-index="${index}" type="button" aria-label="retry exercise ${index + 1}">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <path d="M3 3v5h5"></path>
            </svg>
          </button>
        </article>
      `,
    )
    .join("");
}

function retryPreviewExercise(index) {
  const baseIndex = index % state.baseStack.length;
  const currentExercise = state.baseStack[baseIndex];
  if (!currentExercise) return;

  const pool = filterExercises(state.library, state.filters);
  const usedIds = new Set(state.baseStack.map((exercise) => exercise.id));
  const unusedCandidates = pool.filter((exercise) => !usedIds.has(exercise.id));
  const candidates = unusedCandidates.length
    ? unusedCandidates
    : pool.filter((exercise) => exercise.id !== currentExercise.id);

  if (candidates.length === 0) {
    toast("no other snacks match those filters");
    return;
  }

  state.baseStack[baseIndex] = pickStack(candidates, 1)[0];
  state.stack = [...state.baseStack];
  renderPreview();
}

function setWorkoutRounds(rounds) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) return;
  state.rounds = rounds;
  renderPreview();
}

function renderFilterSection(targetId, scope, filters) {
  const heatOptions = [
    ["1", "easy"],
    ["2", "medium"],
    ["3", "hard"],
  ];
  const heatChips = heatOptions
    .map(([value, label]) => {
      const isActive = filters.intensities.includes(Number(value));
      return `<button class="chip ${isActive ? "active" : ""}" data-filter-scope="${scope}" data-filter-group="intensity" data-val="${value}" type="button" aria-pressed="${isActive}">${label}</button>`;
    })
    .join("");
  const flavourChips = CATEGORY_ORDER.map((category) => {
    const isActive = filters.categories.includes(category);
    return `<button class="chip ${isActive ? `active cat-${category}` : ""}" data-filter-scope="${scope}" data-filter-group="category" data-val="${category}" type="button" aria-pressed="${isActive}">${category}</button>`;
  }).join("");

  $(targetId).innerHTML = `
    <div class="chip-row ${scope === "library" ? "settings-chip-row" : ""}">
      <span class="row-label">Heat</span>
      <div class="chips">${heatChips}</div>
    </div>
    <div class="chip-row ${scope === "library" ? "settings-chip-row" : ""}">
      <span class="row-label">Flavour</span>
      <div class="chips">${flavourChips}</div>
    </div>
  `;
}

function renderFilterSheet() {
  const scope = state.filterSheetScope;
  if (!scope) return;

  const filters = scope === "library" ? state.settingsFilters : state.filters;
  renderFilterSection("filter-sheet-controls", scope, filters);
  $("filter-sheet-search").hidden = scope !== "library";
  $("filter-search-input").value = state.settingsFilters.query;
}

function openFilterSheet(scope) {
  if (state.linkPanelOpen) closeLinkPanel(true);
  if (state.adminPanelOpen) closeAdminPanel(true);
  window.clearTimeout(filterSheetTimer);
  state.filterSheetScope = scope;
  renderFilterSheet();

  const sheet = $("filter-sheet");
  sheet.hidden = false;
  document.body.classList.add("filter-sheet-open");
  $("more-toggle").setAttribute("aria-expanded", String(scope === "main"));
  $("settings-filter-toggle").setAttribute("aria-expanded", String(scope === "library"));
  window.requestAnimationFrame(() => sheet.classList.add("open"));
}

function closeFilterSheet(immediate = false) {
  const sheet = $("filter-sheet");
  window.clearTimeout(filterSheetTimer);
  sheet.classList.remove("open");
  document.body.classList.remove("filter-sheet-open");
  $("more-toggle").setAttribute("aria-expanded", "false");
  $("settings-filter-toggle").setAttribute("aria-expanded", "false");
  state.filterSheetScope = null;

  if (immediate) {
    sheet.hidden = true;
    return;
  }

  filterSheetTimer = window.setTimeout(() => {
    sheet.hidden = true;
  }, 300);
}

function toggleFilterSheet(scope) {
  if (state.filterSheetScope === scope && $("filter-sheet").classList.contains("open")) {
    closeFilterSheet();
    return;
  }

  openFilterSheet(scope);
}

function openAdminPanel() {
  if (state.filterSheetScope) closeFilterSheet(true);
  window.clearTimeout(adminPanelTimer);
  state.adminPanelOpen = true;
  const panel = $("admin-sheet");
  panel.hidden = false;
  document.body.classList.add("admin-sheet-open");
  $("admin-toggle").setAttribute("aria-expanded", "true");
  window.requestAnimationFrame(() => panel.classList.add("open"));
}

function closeAdminPanel(immediate = false) {
  const panel = $("admin-sheet");
  window.clearTimeout(adminPanelTimer);
  state.adminPanelOpen = false;
  panel.classList.remove("open");
  document.body.classList.remove("admin-sheet-open");
  $("admin-toggle").setAttribute("aria-expanded", "false");

  if (immediate) {
    panel.hidden = true;
    return;
  }

  adminPanelTimer = window.setTimeout(() => {
    panel.hidden = true;
  }, 300);
}

function toggleAdminPanel() {
  if (state.adminPanelOpen && $("admin-sheet").classList.contains("open")) {
    closeAdminPanel();
  } else {
    openAdminPanel();
  }
}

function openCancelPanel() {
  window.clearTimeout(cancelPanelTimer);
  state.cancelWasPaused = state.paused;
  if (!state.paused) togglePause();
  state.cancelPanelOpen = true;
  $("cancel-warning").textContent = "The workout will be cancelled and not recorded";
  const sheet = $("cancel-sheet");
  sheet.hidden = false;
  document.body.classList.add("cancel-sheet-open");
  window.requestAnimationFrame(() => sheet.classList.add("open"));
}

function closeCancelPanel(immediate = false, resume = true) {
  const sheet = $("cancel-sheet");
  window.clearTimeout(cancelPanelTimer);
  sheet.classList.remove("open");
  document.body.classList.remove("cancel-sheet-open");
  state.cancelPanelOpen = false;

  if (resume && !state.cancelWasPaused && state.paused) togglePause();
  state.cancelWasPaused = false;

  if (immediate) {
    sheet.hidden = true;
    return;
  }

  cancelPanelTimer = window.setTimeout(() => {
    sheet.hidden = true;
  }, 300);
}

function confirmCancelWorkout() {
  closeCancelPanel(true, false);
  quitRun();
}

function renderSettings() {
  const visibleSnacks = getVisibleLibrarySnacks();
  const hasActiveFilters =
    state.settingsFilters.categories.length !== CATEGORY_ORDER.length ||
    state.settingsFilters.intensities.length !== 3 ||
    state.settingsFilters.query.trim().length > 0;

  const totalActive = state.library.filter((exercise) => !exercise.deleted).length;
  $("settings-count").textContent = formatSettingsCount(visibleSnacks.length, totalActive, hasActiveFilters);
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
                  aria-label="play ${esc(exercise.name || "exercise") }"
                >
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path>
                  </svg>
                </button>
                <button class="settings-enabled-toggle" data-action="toggle-snack-enabled" data-index="${index}" type="button" aria-label="${exercise.enabled === false ? "enable" : "disable"} ${esc(exercise.name || "exercise")}" aria-pressed="${exercise.enabled !== false}">
                  ${exercise.enabled === false
                    ? '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="3"></circle><rect width="20" height="14" x="2" y="5" rx="7"></rect></svg>'
                    : '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="12" r="3"></circle><rect width="20" height="14" x="2" y="5" rx="7"></rect></svg>'}
                </button>
              </article>
            `,
          )
          .join("");
}

function getVisibleLibrarySnacks() {
  const query = state.settingsFilters.query.trim().toLowerCase();

  return state.library
    .map((exercise, index) => ({ exercise, index }))
    .filter(({ exercise }) => {
      if (exercise.deleted) return false;
      const matchesCategory = state.settingsFilters.categories.includes(exercise.category);
      const matchesIntensity = state.settingsFilters.intensities.includes(exercise.intensity);
      const matchesQuery = !query || exercise.name.toLowerCase().includes(query);
      return matchesCategory && matchesIntensity && matchesQuery;
    })
    .reverse();
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
  const exercise = state.editingDraft;

  document.body.classList.toggle("settings-overlay-open", Boolean(exercise));

  if (!exercise) {
    overlay.classList.remove("open");
    window.clearTimeout(editorPanelTimer);
    editorPanelTimer = window.setTimeout(() => {
      overlay.hidden = true;
    }, 300);
    return;
  }

  window.clearTimeout(editorPanelTimer);
  overlay.hidden = false;
  window.requestAnimationFrame(() => overlay.classList.add("open"));

  $("settings-name-input").value = exercise.name;
  $("settings-tagline-input").value = exercise.tagline;
  $("settings-dialog-title").textContent = state.editingIsNew ? "add snack" : "edit snack";
  $("settings-heat-chips").innerHTML = [
    [1, "easy"],
    [2, "medium"],
    [3, "hard"],
  ]
    .map(
      ([value, label]) =>
        `<button class="chip ${exercise.intensity === value ? "active" : ""}" data-editor-field="intensity" data-val="${value}" type="button" aria-pressed="${exercise.intensity === value}">${label}</button>`,
    )
    .join("");
  $("settings-flavour-chips").innerHTML = CATEGORY_ORDER.map(
    (category) =>
      `<button class="chip ${exercise.category === category ? `active cat-${category}` : ""}" data-editor-field="category" data-val="${category}" type="button" aria-pressed="${exercise.category === category}">${category}</button>`,
  ).join("");
  $("settings-dialog-name").textContent = exercise.name || "untitled snack";
  $("settings-dialog-tagline").textContent = exercise.tagline || "add a tagline";
  $("settings-edit-bar").className = `day-bar cat-${exercise.category}`;
  $("settings-edit-bar").dataset.intensity = String(exercise.intensity);
  $("settings-remove-btn").hidden = state.editingIsNew;
  $("settings-remove-btn").disabled = state.library.filter((item) => !item.deleted).length <= 1;
}

function runSingleSnack(index) {
  const exercise = state.library[index];
  if (!exercise) {
    return;
  }
  state.baseStack = [exercise];
  state.stack = [...state.baseStack];
  state.rounds = 1;
  beginRun();
}

function beginRun() {
  if (state.baseStack.length === 0) {
    toast("shake the jar first");
    return;
  }

  initAudio();
  rebuildWorkoutStack();
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

  const snackIndex = (state.runIdx % state.baseStack.length) + 1;
  const roundIndex = Math.floor(state.runIdx / state.baseStack.length) + 1;
  $("timer-step").textContent = `snack ${snackIndex} / ${state.baseStack.length}`;
  $("timer-round").textContent = `round ${roundIndex} / ${state.rounds}`;
  $("timer-round").hidden = state.rounds <= 1;
  $("timer-category").textContent = snack.category;
  $("timer-category").className = `timer-category cat-${snack.category}`;
  $("timer-name").textContent = snack.name;
  $("timer-intensity").innerHTML = renderIntensityPips(snack.intensity, snack.category);
  renderTimerStack("timer-stack");
  $("timer-fill").className = `timer-progress-fill cat-${snack.category}`;

  state.secondsLeft = SNACK_DURATION;
  state.snackEndTime = Date.now() + SNACK_DURATION * 1000;
  state.paused = false;
  renderPauseButtons();

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
  renderTimerStack("rest-stack");

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

function skipRest() {
  clearInterval(state.restHandle);
  showView("run");
  startSnack();
}

function renderTimerStack(targetId) {
  const currentIndex = state.runIdx % state.baseStack.length;
  const roundStart = state.runIdx - currentIndex;
  $(targetId).innerHTML = state.baseStack
    .map((snack, index) => ({ snack, index }))
    .filter(({ index }) => !(index < currentIndex && state.completed[roundStart + index]?.skipped))
    .map(({ snack, index }) => {
      const cls = index < currentIndex ? "is-done" : index === currentIndex ? "is-current" : "";
      return `<li class="timer-stack-item${cls ? ` ${cls}` : ""}">${esc(snack.name)}</li>`;
    })
    .join("");
}

function finishRun() {
  const entry = todayEntry();
  entry.workouts.push({
    id: state.currentStackId,
    at: state.completed[0]?.at || new Date().toISOString(),
    rounds: state.rounds,
    exercises: state.completed.map((exercise) => ({ ...exercise })),
  });
  save();
  renderDone();
  showView("done");
}

function renderDone() {
  const completed = resolveSnacks(state.completed, state.library).filter((snack) => !snack.skipped);
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
  renderPauseButtons();
}

function renderPauseButtons() {
  const icon = state.paused
    ? '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>'
    : '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="4" width="4" height="16" rx="1"></rect><rect x="6" y="4" width="4" height="16" rx="1"></rect></svg>';

  [$("btn-pause"), $("rest-btn-pause")].forEach((button) => {
    button.innerHTML = icon;
    button.setAttribute("aria-label", state.paused ? "resume" : "pause");
    button.classList.toggle("pause-active", state.paused);
  });
}

function skipSnack() {
  completeCurrentSnack(true);
}

function quitRun() {
  clearInterval(state.timerHandle);
  clearInterval(state.restHandle);
  renderHome();
  showView("home");
}

function openSettings() {
  renderSettings();
  renderSettingsEditor();
  showView("settings");
}

function goHome() {
  state.editingIndex = null;
  state.editingIsNew = false;
  state.editingDraft = null;
  renderSettingsEditor();
  renderHome();
  showView("home");
}

async function toggleLinkPanel() {
  if (state.linkPanelOpen) {
    closeLinkPanel();
    return;
  }

  if (state.filterSheetScope) closeFilterSheet(true);
  state.linkPanelOpen = true;
  renderLinkPanel();

  if (state.sync.code || state.linkBusy) {
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
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest("[data-filter-scope]");
    if (!(chip instanceof HTMLButtonElement)) return;

    const filters = chip.dataset.filterScope === "library" ? state.settingsFilters : state.filters;
    const group = chip.dataset.filterGroup;
    const rawValue = chip.dataset.val;
    if (!group || !rawValue) return;

    if (group === "category") {
      filters.categories = filters.categories.includes(rawValue)
        ? filters.categories.filter((category) => category !== rawValue)
        : [...filters.categories, rawValue];
    } else {
      const intensity = Number(rawValue);
      filters.intensities = filters.intensities.includes(intensity)
        ? filters.intensities.filter((value) => value !== intensity)
        : [...filters.intensities, intensity].sort();
    }

    if (chip.dataset.filterScope === "library") {
      renderSettings();
    }
    renderFilterSheet();
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

function openSnackEditor(index, draft = null) {
  const source = draft || (Number.isInteger(index) ? state.library[index] : null);
  if (!source) {
    return;
  }

  state.editingIndex = Number.isInteger(index) ? index : null;
  state.editingIsNew = !Number.isInteger(index);
  state.editingDraft = { ...source };
  renderSettingsEditor();
  window.requestAnimationFrame(() => {
    $("settings-name-input").focus();
  });
}

function closeSnackEditor() {
  state.editingIndex = null;
  state.editingIsNew = false;
  state.editingDraft = null;
  renderSettings();
  renderSettingsEditor();
}

function updateEditorDraft(field, value) {
  if (!state.editingDraft) return;
  state.editingDraft[field] = field === "intensity" ? Number(value) : value;
  renderSettingsEditor();
}

function saveSnackEditor() {
  if (!state.editingDraft) return;

  if (state.editingIsNew) {
    state.library.push({ ...state.editingDraft });
  } else if (state.editingIndex != null && state.library[state.editingIndex]) {
    state.library[state.editingIndex] = {
      ...state.library[state.editingIndex],
      ...state.editingDraft,
    };
  }

  save();
  closeSnackEditor();
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

function addSnack() {
  const exercise = createEmptyExercise();
  if (state.settingsFilters.categories.length === 1) {
    exercise.category = state.settingsFilters.categories[0];
  }
  if (state.settingsFilters.intensities.length === 1) {
    exercise.intensity = state.settingsFilters.intensities[0];
  }

  openSnackEditor(null, exercise);
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
    state.editingIsNew = false;
    state.editingDraft = null;
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

      const existing = entriesByDate.get(dateKey) || { dateKey, workouts: [] };
      const workouts = Array.isArray(entry.workouts)
        ? entry.workouts.map((workout) => hydrateWorkout(workout))
        : legacySnacksToWorkouts(entry.snacks);
      const existingIds = new Set(existing.workouts.map((workout) => workout.id));
      workouts.forEach((workout) => {
        if (existingIds.has(workout.id)) return;
        existing.workouts.push(workout);
        existingIds.add(workout.id);
      });
      entriesByDate.set(dateKey, existing);
    });

  return sortHistoryDescending([...entriesByDate.values()]);
}

function legacySnacksToWorkouts(snacks) {
  const workouts = [];
  (Array.isArray(snacks) ? snacks : []).forEach((source) => {
    const id = String(source?.stack || source?.at || `legacy-${workouts.length}`);
    let workout = workouts.find((item) => item.id === id);
    if (!workout) {
      workout = {
        id,
        at: source?.at ? String(source.at) : null,
        rounds: Math.max(1, Math.min(5, Number(source?.rounds) || 1)),
        exercises: [],
      };
      workouts.push(workout);
    }
    workout.exercises.push(hydrateSnack(source));
  });
  return workouts;
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

function remapHistoryEntries(history, idMap) {
  return history.map((entry) => ({
    dateKey: entry.dateKey,
    workouts: entry.workouts.map((workout) => ({
      ...workout,
      exercises: workout.exercises.map((exercise) => ({
        ...exercise,
        id: idMap.get(exercise.id) || exercise.id,
      })),
    })),
  }));
}

function overwriteImportedHistory(importedHistory) {
  return {
    history: sortHistoryDescending(importedHistory),
    addedDays: importedHistory.length,
    addedSnacks: importedHistory.reduce(
      (total, entry) => total + entry.workouts.reduce((sum, workout) => sum + workout.exercises.length, 0),
      0,
    ),
  };
}

function mergeImportedHistory(baseHistory, importedHistory) {
  const entriesByDate = new Map(
    baseHistory.map((entry) => [
      entry.dateKey,
      {
        dateKey: entry.dateKey,
        workouts: entry.workouts.map((workout) => ({
          ...workout,
          exercises: workout.exercises.map((exercise) => ({ ...exercise })),
        })),
      },
    ]),
  );
  let addedDays = 0;
  let addedSnacks = 0;

  importedHistory.forEach((importedEntry) => {
    let entry = entriesByDate.get(importedEntry.dateKey);
    if (!entry) {
      entry = { dateKey: importedEntry.dateKey, workouts: [] };
      entriesByDate.set(importedEntry.dateKey, entry);
      addedDays += 1;
    }

    const existingWorkoutIds = new Set(entry.workouts.map((workout) => workout.id));
    importedEntry.workouts.forEach((workout) => {
      if (existingWorkoutIds.has(workout.id)) return;
      entry.workouts.push({
        ...workout,
        exercises: workout.exercises.map((exercise) => ({ ...exercise })),
      });
      existingWorkoutIds.add(workout.id);
      addedSnacks += workout.exercises.length;
    });
  });

  return { history: sortHistoryDescending([...entriesByDate.values()]), addedDays, addedSnacks };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffled(values) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function populateRandomHistory() {
  const pool = state.library.filter((exercise) => !exercise.deleted && exercise.enabled !== false);
  if (pool.length === 0) throw new Error("No enabled exercises are available.");

  const now = new Date();
  const existingDates = new Set(state.history.map((entry) => entry.dateKey));
  const summary = { months: 6, days: 0, sessions: 0, snacks: 0 };

  for (let monthOffset = 0; monthOffset < 6; monthOffset += 1) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1, 12);
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const lastEligibleDay = monthOffset === 0 ? Math.max(0, now.getDate() - 1) : daysInMonth;
    const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const existingMonthDays = [...existingDates].filter((dateKey) => dateKey.startsWith(monthKey)).length;
    const targetDays = Math.min(lastEligibleDay, randomInt(10, 20));
    const availableDays = shuffled(
      Array.from({ length: lastEligibleDay }, (_, index) => index + 1).filter((day) => {
        const dateKey = toDateKey(new Date(year, month, day, 12));
        return !existingDates.has(dateKey);
      }),
    );

    availableDays.slice(0, Math.max(0, targetDays - existingMonthDays)).forEach((day) => {
      const dateKey = toDateKey(new Date(year, month, day, 12));
      const entry = ensureHistoryEntry(state.history, dateKey);
      const sessionCount = randomInt(3, 7);

      for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
        const hour = 7 + Math.floor((sessionIndex * 14) / sessionCount) + randomInt(0, 1);
        const minute = randomInt(0, 11) * 5;
        const at = new Date(year, month, day, Math.min(hour, 21), minute).toISOString();
        const stack = `dev-${dateKey}-${sessionIndex}-${Math.random().toString(36).slice(2, 7)}`;
        const sessionSize = [1, 3, 5][randomInt(0, 2)];
        const exercises = pickStack(pool, Math.min(sessionSize, pool.length));

        entry.workouts.push({
          id: stack,
          at,
          rounds: 1,
          exercises: exercises.map((exercise) => ({
            id: exercise.id,
            at,
            skipped: Math.random() < 0.06,
          })),
        });
        summary.sessions += 1;
        summary.snacks += exercises.length;
      }

      existingDates.add(dateKey);
      summary.days += 1;
    });
  }

  state.history = sortHistoryDescending(state.history);
  save();
  renderHome();
  renderHistory();
  return summary;
}

window.snaxDev = {
  ...(window.snaxDev || {}),
  populateHistory: populateRandomHistory,
};

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
  $("link-panel-close").addEventListener("click", () => closeLinkPanel());
  $("link-sheet-scrim").addEventListener("click", () => closeLinkPanel());
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
  $("preview-list").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const retryButton = target?.closest('[data-action="retry-preview"]');
    if (!(retryButton instanceof HTMLButtonElement)) return;
    retryPreviewExercise(Number(retryButton.dataset.index));
  });
  $("preview-rounds-options").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("[data-rounds]");
    if (!(button instanceof HTMLButtonElement)) return;
    setWorkoutRounds(Number(button.dataset.rounds));
  });
  $("btn-pause").addEventListener("click", togglePause);
  $("rest-btn-pause").addEventListener("click", togglePause);
  $("rest-btn-skip").addEventListener("click", skipRest);
  $("btn-skip").addEventListener("click", skipSnack);
  $("timer-quit").addEventListener("click", openCancelPanel);
  $("rest-cancel").addEventListener("click", openCancelPanel);
  $("cancel-panel-close").addEventListener("click", () => closeCancelPanel());
  $("cancel-sheet-scrim").addEventListener("click", () => closeCancelPanel());
  $("cancel-confirm").addEventListener("click", confirmCancelWorkout);
  $("add-snack-btn").addEventListener("click", addSnack);
  $("export-json-btn").addEventListener("click", exportJson);
  $("import-json-btn").addEventListener("click", () => {
    closeAdminPanel();
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
  $("settings-save-btn").addEventListener("click", saveSnackEditor);
  $("settings-overlay-scrim").addEventListener("click", closeSnackEditor);
  $("settings-remove-btn").addEventListener("click", () => {
    if (state.editingIndex != null) {
      deleteSnack(state.editingIndex);
    }
  });
  $("settings-name-input").addEventListener("input", (event) => {
    updateEditorDraft("name", event.target.value);
  });
  $("settings-tagline-input").addEventListener("input", (event) => {
    updateEditorDraft("tagline", event.target.value);
  });
  $("settings-overlay").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const chip = target?.closest("[data-editor-field]");
    if (!(chip instanceof HTMLButtonElement) || !state.editingDraft) return;
    updateEditorDraft(chip.dataset.editorField, chip.dataset.val);
  });
  $("filter-search-input").addEventListener("input", (event) => {
    state.settingsFilters.query = event.target.value;
    renderSettings();
  });
  document.querySelectorAll('[data-action="home"]').forEach((button) => {
    button.addEventListener("click", goHome);
  });

  window.addEventListener("scroll", syncFloatingBackButton, { passive: true });

  $("more-toggle").addEventListener("click", () => toggleFilterSheet("main"));
  $("settings-filter-toggle").addEventListener("click", () => toggleFilterSheet("library"));
  $("admin-toggle").addEventListener("click", toggleAdminPanel);
  $("admin-panel-close").addEventListener("click", () => closeAdminPanel());
  $("admin-sheet-scrim").addEventListener("click", () => closeAdminPanel());
  $("filter-panel-close").addEventListener("click", () => closeFilterSheet());
  $("filter-sheet-scrim").addEventListener("click", () => closeFilterSheet());

  $("bottom-toolbar").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("[data-tab]");
    if (!(button instanceof HTMLButtonElement)) return;

    if (button.dataset.tab === "settings") {
      openSettings();
    } else if (button.dataset.tab === "home") {
      goHome();
    } else if (button.dataset.tab === "history") {
      renderHistory();
      showView("history");
    }
  });

  $("history-list").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const monthButton = target?.closest("[data-history-month]");
    if (monthButton instanceof HTMLButtonElement) {
      toggleHistoryMonth(monthButton.dataset.historyMonth);
      return;
    }

    const dayButton = target?.closest("[data-history-day]");
    if (dayButton instanceof HTMLButtonElement) {
      toggleHistoryDay(dayButton.dataset.historyDay);
    }
  });

  $("settings-list").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const toggleBtn = target ? target.closest('[data-action="toggle-snack-enabled"]') : null;
    if (toggleBtn instanceof HTMLButtonElement) {
      const index = Number(toggleBtn.dataset.index);
      const exercise = state.library[index];
      if (exercise) updateLibraryField(index, "enabled", exercise.enabled === false);
      return;
    }
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
  document.addEventListener("keydown", (event) => {
    if (state.cancelPanelOpen && event.key === "Escape") {
      event.preventDefault();
      closeCancelPanel();
      return;
    }

    if (state.adminPanelOpen && event.key === "Escape") {
      event.preventDefault();
      closeAdminPanel();
      return;
    }

    if (state.filterSheetScope && event.key === "Escape") {
      event.preventDefault();
      closeFilterSheet();
      return;
    }

    if (state.linkPanelOpen && event.key === "Escape") {
      event.preventDefault();
      closeLinkPanel();
      return;
    }

    if (state.pendingImport && event.key === "Escape") {
      event.preventDefault();
      closeImportDialog();
      return;
    }

    if (state.editingDraft && event.key === "Escape") {
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

      if (event.key === "Escape") {
        event.preventDefault();
        openCancelPanel();
      }
    }

    if ($("view-rest").classList.contains("active") && event.key === "Escape") {
      event.preventDefault();
      openCancelPanel();
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
