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

## Pinned application-contract codec

`protocolV1Codec` is an independent startup-fixed, default-OFF flag. The codec parses at most 1 MiB
of JSON, reads the root `schema` and `version`, and dispatches only the five explicitly supported v1
TypeBox schemas. It performs no version inference or fallback. A successful decode retains one
compact JSON value; any failed decode clears it and exposes the first diagnostic as a JSON Pointer
path and message.

The schema definitions mirror `@multiview-pose/protocol` at the commit recorded in
`schemas/protocol-v1-integrity.json`. Canonical JSON SHA-256 values bind all five runtime definitions
to that commit. The repository check also compares an available upstream working checkout, making
schema edits fail until the pin, implementation, fixtures, and compatibility decision are updated
together.

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

## PoseFrame3D avatar retargeting

`avatarRetargetV1` is an independent startup-fixed, default-OFF flag. It requires runtime key
`turbowarpAFrameCapability`, calls `requireVersion(1)`, and uses only the seven public synchronous
scene operations from the TurboWarp-A-Frame capability. The consumer never accesses A-Frame DOM,
Three.js `object3D`, or GLTF bone internals. Capability v1 is published in
`@kubohiroya/turbowarp-aframe@0.3.0`.

An asset registration sends declarative template JSON to A-Frame and retains a validated rig map.
Each bone maps one supported Kalidokit pose rig output to a selector containing `{avatar}`, plus
optional Euler offset degrees. Applying a frame requires corresponding exact-v1 PoseFrame3D and
PoseFrame2D values. A person is joined only by PoseFrame3D `personId` equal to PoseFrame2D
`trackingId`; this is not temporal alignment.

The adapter maps both COCO-17 records deterministically to the 33 positions required by
exact-pinned `kalidokit@1.1.5`. Screen coordinates use PoseFrame2D `frameWidth` and `frameHeight`;
world coordinates retain the external service coordinate values. Missing BlazePose face, hand, and
foot points are midpoint-interpolated or duplicated with reduced visibility. Kalidokit `Pose.solve`
with `runtime: "tfjs"` and `enableLegs: true` is the sole rotation solver. Its radians are converted
to A-Frame degrees, and its hips result drives the configured root scale and offset. There is no
custom rotation fallback. Joint or person confidence below the binding threshold skips only that
transform and preserves its prior value.

At most six person IDs bind to unique template instances. Recognition transitions use configurable
A-Frame events, allowing the application to connect Performance DSL start/end effects without this
adapter owning effect execution. Per-person capability failures are collected as `partial` state so
other avatars continue. Rebind, explicit reset, project lifecycle reset, and disposal emit end when
possible, delete created instances, and clear temporary state.

PoseFrame3D is exact v1 boundary data from a separate 3D service. Its `timestampUs` is opaque and is
only copied into recognition event data. This extension performs no frame alignment, history
retention/query, triangulation, or 3D solve. Kalidokit is deprecated upstream and expects native
BlazePose landmarks; the deterministic COCO-17 expansion is therefore an explicit accuracy
constraint, and intended GLTF rigs require real-browser validation before release.

## Frame sync pattern vertical slice

`frameSyncPatternV1` is startup-fixed and default OFF. It answers one question for the fusion
application: how long after an event each camera computer finishes recording the frame that shows
it.

The display side paints a full-screen overlay with a 4 by 4 panel on black. Twelve cells hold a
millisecond counter that wraps every 4096 ms; four hold check bits derived from the counter. A
camera exposure that straddles a display refresh mixes two codes, and the check bits reject that
reading instead of letting a wrong time through. What is drawn during one animation frame reaches
the screen at the next refresh, so the encoded time is the current clock reading plus one measured
refresh interval; the remaining projector delay is common to every camera and cancels out of the
per-camera offsets.

The camera side takes a named Camera Source lease and never calls `getUserMedia`. Each delivered
frame is downscaled to a 240 by 180 luminance buffer that is reused between callbacks because the
decoder reads it synchronously. Calibration runs in two phases on the live pattern: the first 60%
of the window records per-pixel minimum and maximum luminance and takes the largest connected
high-range region whose bounding box is panel shaped, and the rest learns each cell's own light and
dark level and measures how often readings decode. Uneven projection is why levels are per cell, and
a reading that lands between a cell's learned levels is discarded. Calibration fails with
`panel-not-found`, `low-contrast`, or `decode-unstable` rather than returning untrusted latencies.
Both phases end on the shared clock, so a stalled camera never leaves the controller waiting.

Decoded frames are queued as observations. Timestamps are opaque readings from the external
synchronized time service, taken when the frame reached the application; the browser-reported frame
age is exposed separately for callers that want the sensor exposure moment instead. Clock probing,
latency samples, and the aggregated per-camera report belong to the WebRTC extension, so no clock,
offset, ping, or pong logic lives here.
