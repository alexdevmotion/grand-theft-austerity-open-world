# Grounded occupied vehicle recovery

## Scope

- `src/vehicles/vehicleSystem.ts`
- `src/vehicles/recovery.test.ts`
- `src/vehicles/vehicleLifecycle.test.ts`

## Scenarios and observables

1. `bun test src/vehicles/recovery.test.ts src/vehicles/vehicleLifecycle.test.ts`
   - **Observed:** 6 pass, 0 fail, 83 expectations.
   - Covers: forward-only contact does not teleport; forward + reverse low-speed
     attempts arm recovery; a two-of-four-wheel grounded wedge qualifies;
     neutral expiry clears stale direction state; airborne/unoccupied vehicles
     remain on the existing path; audio release is called by id during teardown.
2. `bun run typecheck`
   - **Observed:** `tsc --noEmit` exited 0.
3. `git diff --check`
   - **Observed:** exited 0.
4. `bun test`
   - **Observed:** 506 pass, 0 fail, 8907 expectations across 27 files.

## Implementation evidence

- `advanceOccupiedRecovery` requires an occupied vehicle, at least half its
  wheels grounded, sustained low planar speed, and failed forward plus reverse
  input before requesting rescue. A normal idle/queue and a single collision do
  not satisfy the gate.
- `VehicleSystem.occupiedRecoverySlot` searches several graph-walk road slots,
  rejecting building-footprint corners and nearby vehicle footprints before
  teleporting. The player car is moved only after the detector request; its
  transform is published immediately so the seated player does not render at
  the old wall for one frame.
- `Vehicle.unbindAudio` now always calls `AudioService.unbindEngine(id)` before
  body removal. This closes the stale audio voice/tracked-handle window for
  ordinary unoccupied traffic, whose voice may be assigned without
  `bindAudio` having run.
