import { createDefaultLibrary, createSeedHistory, hydrateLibrary, hydrateSnack, sortHistoryDescending } from "./model.js";

const STORAGE_KEY = "snax.app-state.v4";
const EMPTY_CLOCK = { wallTime: 0, counter: 0 };

function fallbackState() {
  return {
    history: createSeedHistory(),
    library: createDefaultLibrary(),
    deviceId: createDeviceId(),
    clock: { ...EMPTY_CLOCK },
    sync: createSyncState(),
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return createSeedHistory();
  }

  const normalized = history
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      dateKey: String(entry.dateKey || entry.date || ""),
      snacks: Array.isArray(entry.snacks) ? entry.snacks.map((snack) => hydrateSnack(snack)) : [],
    }))
    .filter((entry) => entry.dateKey);

  return normalized.length > 0 ? sortHistoryDescending(normalized) : createSeedHistory();
}

export function hydrateSnapshot(snapshot) {
  return {
    history: normalizeHistory(snapshot?.history),
    library: hydrateLibrary(snapshot?.library),
  };
}

export function loadAppState() {
  if (typeof window === "undefined") {
    return fallbackState();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallbackState();
    }

    const parsed = JSON.parse(raw);
    return {
      ...hydrateSnapshot(parsed),
      deviceId: normalizeDeviceId(parsed.deviceId),
      clock: normalizeClock(parsed.clock),
      sync: normalizeSyncState(parsed.sync),
    };
  } catch {
    return fallbackState();
  }
}

export function saveAppState(appState) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      history: appState.history,
      library: appState.library,
      deviceId: appState.deviceId,
      clock: normalizeClock(appState.clock),
      sync: normalizeSyncState(appState.sync),
    }),
  );
}

export function loadSettings() {
  return {
    syncBaseUrl: getConfiguredSyncBaseUrl() || getDefaultSyncBaseUrl(),
  };
}

function createDeviceId() {
  return `snax-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function normalizeDeviceId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : createDeviceId();
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? Number(clock.wallTime) : 0,
    counter: Number.isFinite(clock?.counter) ? Number(clock.counter) : 0,
  };
}

function createSyncState(input = {}) {
  return {
    code: normalizeCode(input.code),
    stateVersion: typeof input.stateVersion === "string" ? input.stateVersion : "",
  };
}

function normalizeSyncState(input = {}) {
  return createSyncState(input);
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getConfiguredSyncBaseUrl() {
  const value = globalThis.SNAX_CONFIG?.syncBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function getDefaultSyncBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || host === "localhost") {
    return "http://localhost:8797";
  }

  if (host === "127.0.0.1") {
    return "http://127.0.0.1:8797";
  }

  if (isPrivateNetworkHost(host)) {
    return `${protocol || "http:"}//${host}:8797`;
  }

  return "";
}

function isPrivateNetworkHost(host) {
  if (!host) return false;
  if (host.endsWith(".local")) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}
