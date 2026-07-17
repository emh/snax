const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const INTERNAL_CREATE_HEADER = "X-Snax-Internal-Create";
const ROOM_KEY = "link-room";

export class SnaxLinkRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const route = parseRoomRoute(new URL(request.url).pathname);
    if (!route) {
      return json({ error: "Not found" }, 404, cors);
    }

    try {
      if (route.action === "init" && request.method === "POST") {
        return this.initializeRoom(request, route.code, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        return json(publicRoom(await this.requireRoom()), 200, cors);
      }

      if (route.action === "sync" && request.method === "POST") {
        return this.syncRoom(request, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: error?.message || "Request failed" }, error?.status || 400, cors);
    }
  }

  async initializeRoom(request, code, cors) {
    if (request.headers.get(INTERNAL_CREATE_HEADER) !== "1") {
      return json({ error: "Not found" }, 404, cors);
    }

    const existing = await this.getRoom();
    if (existing) {
      return json({ error: "Link already exists" }, 409, cors);
    }

    const body = await request.json();
    const room = normalizeRoom({
      code,
      version: body?.version,
      updatedBy: body?.deviceId,
      snapshot: body?.snapshot,
    });

    await this.state.storage.put(ROOM_KEY, room);
    return json(publicRoom(room), 200, cors);
  }

  async syncRoom(request, cors) {
    const room = await this.requireRoom();
    const body = await request.json();
    const input = normalizeSyncInput(body);
    const hasLocalChanges = Boolean(input.baseVersion) && input.baseVersion !== input.version;
    const isNewer = input.version && compareVersions(input.version, room.version) > 0;

    if (input.version && (isNewer || hasLocalChanges)) {
      room.snapshot = mergeSnapshots(room.snapshot, input.snapshot, {
        incomingWins: isNewer,
        replaceFavourites: input.hasFavourites && isNewer,
      });
      room.version = nextServerVersion(maxVersion(room.version, input.version));
      room.updatedBy = input.deviceId;
      room.updatedAt = Date.now();
      await this.state.storage.put(ROOM_KEY, room);
    }

    return json(publicRoom(room), 200, cors);
  }

  async getRoom() {
    return this.state.storage.get(ROOM_KEY);
  }

  async requireRoom() {
    const room = await this.getRoom();
    if (!room) {
      throw responseError(404, "Link not found.");
    }

    return normalizeRoom(room);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const route = parseRootRoute(new URL(request.url).pathname);
    if (!route) {
      return json({ error: "Not found" }, 404, cors);
    }

    try {
      if (route.action === "create" && request.method === "POST") {
        return createRoomWithFreshCode(request, env, cors);
      }

      const id = env.SNAX_LINK_ROOM.idFromName(route.code);
      const stub = env.SNAX_LINK_ROOM.get(id);
      const response = await stub.fetch(request);
      return withCors(response, cors);
    } catch (error) {
      return json({ error: error?.message || "Request failed" }, error?.status || 400, cors);
    }
  },
};

async function createRoomWithFreshCode(request, env, cors) {
  const body = await request.text();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const id = env.SNAX_LINK_ROOM.idFromName(code);
    const stub = env.SNAX_LINK_ROOM.get(id);
    const response = await stub.fetch(
      new Request(`https://internal/api/link/${code}/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_CREATE_HEADER]: "1",
        },
        body,
      }),
    );

    if (response.status === 409) {
      continue;
    }

    return withCors(response, cors);
  }

  return json({ error: "Link could not be created." }, 500, cors);
}

function parseRootRoute(pathname) {
  if (pathname === "/api/link") {
    return { action: "create", code: "" };
  }

  const match = /^\/api\/link\/([A-Za-z0-9]+)\/(state|sync)$/.exec(pathname);
  if (!match) {
    return null;
  }

  return {
    action: match[2],
    code: normalizeCode(match[1]),
  };
}

function parseRoomRoute(pathname) {
  const match = /^\/api\/link\/([A-Za-z0-9]+)\/(init|state|sync)$/.exec(pathname);
  if (!match) {
    return null;
  }

  return {
    action: match[2],
    code: normalizeCode(match[1]),
  };
}

function normalizeRoom(input = {}) {
  return {
    code: normalizeCode(input.code),
    version: typeof input.version === "string" ? input.version : "",
    updatedBy: typeof input.updatedBy === "string" ? input.updatedBy : "",
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
    snapshot: normalizeSnapshot(input.snapshot),
  };
}

function normalizeSyncInput(input = {}) {
  return {
    deviceId: typeof input.deviceId === "string" ? input.deviceId.trim() : "",
    version: typeof input.version === "string" ? input.version : "",
    baseVersion: typeof input.baseVersion === "string" ? input.baseVersion : "",
    hasFavourites: Array.isArray(input.snapshot?.favourites),
    snapshot: normalizeSnapshot(input.snapshot),
  };
}

function normalizeSnapshot(snapshot = {}) {
  return {
    history: Array.isArray(snapshot.history) ? snapshot.history : [],
    library: Array.isArray(snapshot.library) ? snapshot.library : [],
    favourites: Array.isArray(snapshot.favourites) ? snapshot.favourites : [],
  };
}

function mergeSnapshots(baseSnapshot, incomingSnapshot, options = {}) {
  const base = normalizeSnapshot(baseSnapshot);
  const incoming = normalizeSnapshot(incomingSnapshot);

  return {
    history: mergeHistory(base.history, incoming.history, options),
    library: mergeRecords(base.library, incoming.library, options),
    favourites: options.replaceFavourites ? incoming.favourites : base.favourites,
  };
}

function mergeHistory(baseHistory, incomingHistory, options = {}) {
  const entries = new Map();

  baseHistory.forEach((entry) => {
    const dateKey = String(entry?.dateKey || entry?.date || "");
    if (!dateKey) return;
    entries.set(dateKey, {
      ...entry,
      dateKey,
      workouts: Array.isArray(entry.workouts) ? [...entry.workouts] : [],
    });
  });

  incomingHistory.forEach((entry) => {
    const dateKey = String(entry?.dateKey || entry?.date || "");
    if (!dateKey) return;

    const existing = entries.get(dateKey);
    if (!existing) {
      entries.set(dateKey, {
        ...entry,
        dateKey,
        workouts: Array.isArray(entry.workouts) ? [...entry.workouts] : [],
      });
      return;
    }

    const workouts = new Map(
      existing.workouts
        .filter((workout) => workout && typeof workout === "object")
        .map((workout) => [recordKey(workout), workout]),
    );
    (Array.isArray(entry.workouts) ? entry.workouts : []).forEach((workout) => {
      if (!workout || typeof workout !== "object") return;
      const key = recordKey(workout);
      if (options.incomingWins || !workouts.has(key)) {
        workouts.set(key, workout);
      }
    });

    entries.set(dateKey, {
      ...existing,
      ...entry,
      dateKey,
      workouts: [...workouts.values()],
    });
  });

  return [...entries.values()].sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

function mergeRecords(baseRecords, incomingRecords, options = {}) {
  const records = new Map();

  baseRecords.forEach((record) => {
    if (!record || typeof record !== "object") return;
    records.set(recordKey(record), record);
  });

  incomingRecords.forEach((record) => {
    if (!record || typeof record !== "object") return;
    const key = recordKey(record);
    if (options.incomingWins || !records.has(key)) {
      records.set(key, record);
    }
  });

  return [...records.values()];
}

function recordKey(record) {
  return String(record?.id || record?.name || JSON.stringify(record));
}

function publicRoom(room) {
  return {
    code: room.code,
    version: room.version,
    updatedBy: room.updatedBy,
    updatedAt: room.updatedAt,
    snapshot: room.snapshot,
  };
}

function randomCode() {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const offset = Math.floor(Math.random() * CODE_ALPHABET.length);
    code += CODE_ALPHABET[offset];
  }
  return code;
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId.localeCompare(b.deviceId);
}

function maxVersion(left, right) {
  return compareVersions(left, right) >= 0 ? left : right;
}

function nextServerVersion(version) {
  const parsed = parseVersion(version);
  return `${String(parsed.wallTime).padStart(13, "0")}:${String(parsed.counter + 1).padStart(4, "0")}:server`;
}

function parseVersion(value) {
  const [wallTime = "0", counter = "0", deviceId = ""] = String(value || "").split(":");
  return {
    wallTime: Number(wallTime) || 0,
    counter: Number(counter) || 0,
    deviceId: String(deviceId || ""),
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function responseError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
