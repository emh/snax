export const CATEGORY_ORDER = ["cardio", "strength", "core", "mobility", "restore"];
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

const DEFAULT_LIBRARY = [
  { id: "squats", name: "squats", tagline: "hips back, chest proud", category: "strength", intensity: 2 },
  { id: "pushups", name: "pushups", tagline: "long line, smooth press", category: "strength", intensity: 2 },
  { id: "pullups", name: "pullups", tagline: "pull elbows to ribs", category: "strength", intensity: 3 },
  { id: "situps", name: "situps", tagline: "peel up, lower slow", category: "core", intensity: 2 },
  { id: "plank", name: "plank", tagline: "ribs down, glutes on", category: "core", intensity: 2 },
  { id: "side-plank", name: "side plank", tagline: "stack hips, reach long", category: "core", intensity: 2 },
  { id: "deep-squat", name: "deep squat", tagline: "sink low, breathe deep", category: "mobility", intensity: 1 },
  { id: "dead-hang", name: "dead hang", tagline: "let shoulders lengthen", category: "mobility", intensity: 1 },
  { id: "iso-lunge", name: "iso lunge", tagline: "freeze low, stay tall", category: "strength", intensity: 2 },
  { id: "horse-stance", name: "horse stance", tagline: "wide base, steady breath", category: "strength", intensity: 2 },
  { id: "wall-sit", name: "wall sit", tagline: "back flush, legs steady", category: "strength", intensity: 2 },
  { id: "couch-stretch", name: "couch stretch", tagline: "open the front hip", category: "mobility", intensity: 1 },
  { id: "cossack-squat", name: "cossack squat", tagline: "shift side to side", category: "mobility", intensity: 2 },
  { id: "lunges", name: "lunges", tagline: "step long, stand strong", category: "strength", intensity: 2 },
  { id: "foam-roll", name: "foam roll", tagline: "slow passes, pause on knots", category: "restore", intensity: 1 },
  { id: "lacross-ball-massage", name: "lacross ball massage", tagline: "pin the spot and breathe", category: "restore", intensity: 1 },
  { id: "breathwork", name: "breathwork", tagline: "slow inhale, slower exhale", category: "restore", intensity: 1 },
  { id: "steel-club-mills", name: "steel club mills", tagline: "smooth circles, loose shoulders", category: "mobility", intensity: 2 },
  { id: "steel-club-wrist-work", name: "steel club wrist work", tagline: "easy circles, supple wrists", category: "mobility", intensity: 1 },
  { id: "rope-flow", name: "rope flow", tagline: "keep it loose and rhythmic", category: "mobility", intensity: 1 },
  { id: "jump-rope", name: "jump rope", tagline: "light feet, easy bounce", category: "cardio", intensity: 2 },
  { id: "fingertip-plank", name: "fingertip plank", tagline: "spread hands, brace lightly", category: "core", intensity: 3 },
  { id: "underswitches", name: "underswitches", tagline: "thread through and stay light", category: "mobility", intensity: 2 },
  { id: "crab-reaches", name: "crab reaches", tagline: "lift hips, reach long", category: "mobility", intensity: 2 },
  { id: "burpees", name: "burpees", tagline: "down fast, jump tall", category: "cardio", intensity: 3 },
  { id: "pogo-hops", name: "pogo hops", tagline: "quick springs off the floor", category: "cardio", intensity: 2 },
  { id: "single-leg-deadlifts", name: "single leg deadlifts", tagline: "hinge long, balance steady", category: "strength", intensity: 2 },
  { id: "split-squats", name: "split squats", tagline: "drop straight down", category: "strength", intensity: 2 },
  { id: "iso-calf-raise", name: "iso calf raise", tagline: "rise high and hold", category: "strength", intensity: 1 },
  { id: "pike-pulses", name: "pike pulses", tagline: "compress and pulse tall", category: "core", intensity: 2 },
  { id: "hollow-rocks", name: "hollow rocks", tagline: "stay curved, rock small", category: "core", intensity: 3 },
  { id: "rolling-getups", name: "rolling getups", tagline: "roll smooth, stand with control", category: "core", intensity: 2 },
  { id: "single-leg-balance", name: "single leg balance", tagline: "soft knee, quiet foot", category: "mobility", intensity: 1 },
  { id: "scapular-pushups", name: "scapular pushups", tagline: "glide shoulder blades", category: "strength", intensity: 1 },
  { id: "serratus-punches", name: "serratus punches", tagline: "reach long from the ribs", category: "strength", intensity: 1 },
  { id: "shadow-boxing", name: "shadow boxing", tagline: "snap punches, stay loose", category: "cardio", intensity: 2 },
  { id: "hand-gripper", name: "hand gripper", tagline: "crush hard, release slow", category: "strength", intensity: 1 },
  { id: "bear-squats", name: "bear squats", tagline: "hips low, legs driving", category: "strength", intensity: 2 },
  { id: "90-90-hip-switches", name: "90/90 hip switches", tagline: "rotate cleanly through the hips", category: "mobility", intensity: 1 },
  { id: "single-leg-glute-bridge", name: "single leg glute bridge", tagline: "drive heel, square hips", category: "strength", intensity: 2 },
  { id: "handstand", name: "handstand", tagline: "stack tall, squeeze everything", category: "strength", intensity: 3 },
];

function normalizeCategory(category) {
  return CATEGORY_ORDER.includes(category) ? category : "mobility";
}

function normalizeIntensity(intensity) {
  const value = Number(intensity);
  if (value < 1) {
    return 1;
  }
  if (value > 3) {
    return 3;
  }
  return value || 1;
}

function normalizeEnabled(enabled) {
  return enabled !== false;
}

function slugify(text, fallback) {
  const value = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || fallback;
}

export function createDefaultLibrary() {
  return DEFAULT_LIBRARY.map((exercise, index) => hydrateExercise(exercise, index));
}

export function createEmptyExercise() {
  return {
    id: `snack-${Date.now()}`,
    name: "new snack",
    tagline: "add a tagline",
    category: "mobility",
    intensity: 2,
    enabled: true,
  };
}

export function hydrateExercise(exercise, index = 0) {
  const source = exercise || {};
  const name = String(source.name || "").trim() || `snack ${index + 1}`;
  const id = String(source.id || "").trim() || slugify(name, `snack-${index + 1}`);

  return {
    id,
    name,
    tagline: String(source.tagline || source.cue || "").trim(),
    category: normalizeCategory(String(source.category || "")),
    intensity: normalizeIntensity(source.intensity),
    enabled: normalizeEnabled(source.enabled),
    deleted: Boolean(source.deleted),
  };
}

export function hydrateLibrary(library) {
  if (!Array.isArray(library)) {
    return createDefaultLibrary();
  }

  const normalized = library
    .filter((exercise) => exercise && typeof exercise === "object")
    .map((exercise, index) => hydrateExercise(exercise, index));

  return normalized.length > 0 ? normalized : createDefaultLibrary();
}

export function createSeedHistory() {
  return [];
}

export function hydrateSnack(snack) {
  const source = snack || {};

  return {
    id: String(source.id || ""),
    at: source.at ? String(source.at) : null,
    stack: source.stack ? String(source.stack) : null,
    skipped: Boolean(source.skipped),
  };
}

export function resolveSnack(snack, library) {
  const exercise = library.find((item) => item.id === snack.id);
  if (exercise) {
    return {
      ...snack,
      name: exercise.name,
      tagline: exercise.tagline,
      category: exercise.category,
      intensity: exercise.intensity,
    };
  }

  return {
    ...snack,
    name: snack.id || "unknown snack",
    tagline: "",
    category: "mobility",
    intensity: 1,
  };
}

export function resolveSnacks(snacks, library) {
  return snacks.map((snack) => resolveSnack(snack, library));
}

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

export function filterExercises(library, filters) {
  return library.filter((exercise) => {
    if (exercise.deleted) return false;
    const isEnabled = exercise.enabled !== false;
    const matchesCategory = filters.category === "any" || exercise.category === filters.category;
    const matchesIntensity = filters.intensity === "any" || exercise.intensity === Number(filters.intensity);
    return isEnabled && matchesCategory && matchesIntensity;
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
