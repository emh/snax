import { createSeedHistory, hydrateSnack, sortHistoryDescending } from "./model.js";

const STORAGE_KEY = "snax.app-state.v1";

function fallbackState() {
  return {
    history: createSeedHistory(),
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
      history: normalizeHistory(parsed.history),
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
    }),
  );
}

