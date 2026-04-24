# snax MVP Plan

## Product Shape

`snax` is a mobile-first exercise picker for fast movement breaks. The app centers on one loop:

1. Pick simple constraints.
2. Shake the jar.
3. Preview the stack.
4. Complete timed snacks.
5. Review the day and recent history.

## File Structure

```text
.
├── app/
│   ├── index.html
│   ├── main.js
│   ├── model.js
│   ├── storage.js
│   └── styles.css
├── docs/
│   └── implementation-plan.md
├── prototype.html
├── workers/
│   └── README.md
└── package.json
```

## MVP Delivered In This Pass

- Plain browser-module app under `app/`
- `wds` local server script
- Prototype-inspired visual system and layout
- Exercise library with filter chips
- Stack generation and preview flow
- Active workout timer and rest timer
- Completion screen
- Today and archive summaries
- Day detail screen
- Local persistence with seeded sample history

## Next Milestones

1. Add sound, haptics, and reduced-motion tuning.
2. Improve timer resilience when the tab backgrounds or sleeps.
3. Replace `window.confirm` with an in-app confirmation pattern.
4. Add tests around storage, date handling, and timer transitions.
5. Add worker-backed sync under `workers/` when the API shape is ready.

## Key Product Decisions

- Dates use local calendar keys instead of UTC slicing.
- History is local-first and stored in `localStorage`.
- Duplicate picks are allowed only when the filtered pool is smaller than the requested size.
- The archive shows the previous seven days while today remains a dedicated panel.
- The repo now mirrors the lighter `app/` layout used by related projects.
