const POLL_INTERVAL_MS = 4000;
const RETRY_MIN_MS = 1500;
const RETRY_MAX_MS = 12000;

export class SnaxSync {
  constructor({ settings, deviceId, code, getVersion, getSnapshot, applyRemote, onStatus, onError }) {
    this.settings = settings;
    this.deviceId = deviceId;
    this.code = normalizeCode(code);
    this.getVersion = getVersion;
    this.getSnapshot = getSnapshot;
    this.applyRemote = applyRemote;
    this.onStatus = onStatus;
    this.onError = onError;
    this.pollTimer = null;
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
    this.inFlight = false;
    this.queued = false;
    this.stopped = true;
  }

  start(code = this.code) {
    this.code = normalizeCode(code);
    this.stop();
    this.stopped = false;

    if (!this.settings.syncBaseUrl || !this.code) {
      this.setStatus("local");
      return;
    }

    this.setStatus("syncing");
    this.syncNow();
    this.pollTimer = globalThis.setInterval(() => {
      this.syncNow();
    }, POLL_INTERVAL_MS);
  }

  stop() {
    this.stopped = true;
    this.inFlight = false;
    this.queued = false;
    globalThis.clearInterval(this.pollTimer);
    globalThis.clearTimeout(this.retryTimer);
    this.pollTimer = null;
    this.retryTimer = null;
  }

  flush() {
    if (this.stopped || !this.settings.syncBaseUrl || !this.code) {
      return;
    }

    this.syncNow();
  }

  async syncNow() {
    if (this.stopped || !this.settings.syncBaseUrl || !this.code) {
      return;
    }

    if (this.inFlight) {
      this.queued = true;
      return;
    }

    this.inFlight = true;
    this.queued = false;
    this.setStatus("syncing");
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = null;

    try {
      const payload = await syncRoom(this.settings.syncBaseUrl, this.code, {
        deviceId: this.deviceId,
        version: this.getVersion(),
        snapshot: this.getSnapshot(),
      });

      if (compareVersions(payload.version, this.getVersion()) > 0) {
        this.applyRemote(payload.snapshot, payload.version, payload.updatedBy || "");
      }

      this.retryDelay = RETRY_MIN_MS;
      this.setStatus("synced");
    } catch (error) {
      this.setStatus("offline");
      this.onError?.(error instanceof Error ? error.message : "Sync failed.");
      this.scheduleRetry();
    } finally {
      this.inFlight = false;
      if (this.queued && !this.stopped) {
        this.syncNow();
      }
    }
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) {
      return;
    }

    this.retryTimer = globalThis.setTimeout(() => {
      this.retryTimer = null;
      this.syncNow();
    }, this.retryDelay);

    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  setStatus(status) {
    this.onStatus?.(status);
  }
}

export async function createLinkRoom(baseUrl, input) {
  const response = await fetch(joinUrl(baseUrl, "/api/link"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: input.deviceId,
      version: input.version,
      snapshot: input.snapshot,
    }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Link could not be prepared."));
  }

  return response.json();
}

export async function fetchLinkState(baseUrl, code) {
  const response = await fetch(joinUrl(baseUrl, `/api/link/${normalizeCode(code)}/state`));
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Link is invalid."));
  }

  return response.json();
}

export function buildDeviceLink(locationHref, code) {
  const url = new URL(locationHref);
  url.searchParams.set("link", normalizeCode(code));
  return url.toString();
}

export function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

export function nextClock(clock, deviceId) {
  const current = normalizeClock(clock);
  const now = Date.now();

  if (now > current.wallTime) {
    const next = { wallTime: now, counter: 0 };
    return { clock: next, version: formatVersion(next, deviceId) };
  }

  const next = { wallTime: current.wallTime, counter: current.counter + 1 };
  return { clock: next, version: formatVersion(next, deviceId) };
}

export function observeClock(clock, version) {
  const current = normalizeClock(clock);
  const incoming = parseVersion(version);

  if (incoming.wallTime > current.wallTime) {
    return { wallTime: incoming.wallTime, counter: incoming.counter };
  }

  if (incoming.wallTime === current.wallTime && incoming.counter > current.counter) {
    return { wallTime: incoming.wallTime, counter: incoming.counter };
  }

  return current;
}

async function syncRoom(baseUrl, code, input) {
  const response = await fetch(joinUrl(baseUrl, `/api/link/${normalizeCode(code)}/sync`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: input.deviceId,
      version: input.version,
      snapshot: input.snapshot,
    }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, "Sync failed."));
  }

  return response.json();
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${path}`;
}

function formatVersion(clock, deviceId) {
  return `${String(clock.wallTime).padStart(13, "0")}:${String(clock.counter).padStart(4, "0")}:${deviceId}`;
}

function parseVersion(value) {
  const [wallTime = "0", counter = "0", deviceId = ""] = String(value || "").split(":");
  return {
    wallTime: Number(wallTime) || 0,
    counter: Number(counter) || 0,
    deviceId: String(deviceId || ""),
  };
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? Number(clock.wallTime) : 0,
    counter: Number.isFinite(clock?.counter) ? Number(clock.counter) : 0,
  };
}

async function getErrorMessage(response, fallback) {
  try {
    const payload = await response.json();
    if (typeof payload?.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
  } catch {
    // Ignore invalid JSON errors.
  }

  return fallback;
}
