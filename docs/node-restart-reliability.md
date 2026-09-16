# Node restart reliability update

This update ports KAI's Docker readiness checks, longer shutdown timeout,
failure diagnostics and safer snapshot installation into KoinosKit. It retains
KoinosKit's local-block rebuild. It does not change wallet identity, the data
directory, RPC ports, or Koinos Docker image versions.

## Resulting behavior

- Start reserves the operation before waiting for Docker; another operation
  cannot race startup. Windows/macOS starts Docker Desktop when necessary.
- Stop waits for the Compose command to finish. Errors remain visible. Normal
  app quit waits for an in-flight Stop; closing an otherwise running app still
  leaves its Docker node running.
- Stop intent is persisted. Reopening reconnects monitoring to existing running
  containers, retries if Docker is not ready, and never overrides an explicit
  stop or starts a stopped node just because the app opened.
- Recovery reads the local head for the watched network. Missing RPC responses
  can trigger recovery even when a head height has never been received.
- Fresh replay progress extends a 20-minute quiet window. An unchanged log tail
  does not extend it indefinitely. Memory-saver mode's intentionally disabled
  RPC is not treated as a failure.
- Replay validation failures offer explicit local rebuild or Quick Sync;
  automatic recovery no longer repeatedly clears chain state on those failures.
- Quick Sync removes containers to release mounts, checks folder locks before
  downloading, installs both databases with rollback, and retains a recovery
  marker if interrupted. Producer keys and P2P identity are excluded.
- Container ownership checks prevent management of KAI/other profiles that use
  the same Compose project name.
- Both screens distinguish starting, stopping, replaying, restoring, syncing,
  unavailable RPC and healthy synchronized operation. Key registration alone
  is not presented as evidence of production.

## Automated verification

`npm test` includes lifecycle tests with mocked Docker responses and a real
child-process fixture, temporary-directory snapshot rollback tests, and tests
executing the shipping Node and Dashboard painters. Pull requests run the full
suite on Windows and Linux. These tests do not download a chain snapshot,
operate a real wallet, or simulate an actual OS reboot.

## Windows acceptance check before publishing installers

1. Start an existing synced node. Record its height, producer public key and
   data path. Confirm local RPC and a recent accepted block in the logs.
2. Press Stop. Confirm the busy state persists until the completion message.
   Restart Windows only after that message.
3. Open KoinosKit before Docker Desktop is ready and press Start. Confirm Docker
   starts, the existing database opens, local height resumes and catches up.
   Confirm producer identity and the original data path are unchanged.
4. Confirm a successfully accepted block when the node next wins production;
   the wait depends on its VHP share. A registered key is not sufficient evidence.
5. Close and reopen the app with Docker still running. Confirm monitoring
   reconnects without resetting the chain or disabling memory-saver mode.
6. Stop explicitly, reopen, and verify the node stays stopped.
7. With a slow replay, verify advancing log heights do not trigger restarts.
8. If validation errors recur, preserve chain logs and image versions. This
   app-side update does not establish or fix an upstream replay-validation bug.

Automated tests cannot certify the tester's original Windows failure is fixed.
The sequence above requires a real Windows/Docker installation and chain data.
