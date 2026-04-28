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
  pickStack,
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
};

const $ = (id) => document.getElementById(id);
const CATEGORY_COLOR_CLASSES = CATEGORY_ORDER.map((category) => `cat-${category}`);
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

function beepRestCountdown() {
  beep(880, 0.08, 0);
  beep(880, 0.08, 0.25);
  beep(880, 0.35, 0.5);
}

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
  const snacks = entry ? entry.snacks : [];
  const panel = $("today-panel");
  $("today-meta").textContent = formatMetaText(snacks);
  $("today-spark").innerHTML = renderSparkBars(snacks, "today", "quiet so far");
  panel.classList.toggle("clickable", snacks.length > 0);
}

function renderArchive() {
  const entries = state.history.filter((entry) => entry.snacks.length > 0).slice(0, 7);
  const archiveSection = $("archive-section");

  archiveSection.hidden = entries.length === 0;
  if (entries.length === 0) {
    $("archive-list").innerHTML = "";
    $("archive-stats").textContent = "";
    return;
  }

  const stats = summarizeEntries(entries);

  $("archive-stats").textContent = `${stats.count} snacks / load ${stats.load}`;
  $("archive-list").innerHTML = entries
    .map(
      (entry) => `
        <div class="archive-row has-snacks" data-date="${esc(entry.dateKey)}">
          <span class="archive-date">${esc(formatShortDate(entry.dateKey))}</span>
          <div class="archive-spark">${renderSparkBars(entry.snacks, "archive", "")}</div>
        </div>
      `,
    )
    .join("");
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
  $("settings-count").textContent = formatSettingsCount(visibleSnacks.length, state.library.length, hasActiveFilters);
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
  $("settings-remove-btn").disabled = state.library.length === 1;
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
  state.paused = false;
  $("btn-pause").textContent = "pause";
  $("btn-pause").classList.remove("pause-active");

  updateTimerDisplay();
  state.timerHandle = window.setInterval(tickSnack, 1000);
}

function tickSnack() {
  if (state.paused) {
    return;
  }

  state.secondsLeft -= 1;
  updateTimerDisplay();

  if (state.secondsLeft === 30) beep(660, 0.08);
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
    ...state.stack[state.runIdx],
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

  let seconds = REST_DURATION;
  $("rest-seconds").textContent = String(seconds);
  $("rest-next-name").textContent = state.stack[state.runIdx].name;
  $("rest-fill").style.transform = "scaleX(0)";

  state.restHandle = window.setInterval(() => {
    seconds -= 1;
    $("rest-seconds").textContent = String(seconds);
    $("rest-fill").style.transform = `scaleX(${1 - seconds / REST_DURATION})`;

    if (seconds === 3) beepRestCountdown();
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
  $("done-title").textContent = `${formatSizeLabel(state.completed.length)} complete`;
  $("done-spark").innerHTML = renderSparkBars(state.completed, "done", "");
  $("done-list").innerHTML = state.completed
    .map(
      (snack, index) => `
        <div class="done-list-item">
          <span>${String(index + 1).padStart(2, "0")}. ${esc(snack.name)}</span>
          <span class="meta cat-tag cat-${esc(snack.category)}">${esc(snack.category)} / ${snack.intensity}</span>
        </div>
      `,
    )
    .join("");
  $("done-stats").textContent = `load ${getLoad(state.completed)}`;
}

function togglePause() {
  state.paused = !state.paused;
  $("btn-pause").textContent = state.paused ? "resume" : "pause";
  $("btn-pause").classList.toggle("pause-active", state.paused);
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

  $("day-title").textContent = formatDayTitle(dateKey);
  $("day-sub").textContent = `${formatMonthDay(dateKey)} / ${entry.snacks.length} snack${entry.snacks.length === 1 ? "" : "s"} / load ${getLoad(entry.snacks)}`;
  $("day-hero-spark").innerHTML = renderSparkBars(entry.snacks, "day", "");
  $("day-list").innerHTML = groupByStack(entry.snacks)
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
  if (state.library.length === 1) {
    toast("keep at least one snack");
    return;
  }

  state.library.splice(index, 1);
  save();
  if (state.editingIndex === index) {
    state.editingIndex = null;
  } else if (state.editingIndex != null && state.editingIndex > index) {
    state.editingIndex -= 1;
  }
  renderSettings();
  renderSettingsEditor();
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
  $("btn-skip").addEventListener("click", skipSnack);
  $("timer-quit").addEventListener("click", quitRun);
  $("add-snack-btn").addEventListener("click", addSnack);
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
