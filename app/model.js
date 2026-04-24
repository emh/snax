export const CATEGORY_ORDER = ["cardio", "strength", "core", "mobility", "breath"];
export const SIZE_VALUES = [1, 3, 5];
export const SIZE_LABELS = {
  1: "one",
  3: "three",
  5: "five",
};
export const INTENSITY_LABELS = {
  1: "easy",
  2: "medium",
  3: "hard",
};
export const DEFAULT_FILTERS = {
  size: 3,
  intensity: "any",
  category: "any",
};

export const SNACK_DURATION = 60;
export const REST_DURATION = 10;

export const EXERCISES = [
  { id: "sprint", name: "sprint in place", category: "cardio", intensity: 3, cue: "knees high, pump arms" },
  { id: "burpees", name: "burpees", category: "cardio", intensity: 3, cue: "chest to floor, jump tall" },
  { id: "jump-rope", name: "jump rope", category: "cardio", intensity: 2, cue: "real rope or imagined" },
  { id: "mountain", name: "mountain climbers", category: "cardio", intensity: 2, cue: "hips low, knees quick" },
  { id: "high-knees", name: "high knees", category: "cardio", intensity: 2, cue: "drive the knee up" },
  { id: "pushup", name: "pushups", category: "strength", intensity: 2, cue: "elbows at 45 degrees" },
  { id: "squat", name: "air squats", category: "strength", intensity: 2, cue: "sit back, chest up" },
  { id: "kb-swing", name: "kettlebell swing", category: "strength", intensity: 3, cue: "hinge, drive hips" },
  { id: "ring-row", name: "ring row", category: "strength", intensity: 2, cue: "pull to the ribs" },
  { id: "lunge", name: "walking lunge", category: "strength", intensity: 2, cue: "back knee kisses floor" },
  { id: "plank", name: "plank", category: "core", intensity: 2, cue: "ribs down, glutes on" },
  { id: "hollow", name: "hollow hold", category: "core", intensity: 3, cue: "low back glued down" },
  { id: "side-plank", name: "side plank", category: "core", intensity: 2, cue: "stack the hips" },
  { id: "bird-dog", name: "bird dog", category: "core", intensity: 1, cue: "slow, opposite limbs" },
  { id: "dead-bug", name: "dead bug", category: "core", intensity: 1, cue: "ribs heavy, breathe" },
  { id: "hip-opener", name: "hip opener flow", category: "mobility", intensity: 1, cue: "90/90 to pigeon" },
  { id: "cat-cow", name: "cat-cow", category: "mobility", intensity: 1, cue: "breath leads spine" },
  { id: "thread-needle", name: "thread the needle", category: "mobility", intensity: 1, cue: "rotate from mid-back" },
  { id: "foam-roll", name: "foam rolling", category: "mobility", intensity: 1, cue: "linger on the knot" },
  { id: "shoulder-rolls", name: "shoulder circles", category: "mobility", intensity: 1, cue: "slow, huge arcs" },
  { id: "box", name: "box breathing", category: "breath", intensity: 1, cue: "4 in, 4 hold, 4 out, 4 hold" },
  { id: "478", name: "4-7-8 breath", category: "breath", intensity: 1, cue: "inhale 4, hold 7, out 8" },
];

const EXERCISE_BY_ID = new Map(EXERCISES.map((exercise) => [exercise.id, exercise]));

export function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fromDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function todayKey() {
  return toDateKey(new Date());
}

export function recentDateKeys(count, includeToday = false) {
  const startOffset = includeToday ? 0 : 1;
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (index + startOffset));
    return toDateKey(date);
  });
}

export function createLocalIso(dateKey, hours, minutes) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

function buildSnack(id, at, stack) {
  const exercise = EXERCISE_BY_ID.get(id);
  return {
    id: exercise.id,
    name: exercise.name,
    category: exercise.category,
    intensity: exercise.intensity,
    cue: exercise.cue,
    at: at || null,
    stack: stack || null,
    skipped: false,
  };
}

function buildRun(dateKey, hours, minutes, ids, stackId) {
  const start = new Date(createLocalIso(dateKey, hours, minutes)).getTime();
  return ids.map((id, index) => buildSnack(id, new Date(start + index * 70_000).toISOString(), stackId));
}

export function createSeedHistory() {
  const [d1, d2, d3, d4, d5, d6, d7] = recentDateKeys(7, false);

  return [
    {
      dateKey: d1,
      snacks: [
        ...buildRun(d1, 7, 12, ["kb-swing"], "d1-a"),
        ...buildRun(d1, 8, 45, ["box"], "d1-b"),
        ...buildRun(d1, 10, 30, ["plank", "squat", "foam-roll"], "d1-c"),
        ...buildRun(d1, 14, 20, ["burpees", "mountain", "hollow"], "d1-d"),
      ],
    },
    {
      dateKey: d2,
      snacks: [...buildRun(d2, 8, 15, ["pushup", "cat-cow", "ring-row"], "d2-a")],
    },
    {
      dateKey: d3,
      snacks: [
        ...buildRun(d3, 6, 45, ["sprint", "plank", "lunge"], "d3-a"),
        ...buildRun(d3, 11, 15, ["box", "side-plank", "hip-opener", "burpees", "squat"], "d3-b"),
        ...buildRun(d3, 15, 25, ["mountain"], "d3-c"),
        ...buildRun(d3, 18, 40, ["kb-swing", "hollow", "478"], "d3-d"),
      ],
    },
    {
      dateKey: d4,
      snacks: [],
    },
    {
      dateKey: d5,
      snacks: [...buildRun(d5, 7, 30, ["pushup", "ring-row", "bird-dog", "box", "foam-roll"], "d5-a")],
    },
    {
      dateKey: d6,
      snacks: [...buildRun(d6, 9, 15, ["burpees", "hollow", "kb-swing"], "d6-a")],
    },
    {
      dateKey: d7,
      snacks: [
        ...buildRun(d7, 6, 50, ["sprint", "squat", "plank"], "d7-a"),
        ...buildRun(d7, 13, 45, ["cat-cow"], "d7-b"),
        ...buildRun(d7, 17, 40, ["box", "pushup", "side-plank"], "d7-c"),
      ],
    },
  ];
}

export function hydrateSnack(snack) {
  const source = snack || {};
  const exercise = EXERCISE_BY_ID.get(source.id) || {};
  const intensity = Number(source.intensity || exercise.intensity || 1);
  return {
    id: String(source.id || exercise.id || ""),
    name: String(source.name || exercise.name || ""),
    category: String(source.category || exercise.category || "mobility"),
    intensity: intensity < 1 ? 1 : intensity > 3 ? 3 : intensity,
    cue: String(source.cue || exercise.cue || ""),
    at: source.at ? String(source.at) : null,
    stack: source.stack ? String(source.stack) : null,
    skipped: Boolean(source.skipped),
  };
}

export function sortHistoryDescending(history) {
  return history.slice().sort((left, right) => right.dateKey.localeCompare(left.dateKey));
}

export function findHistoryEntry(history, dateKey) {
  return history.find((entry) => entry.dateKey === dateKey) || null;
}

export function ensureHistoryEntry(history, dateKey) {
  const existing = findHistoryEntry(history, dateKey);
  if (existing) {
    return existing;
  }

  const entry = { dateKey, snacks: [] };
  history.unshift(entry);
  history.sort((left, right) => right.dateKey.localeCompare(left.dateKey));
  return entry;
}

export function filterExercises(filters) {
  return EXERCISES.filter((exercise) => {
    const matchesCategory = filters.category === "any" || exercise.category === filters.category;
    const matchesIntensity = filters.intensity === "any" || exercise.intensity === Number(filters.intensity);
    return matchesCategory && matchesIntensity;
  });
}

export function pickStack(pool, size) {
  const selected = [];
  const bag = pool.slice();

  while (bag.length > 0 && selected.length < size) {
    const index = Math.floor(Math.random() * bag.length);
    selected.push(bag.splice(index, 1)[0]);
  }

  while (selected.length < size && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    selected.push(pool[index]);
  }

  return selected;
}

export function getLoad(snacks) {
  return snacks.reduce((total, snack) => total + snack.intensity, 0);
}

export function summarizeEntries(entries) {
  const snacks = entries.flatMap((entry) => entry.snacks);
  return {
    count: snacks.length,
    load: getLoad(snacks),
  };
}

export function formatLongDate(dateKey) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(fromDateKey(dateKey));
}

export function formatShortDate(dateKey) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(fromDateKey(dateKey));
}

export function formatMonthDay(dateKey) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(fromDateKey(dateKey));
}

export function formatDayTitle(dateKey) {
  if (dateKey === todayKey()) {
    return "today";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
  })
    .format(fromDateKey(dateKey))
    .toLowerCase();
}

export function formatTime(isoString) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(isoString))
    .replace(/\s/g, "")
    .toLowerCase();
}

export function formatSizeLabel(size) {
  return SIZE_LABELS[size] || String(size);
}

export function describeFilters(filters) {
  const flavour = filters.category === "any" ? "any flavour" : filters.category;
  const heat = filters.intensity === "any" ? "any heat" : `${INTENSITY_LABELS[filters.intensity]} heat`;
  return `${flavour} / ${heat}`;
}

export function formatMetaText(snacks) {
  if (snacks.length === 0) {
    return "0 snacks";
  }

  return `${snacks.length} snack${snacks.length === 1 ? "" : "s"} / load ${getLoad(snacks)}`;
}

export function formatDurationSummary(size) {
  const work = size * SNACK_DURATION;
  const rest = Math.max(0, (size - 1) * REST_DURATION);
  const total = work + rest;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `total ${minutes}m ${seconds}s / ${work}s work / ${rest}s rest`;
}

export function formatRunDuration(size) {
  const work = size * SNACK_DURATION;
  const rest = Math.max(0, (size - 1) * REST_DURATION);
  const total = work + rest;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s total`;
}

export function formatTimerSeconds(seconds) {
  return seconds < 10 ? `0${seconds}` : String(seconds);
}

export function groupByStack(snacks) {
  const sorted = snacks
    .slice()
    .sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")));
  const groups = [];
  let current = null;

  for (const snack of sorted) {
    const key = snack.stack || snack.at || `single-${Math.random()}`;
    if (!current || current.key !== key) {
      current = { key, at: snack.at, snacks: [snack] };
      groups.push(current);
      continue;
    }

    current.snacks.push(snack);
  }

  return groups;
}
