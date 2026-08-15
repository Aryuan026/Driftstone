# Driftstone Local Data Skeleton

`data/` keeps only the public Driftstone local skeleton. It is a doorway for
local-only inputs and runtime state, not a place for bundled history, private
memory artifacts, generated packets, or release payloads.

- `inbox/`
  - local drop zone for raw inputs
  - keep real files local only
- `runtime_save/`
  - resumable local state
  - scoped packets, translation tasks, and other save-before-apply material live here
- `local_fixtures/`
  - private smoke samples
  - useful for development, never required for the public repo

Older extracted payloads, debug runs, and personal memory artifacts are intentionally not kept here anymore.
