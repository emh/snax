import assert from "node:assert/strict";
import test from "node:test";

import { SnaxLinkRoom } from "./index.js";

function createRoomHarness() {
  let room;
  const instance = new SnaxLinkRoom({
    storage: {
      get() {
        return room;
      },
      put(_key, value) {
        room = value;
      },
    },
  });

  return {
    async initialize(snapshot, version = "0000000001000:0000:device-a") {
      const response = await instance.fetch(
        new Request("https://internal/api/link/ABCDEFGH/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Snax-Internal-Create": "1",
          },
          body: JSON.stringify({ deviceId: "device-a", version, snapshot }),
        }),
      );
      assert.equal(response.status, 200);
      return response.json();
    },
    async sync(input) {
      const response = await instance.fetch(
        new Request("https://internal/api/link/ABCDEFGH/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

test("sync snapshots preserve favourites", async () => {
  const room = createRoomHarness();
  const favourite = { id: "workout-a", exercises: [{ id: "squats" }] };
  const initialized = await room.initialize({
    history: [],
    library: [],
    favourites: [favourite],
  });

  assert.deepEqual(initialized.snapshot.favourites, [favourite]);
});

test("dirty offline history merges even when its client version is older", async () => {
  const room = createRoomHarness();
  const roomVersion = "0000000003000:0000:device-a";
  const clientVersion = "0000000002000:0000:device-b";
  await room.initialize(
    {
      history: [
        {
          dateKey: "2026-07-16",
          workouts: [{ id: "remote-workout", exercises: [{ id: "squats" }] }],
        },
      ],
      library: [{ id: "squats", name: "current squats" }],
      favourites: [],
    },
    roomVersion,
  );

  const synced = await room.sync({
    deviceId: "device-b",
    version: clientVersion,
    baseVersion: "0000000001000:0000:device-b",
    snapshot: {
      history: [
        {
          dateKey: "2026-07-16",
          workouts: [{ id: "offline-workout", exercises: [{ id: "plank" }] }],
        },
      ],
      library: [
        { id: "squats", name: "stale squats" },
        { id: "plank", name: "plank" },
      ],
      favourites: [],
    },
  });

  assert.deepEqual(
    synced.snapshot.history[0].workouts.map((workout) => workout.id).sort(),
    ["offline-workout", "remote-workout"],
  );
  assert.deepEqual(
    synced.snapshot.library.map((exercise) => exercise.id).sort(),
    ["plank", "squats"],
  );
  assert.equal(
    synced.snapshot.library.find((exercise) => exercise.id === "squats").name,
    "current squats",
  );
  assert.ok(synced.version > roomVersion);
  assert.ok(synced.version > clientVersion);
});

test("clean stale snapshots do not reintroduce old data", async () => {
  const room = createRoomHarness();
  const roomVersion = "0000000003000:0000:device-a";
  await room.initialize(
    {
      history: [{ dateKey: "2026-07-16", workouts: [{ id: "current-workout" }] }],
      library: [],
      favourites: [],
    },
    roomVersion,
  );

  const synced = await room.sync({
    deviceId: "device-b",
    version: "0000000002000:0000:device-b",
    baseVersion: "0000000002000:0000:device-b",
    snapshot: {
      history: [{ dateKey: "2026-07-15", workouts: [{ id: "stale-workout" }] }],
      library: [],
      favourites: [],
    },
  });

  assert.equal(synced.version, roomVersion);
  assert.deepEqual(
    synced.snapshot.history.flatMap((entry) => entry.workouts.map((workout) => workout.id)),
    ["current-workout"],
  );
});
