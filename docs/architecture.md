# Architecture

[日本語](architecture.ja.md)

## Build outputs

The project keeps runtime behavior and compatibility metadata separate while generating both from
the same checked-in source definitions.

```text
src/index.ts + src/extension.ts
  -> vite-plugin-turbowarp-extension
  -> dist/<extension>.js

src/config.ts + src/block-definitions.json
  -> extension-api-manifest Vite plugin
  -> dist/extension-manifest.json
```

The manifest plugin runs in Vite's post-build phase. This preserves the JavaScript plugin's
single-output validation and adds the manifest only after the TurboWarp bundle is complete.

## Extension API manifest v1

`schemas/extension-manifest.schema.json` is the normative JSON Schema. `formatVersion` is `1` and
must change when an incompatible manifest shape is introduced.

The v1 contract contains:

- the TurboWarp extension ID;
- each block opcode and block type;
- each argument ID, argument type, and optional menu reference;
- each menu ID and whether it accepts reporter blocks.

Blocks, arguments, and menus are sorted by their identifiers before serialization. Text,
descriptions, default values, and static menu items are intentionally excluded because they do not
identify saved-project API references. A compatibility checker can therefore distinguish API
changes from documentation or localization changes.

## Drift detection

`dist/` is committed as a release artifact. `npm run check:dist` rebuilds both files and fails when
Git reports any modified, deleted, or untracked file below `dist/`. This catches manifest and bundle
drift in local checks and CI.

## Offer QR vertical slice

`config/feature-flags.ts` keeps `qrCourierPairing` startup-fixed and default OFF. When enabled, the
extension requires `kubohiroyaWebRtcCapability` version 2, calls `createOffer(peer)`, and retrieves
the completed pairing code with `getOffer(peer)`. It never reaches into another extension's private
instance.

The unchanged printable-ASCII pairing code is wrapped in versioned `twmp-qr/1` parts. Every part
contains a random session ID, peer and message identity, zero-based ordering, total source length,
and a SHA-256 digest. A conservative byte-mode capacity check bounds each QR to Version 40. The
wire input is limited to 128 KiB, 64 parts, and 4096 characters per chunk.

Display uses renderer-only SVG skins. The current drawable skin is retained, a generated skin is
attached without creating a VM costume, and cleanup restores the retained skin before destroying
the temporary resource. Project stop, extension disposal, explicit cleanup, and displayed-target
removal all release sensitive QR data.

## WebGPU MoveNet MultiPose vertical slice

`webgpuMoveNetMultiPose` is an independent startup-fixed, default-OFF flag. Startup imports only the
TensorFlow.js WebGPU backend, explicitly calls `setBackend("webgpu")`, verifies the selected backend,
and then creates `MoveNet` with `MULTIPOSE_LIGHTNING`, tracking enabled, and bounding-box tracking.
Any non-WebGPU result fails closed; there is no CPU, WASM, or WebGL inference fallback.

The controller acquires `{cameraId: "pose"}` through Camera Source and never owns media capture.
Concurrent inference block calls share one promise, so detector invocations do not overlap and old
frame requests do not accumulate. Each successful call reads the latest video frame, requests no
more than six poses, requires model tracking IDs and all 17 named COCO keypoints, and serializes the
result to the `twmp/pose-frame-2d` version 1 contract.

Stopping waits for in-flight initialization/inference, disposes the detector, releases the camera
lease, and clears the last frame. The TensorFlow.js backend is process-global and is not reset,
because doing so would invalidate resources owned by other extensions; disposing the detector
releases this feature's model resources.

## Owned application contracts and their codec

`protocolV1Codec` is an independent startup-fixed, default-OFF flag. The codec parses at most 1 MiB
of JSON, reads the root `schema` and `version`, and dispatches only explicitly supported TypeBox
schemas. It performs no version inference or fallback. A successful decode retains one compact JSON
value; any failed decode clears it and exposes the first diagnostic as a JSON Pointer path and
message.

This package owns the contracts. `src/protocol/schemas.ts` is the source of truth, `pnpm run schemas`
generates the published JSON Schemas under `schemas/`, and the repository check fails when a
generated file drifts from its definition, when a file name disagrees with the `version` literal or
`$id` it declares, or when a dispatched version has no published file. Applications consume these
definitions through this package and through the published `schemas/` directory; nothing here reads
contract definitions from an application repository, which keeps the dependency pointing from the
application to the extension.

Contracts are versioned, never edited in place. `protocolSchemas` dispatches by schema identifier and
then by version, so `twmp/pose-frame-2d` accepts v1 and v2 while a v1 consumer still rejects a v2
payload. PoseFrame2D v2 adds up to four glow stick markers per person, each naming the COCO-17
keypoint where a uniquely colored light was observed, its `#RRGGBB` color, and the patch coverage
that produced it. The color is observed on the same video frame and at the same capture timestamp as
the keypoints, so it travels inside the pose frame instead of a second message that a receiver would
have to time-align.

TypeBox tuple and array constraints enforce COCO-17 ordering, six-person limits, matrix sizes, and
all bounded values. A separate recursive key guard rejects WebRTC offers, answers, SDP, ICE/DTLS
material, and credential fields before persistence, even if a later schema accidentally permits a
nested extension point. SessionPolicy also enforces `expiresAt > issuedAt` and rejects expired
policies at application-validation time.

PoseFrame2D `captureTimestampUs` and PoseFrame3D `timestampUs` are opaque values from a separate
synchronized local time service. This extension carries the supplied timestamp unchanged and does
not implement clock initialization, offset estimation, probes, ping, or pong logic.

## Camera calibration workflow

`cameraCalibrationV1` is startup-fixed and default OFF. A session validates the camera and
calibration identifiers plus a 3–20 by 3–20 inner-corner chessboard and a square size in meters,
then obtains a named Camera Source lease. The actual first frame dimensions become immutable for
the session; later resolution changes fail before detection.

Each explicitly requested sample performs one temporary video-to-canvas copy. The exact-pinned
OpenCV.js 4.12 WebAssembly backend is bundled but lazily initialized by the first sample or solve.
It detects the complete chessboard, refines corners to subpixel
precision, and scores board coverage plus Laplacian sharpness. Quality below 0.2 and views within
0.015 normalized RMS corner displacement of any retained view are rejected. The controller retains
8–40 diverse samples and does not run a continuous CPU sampling loop or a second reference solver.

`calibrateCamera` produces the intrinsic matrix, distortion vector, and RMS reprojection error. The
last sample is deliberately reserved as the stage-world board placement. Its returned rotation and
translation are inverted into the row-major 4 by 4 `worldFromCameraMatrix`. Results above the
configured RMS threshold or outside CameraCalibration v1 bounds do not replace the last valid
profile.

Cancel, project reload, and extension disposal release the lease and temporary samples while
keeping the last validated profile in memory. Explicit cleanup clears that profile too. Import uses
the same exact v1 schema and recursively rejects pairing-secret keys. The 11 MB uncompressed bundle
increase is accepted to keep the sole production backend available on an offline venue LAN; real
camera/board geometry and WebAssembly startup remain browser E2E responsibilities.

## Multi-camera 3D pose fusion

`poseFusion3D` is an independent startup-fixed, default-OFF flag. The fusion app feeds the buffer
with PoseFrame2D JSON received over WebRTC data channels; this extension owns neither the transport
nor the clock.

Every camera gets its own timestamp-ordered ring buffer. Slot count is derived from the configured
delay and jitter window, bounded to 16 to 600 frames, and at most 16 cameras are buffered. An
in-window reorder is inserted at its timestamp position by shifting the shorter side of the ring, so
the common in-order append stays O(1). A duplicate timestamp, an arrival older than the newest frame
minus the jitter window, and an arrival older than the oldest retained frame of a full ring are
counted as dropped instead of buffered. None of this estimates a per-camera clock offset: capture
timestamps stay opaque values from the separate synchronized local time service.

A frame is only buffered when a calibration profile for its `cameraId` is loaded and that profile
describes it: a mismatched `calibrationId` or frame size would otherwise be triangulated silently
with the wrong intrinsics. Such frames, like duplicates and late arrivals, are counted as dropped
rather than thrown, because ingest runs on the data-channel hot path and one misconfigured peer must
not break a running project script. Because only calibrated cameras are buffered, stray camera IDs
cannot occupy the ring buffers either.

`fuse PoseFrame3D at buffered delay` resolves the newest buffered timestamp minus the configured
delay, and every camera is resampled at that single past instant. A keypoint bracketed by two frames
is interpolated linearly; a keypoint that is occluded on one side of the bracket keeps the visible
observation instead of blending a low-confidence estimate into it; a camera without a bracket, or
with a bracket wider than twice the jitter window, holds its nearest frame for at most one jitter
window and otherwise contributes nothing.

Cross-camera association scores every pair of tracked persons from different cameras by the mean
two-view reprojection error over their shared confident keypoints, requiring at least four shared
keypoints and stopping at twelve. Pairs are merged greedily from the lowest cost, and a merge that
would place two views of the same camera in one person is rejected. Two-view triangulation uses the
closed-form midpoint of both viewing rays, which keeps this quadratic stage off the iterative
solver; the general case still uses the score-weighted linear solver with a relative Jacobi
convergence threshold. One fusion at the 16 camera by 6 person limit measures about 80 ms, against
about 1 ms for four cameras and two performers.

Each cluster covered by at least two cameras is triangulated per keypoint with a cheirality check
and a reprojection check. When the full view set does not agree, every two-view seed is scored by
how many views fall inside the reprojection threshold, and the largest consensus set is
re-triangulated; a minority of wrong detections is therefore discarded instead of dragging the
keypoint away from the truth, while views split evenly between two consistent answers stay
ambiguous. Pixel observations are undistorted with the OpenCV rational model of the profile, so 0,
4, 5, or 8 coefficients are supported and anything else is rejected when the profile is loaded.

A registry keeps stable `person-N` identifiers by camera and tracking-ID overlap, and keeps the last
triangulated position of every keypoint. A keypoint left with fewer than two confident views holds
that last position and reports score `0`, so consumers can distinguish measured from held values.
The assembled frame is checked against the pinned PoseFrame3D v1 schema before it is retained.

Empty buffers, fewer than two covering cameras, and an instant with no multi-camera person are
expected transient states: they report `false`, keep the last fused frame, and expose an error code.
Invalid JSON, a foreign schema, and an invalid calibration profile throw. The stop button, project
reload, and extension disposal clear buffers and fused results; explicit cleanup also clears the
loaded calibration profiles. `PROJECT_RUN_STOP` deliberately does not: the runtime emits it whenever
the thread queue empties, and an event-driven fusion project that buffers frames from hat scripts
would otherwise lose its jitter buffer between messages. Camera leases and temporary skins are still
released there.
