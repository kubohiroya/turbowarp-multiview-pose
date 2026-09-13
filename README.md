# TurboWarp-Multiview-Pose

[日本語](README.ja.md)

Composite TurboWarp blocks for building the `camera app` and `fusion app` in multiview-pose.
The first vertical slice converts a named WebRTC offer into QR courier parts and displays each part
as a temporary sprite skin.

## What it does

- Creates an offer through the versioned TurboWarp WebRTC runtime capability.
- Splits the unchanged pairing code into independently decodable QR courier envelopes.
- Generates lossless QR SVGs through Version 40 and displays them on a sprite.
- Restores the sprite's original skin and discards sensitive temporary data on cleanup.
- Runs MoveNet MultiPose Lightning for up to six tracked people through TensorFlow.js WebGPU only.
- Reports COCO-17 observations as `twmp/pose-frame-2d` version 1 JSON.
- Validates and round-trips all five pinned multiview-pose v1 application contracts.
- Runs a shared-camera chessboard workflow for intrinsic and world-extrinsic calibration.
- Buffers jittered PoseFrame2D streams per camera and resamples every camera at one past instant.
- Triangulates the synchronized 2D sets into `twmp/pose-frame-3d` version 1 poses.

## Requirements and safety

- TurboWarp with custom unsandboxed extensions enabled.
- `@kubohiroya/turbowarp-webrtc` with runtime capability v2, loaded first.
- `@kubohiroya/turbowarp-camera-source` 0.4 or later, loaded before pose startup.
- A browser and GPU combination supported by TensorFlow.js WebGPU.
- WebAssembly support for the bundled OpenCV.js 4.12 calibration backend.
- The startup-fixed feature flags are independently OFF by default.

Set the flag before loading the extension:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {qrCourierPairing: true};
globalThis.__TWMP_QR_CONFIG__ = {errorCorrectionLevel: "M"}; // L, M, Q, or H
```

Enable pose inference independently when needed:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {webgpuMoveNetMultiPose: true};
```

Enable the five-contract codec independently:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {protocolV1Codec: true};
```

Enable camera calibration independently:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {cameraCalibrationV1: true};
```

Enable multi-camera 3D pose fusion independently:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {poseFusion3D: true};
```

Pose startup explicitly selects `webgpu` and fails closed if TensorFlow.js reports any other
backend. There is no CPU, WASM, or WebGL inference fallback. The extension never calls
`getUserMedia()`; it obtains the named `pose` stream through Camera Source's `acquireCamera()` API.
The first model load normally fetches MoveNet MultiPose Lightning from TensorFlow Hub, so cache the
model before taking a venue LAN offline.

Pairing codes can contain LAN addresses, ICE credentials, and DTLS fingerprints. Show QR codes only
in a trusted venue, do not retain screenshots, and call the cleanup block after pairing. This
extension neither uploads nor stores the QR image as a project costume.

## Installation

Load `dist/turbowarp-multiview-pose.js` as an unsandboxed custom extension. A version-pinned package URL is:

```text
https://cdn.jsdelivr.net/npm/@kubohiroya/turbowarp-multiview-pose@0.1.0/dist/turbowarp-multiview-pose.js
```

## Quick start

```text
prepare offer QR for peer [camera-1]
show offer QR part [1] on this sprite
repeat until courier photography is complete:
  show next offer QR part on this sprite
end offer QR display
```

Part indices exposed to blocks are one-based. The wire envelope uses zero-based `partIndex`.

The pose vertical slice is:

```text
start WebGPU MoveNet MultiPose camera [pose] peer [source-1] calibration [calibration-1]
forever:
  infer latest pose frame timestamp [(synchronized timestamp us)] us
  set [poseJson] to (latest PoseFrame2D JSON)
stop WebGPU MoveNet MultiPose
```

Concurrent inference requests share one in-flight operation. Calls do not build a frame backlog;
the next call after completion reads the latest frame from the shared Camera Source video.

The protocol codec dispatches by the payload's `schema` and `version`, and only accepts the pinned
v1 SessionPolicy, CameraCalibration, PoseFrame2D, PoseFrame3D, and Performance DSL
contracts. Use `protocol error path` and `protocol error message` after a failed validation. Unknown
fields and versions fail closed; WebRTC offer, answer, SDP, ICE, DTLS, and credential keys are
forbidden recursively because pairing secrets must not enter persistent application contracts.

`captureTimestampUs` and PoseFrame3D `timestampUs` are opaque values supplied by the separate
synchronized local time service. This extension carries them unchanged and intentionally provides
no clock initialization, offset estimation, probe, ping, or pong logic.

The shared camera/fusion calibration workflow is:

```text
start camera calibration camera [pose] profile [calibration-1] board [9] by [6]
  square [0.025] m max error [1.5] px
repeat until <camera calibration sample count = 8>:
  add camera calibration sample
solve camera calibration
set [calibrationJson] to (CameraCalibration v1 JSON)
```

Move and tilt the board between intrinsic samples. Put it at the intended stage-world origin for the
last sample; that last detected board defines the `worldFromCameraMatrix`. Resolution is fixed from
the actual Camera Source frame at session start. Sample acceptance requires the complete inner-corner
grid, quality at least 0.2, and normalized corner displacement at least 0.015 from every retained
sample. Between 8 and 40 samples are retained. A solve above the configured reprojection RMS is
rejected without replacing the last validated profile.

The fusion app pipeline consumes PoseFrame2D JSON that WebRTC data channels deliver from every
camera peer, and needs one CameraCalibration v1 profile per camera:

```text
load fusion camera calibration [(camera-1 profile JSON)]
load fusion camera calibration [(camera-2 profile JSON)]
start pose fusion delay [120] ms jitter [80] ms min keypoint score [0.3]
forever:
  buffer PoseFrame2D JSON [(received data channel message)]
  fuse PoseFrame3D at buffered delay
  set [poseJson] to (latest PoseFrame3D JSON)
stop pose fusion
```

Each camera keeps its own timestamp-ordered ring buffer. A frame that arrives out of order inside
the jitter window is inserted at its timestamp position. A frame is counted by
`dropped pose frame count` instead of being buffered when its camera has no loaded profile
(`unknown-camera`), when its `calibrationId` or frame size does not match that profile
(`calibration-mismatch`), when its timestamp is already buffered, when it is older than the jitter
window, and when it is older than the retained window of a full ring. Load every camera profile
before the frames of that camera start arriving.

`fuse PoseFrame3D at buffered delay` fuses the instant one configured delay behind the newest
buffered timestamp, which is why the delay must cover the slowest camera's jitter. Every camera is
resampled at that shared instant: a bracketed keypoint is interpolated linearly, a keypoint that is
occluded on one side of the bracket keeps the visible observation, and a camera without a bracket
holds its nearest frame for at most one jitter window. Use `fuse PoseFrame3D at timestamp [] us` to
fuse an explicit past instant instead.

The synchronized 2D sets are associated across cameras by two-view reprojection error, so one person
never takes two views from the same camera. Each cluster seen by at least two cameras is triangulated
per keypoint with score weighting and a cheirality check, and keeps a stable `person-N` identifier.
When the views of a keypoint disagree, the largest set of views that agree on one point within the
reprojection threshold wins, so a minority of wrong detections is discarded rather than pulling the
keypoint away from the truth. A keypoint left with fewer than two confident views holds its last
triangulated position and reports score `0`.

Transient shortages do not throw and do not replace the last fused frame: `fuse` reports `false`,
`pose fusion state` returns `buffering`, and `pose fusion error code` returns `empty-buffer`,
`insufficient-cameras`, or `no-fused-person`. Frames that cannot be buffered report
`unknown-camera`, `calibration-mismatch`, or `frame-dropped` without throwing, so one misconfigured
peer cannot break a running project script. Invalid JSON, a foreign schema, and an invalid
calibration profile throw.

## Block reference

This section is generated from `src/block-definitions.json`.

<!-- BEGIN GENERATED BLOCKS -->

### `prepare offer QR for peer [PEER]`

Creates a WebRTC offer and prepares one or more QR courier parts.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `prepareOfferQr` |
| `PEER` | String, default: `camera-1` |

### `show offer QR part [INDEX] on this sprite`

Shows the selected one-based offer QR part using a temporary sprite skin.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `showOfferQrPart` |
| `INDEX` | Number, default: `1` |

### `offer QR part count`

Returns the number of prepared offer QR parts, or zero when none is prepared.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `offerQrPartCount` |

### `current offer QR part`

Returns the one-based part currently selected for display, or zero when none is prepared.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `offerQrCurrentPart` |

### `show next offer QR part on this sprite`

Shows the next part and wraps from the last part to the first.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `showNextOfferQrPart` |

### `show offer QR for peer [PEER] on this sprite`

Creates an offer and shows its first QR courier part on this sprite.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `createAndShowOfferQr` |
| `PEER` | String, default: `camera-1` |

### `end offer QR display`

Restores original sprite skins and discards all temporary offer QR data.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `endOfferQrDisplay` |

### `offer QR state`

Returns idle, generating-offer, rendering, displayed, or error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `offerQrState` |

### `offer QR error`

Returns the latest QR pairing error message.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `offerQrError` |

### `start WebGPU MoveNet MultiPose camera [CAMERA_ID] peer [PEER_ID] calibration [CALIBRATION_ID]`

Loads MoveNet MultiPose Lightning on WebGPU and leases a named Camera Source camera.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `startWebGpuMoveNetMultiPose` |
| `CAMERA_ID` | String, default: `pose` |
| `PEER_ID` | String, default: `source-1` |
| `CALIBRATION_ID` | String, default: `uncalibrated` |

### `stop WebGPU MoveNet MultiPose`

Stops inference and releases the detector and camera lease.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `stopWebGpuMoveNetMultiPose` |

### `infer latest pose frame timestamp [CAPTURE_TIMESTAMP_US] us`

Runs at most one inference and carries an opaque synchronized timestamp supplied by the external time service.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `inferNextPoseFrame` |
| `CAPTURE_TIMESTAMP_US` | Number, default: `0` |

### `WebGPU MoveNet ready?`

Reports whether the WebGPU detector and Camera Source lease are ready.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `webGpuMoveNetReady` |

### `pose backend`

Returns the selected TensorFlow.js backend; successful startup always reports webgpu.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseBackend` |

### `pose pipeline state`

Returns the current WebGPU MoveNet pipeline lifecycle state.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `posePipelineState` |

### `pose error code`

Returns a stable code distinguishing WebGPU, model, camera, inference, and output errors.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseErrorCode` |

### `pose error`

Returns the latest detailed pose pipeline error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseError` |

### `latest PoseFrame2D JSON`

Returns the latest protocol-v1 COCO-17 pose frame as JSON, or an empty string before inference.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `latestPoseFrame2D` |

### `protocol JSON [JSON] valid?`

Validates and dispatches one of the five pinned multiview-pose v1 contracts without retaining it.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `protocolJsonValid` |
| `JSON` | String, default: `{}` |

### `decode protocol JSON [JSON]`

Parses, validates, and retains a supported v1 protocol value for later reporters.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `decodeProtocolJson` |
| `JSON` | String, default: `{}` |

### `encode protocol JSON [JSON]`

Validates a supported v1 value and returns its compact JSON encoding.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `encodeProtocolJson` |
| `JSON` | String, default: `{}` |

### `decoded protocol JSON`

Returns the last successfully decoded or encoded protocol value.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `decodedProtocolJson` |

### `protocol schema`

Returns the schema identifier dispatched by the latest validation attempt.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `protocolSchema` |

### `protocol version`

Returns the numeric version dispatched by the latest validation attempt, or zero when unavailable.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `protocolVersion` |

### `protocol error path`

Returns the JSON Pointer path for the latest parse or validation error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `protocolErrorPath` |

### `protocol error message`

Returns the detailed message for the latest parse or validation error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `protocolErrorMessage` |

### `start camera calibration camera [CAMERA_ID] profile [CALIBRATION_ID] board [COLUMNS] by [ROWS] square [SQUARE_METERS] m max error [MAX_ERROR_PX] px`

Leases a named Camera Source video and fixes its real resolution for a chessboard calibration session.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `startCameraCalibration` |
| `CAMERA_ID` | String, default: `pose` |
| `CALIBRATION_ID` | String, default: `calibration-1` |
| `COLUMNS` | Number, default: `9` |
| `ROWS` | Number, default: `6` |
| `SQUARE_METERS` | Number, default: `0.025` |
| `MAX_ERROR_PX` | Number, default: `1.5` |

### `add camera calibration sample`

Detects the full board in the latest shared camera frame and retains it when quality and novelty pass.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `addCameraCalibrationSample` |

### `solve camera calibration`

Solves intrinsic, distortion, and world-from-camera values from at least eight accepted samples.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `solveCameraCalibration` |

### `cancel camera calibration`

Releases the camera lease and temporary samples while preserving the last validated profile.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `cancelCameraCalibration` |

### `cleanup camera calibration`

Releases the session and also clears the last in-memory calibration profile.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `cleanupCameraCalibration` |

### `import CameraCalibration v1 [JSON]`

Imports an exact CameraCalibration v1 JSON profile after schema and credential-boundary validation.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `importCameraCalibration` |
| `JSON` | String, default: `{}` |

### `CameraCalibration v1 [JSON] valid?`

Validates a calibration profile without replacing the last validated profile.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `cameraCalibrationJsonValid` |
| `JSON` | String, default: `{}` |

### `camera calibration ready?`

Reports whether a fixed-resolution camera session can accept a sample or solve.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `cameraCalibrationReady` |

### `camera calibration state`

Returns the current calibration session state.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationState` |

### `camera calibration backend`

Returns the single pinned production solve backend identifier.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationBackend` |

### `camera calibration sample count`

Returns the accepted sample count for the current or last solved session.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationSampleCount` |

### `camera calibration sample quality`

Returns the latest accepted board coverage and sharpness quality score from zero to one.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationSampleQuality` |

### `camera calibration reprojection error px`

Returns the latest solve RMS reprojection error in pixels.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationReprojectionError` |

### `camera calibration error code`

Returns a stable code for board, camera, sample, solve, reprojection, or profile errors.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationErrorCode` |

### `camera calibration error`

Returns the detailed calibration diagnostic.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationError` |

### `CameraCalibration v1 JSON`

Exports the last validated exact v1 profile, or an empty string when none exists.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `cameraCalibrationJson` |

### `start pose fusion delay [DELAY_MS] ms jitter [JITTER_MS] ms min keypoint score [MIN_SCORE]`

Starts the multi-camera jitter buffer that fuses one past instant behind the newest frame.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `startPoseFusion` |
| `DELAY_MS` | Number, default: `120` |
| `JITTER_MS` | Number, default: `80` |
| `MIN_SCORE` | Number, default: `0.3` |

### `stop pose fusion`

Clears every buffered frame and fused result while keeping loaded calibration profiles.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `stopPoseFusion` |

### `cleanup pose fusion`

Clears buffered frames, fused results, and every loaded fusion calibration profile.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `cleanupPoseFusion` |

### `load fusion camera calibration [JSON]`

Loads one CameraCalibration v1 profile and derives its world-to-camera projection.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `loadFusionCameraCalibration` |
| `JSON` | String, default: `{}` |

### `buffer PoseFrame2D JSON [JSON]`

Validates one PoseFrame2D v1 and inserts it into its camera ring buffer in timestamp order.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `bufferPoseFrame2D` |
| `JSON` | String, default: `{}` |

### `fuse PoseFrame3D at buffered delay`

Fuses the instant one configured delay behind the newest buffered timestamp.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `fuseBufferedPoseFrame3D` |

### `fuse PoseFrame3D at timestamp [TIMESTAMP_US] us`

Fuses one explicit past instant expressed in the synchronized microsecond time base.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `fusePoseFrame3DAt` |
| `TIMESTAMP_US` | Number, default: `0` |

### `latest PoseFrame3D JSON`

Returns the last successfully fused twmp/pose-frame-3d version 1 JSON, or an empty string.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `latestPoseFrame3D` |

### `synchronized 2D pose set JSON`

Returns the last resampled per-camera 2D keypoint set used for triangulation.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `synchronizedPoseSet2D` |

### `pose fusion state`

Returns idle, buffering, fusing, ready, or error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionState` |

### `pose fusion ready?`

Returns true when fusion is started and at least two cameras are calibrated.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `poseFusionReady` |

### `fusion calibrated camera count`

Returns how many camera calibration profiles are loaded for fusion.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionCameraCount` |

### `buffered pose frame count`

Returns how many PoseFrame2D frames are currently retained across all ring buffers.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionBufferedFrameCount` |

### `dropped pose frame count`

Returns how many frames were rejected as duplicates or as arrivals past the jitter window.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionDroppedFrameCount` |

### `fused person count`

Returns how many people the last successful fusion produced.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionPersonCount` |

### `fused timestamp us`

Returns the synchronized timestamp of the last successful fusion in microseconds.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionTimestampUs` |

### `fused mean reprojection error px`

Returns the mean reprojection error of the last successful fusion in pixels.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionReprojectionErrorPx` |

### `pose fusion error code`

Returns the latest fusion error code, or an empty string.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionErrorCode` |

### `pose fusion error`

Returns the latest fusion error message.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `poseFusionError` |

<!-- END GENERATED BLOCKS -->

## Important behavior

| Situation | Behavior |
|---|---|
| Feature flag OFF | Blocks are hidden; manual WebRTC pairing is unaffected. |
| Repeated prepare | Existing QR skins and session data are cleaned before creating a new offer. |
| Project stop or disposal | Original skins are restored and temporary skins/session strings are discarded. |
| Stage or clone target | The display command fails explicitly; the initial release supports original sprites only. |
| Missing capability v2 | Offer preparation fails before accessing any unversioned extension internals. |
| Pose feature flag OFF | Pose blocks are hidden; QR and manual pairing remain independent. |
| Non-WebGPU backend | Startup fails with `webgpu-unavailable`; no fallback is attempted. |
| Camera or model failure | `pose error code` distinguishes startup, ended-camera, inference, and invalid-output failures. |
| Pose stop/reload/disposal | In-flight work settles, then the detector and named camera lease are released. |
| Protocol feature flag OFF | Codec blocks are hidden; pose, camera preview, and pairing remain independent. |
| Unknown contract/version | Validation fails at `/schema` or `/version`; no fallback parser is selected. |
| Pairing credential key | Validation fails at its JSON Pointer path and no decoded value is retained. |
| Calibration flag OFF | Calibration blocks are hidden; the other vertical slices remain independent. |
| Resolution changes mid-session | The sample is rejected with `resolution-mismatch`. |
| Weak or duplicate board view | The sample is rejected without entering the solve set. |
| Cancel/reload/disposal | Camera lease and temporary samples are released; the last valid profile remains. |
| Fusion flag OFF | Fusion blocks are hidden; the other vertical slices remain independent. |
| Late or duplicate 2D frame | The frame is counted by `dropped pose frame count` and never enters a ring buffer. |
| Instant without two cameras | Fusion reports `insufficient-cameras`, keeps the last fused frame, and does not throw. |
| Keypoint with fewer than two views | Its last triangulated position is held and its score is reported as `0`. |
| Frame without a matching profile | The frame is dropped with `unknown-camera` or `calibration-mismatch`; it never reaches a ring buffer. |
| Scripts finish running | Buffered frames survive; only the stop button, project reload, and disposal clear them. |
| Fusion stop/reload/disposal | Buffers and fused results are cleared; loaded calibration profiles survive until cleanup. |

The envelope format is `twmp-qr/1`. It includes session, peer, kind, message, zero-based part index,
part count, source length, and SHA-256 metadata. Inputs are capped at 128 KiB and 64 parts.

## Compatibility

| Identifier | Value |
|---|---|
| npm package | `@kubohiroya/turbowarp-multiview-pose` |
| Extension ID | `kubohiroyamultiviewpose` |
| WebRTC capability | `kubohiroyaWebRtcCapability`, version 2 |

## Development

Use Node.js 22.18 or later and the pnpm version declared in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

The jsQR integration test rasterizes every generated part, decodes it with the same jsQR core used
by `turbowarp-jsqr`, shuffles the decoded texts, introduces a duplicate, and verifies exact
reassembly.

Unit tests inject the model and camera ports, verify the protocol payload, six-person limit,
tracking IDs, non-overlap behavior, fail-closed backend checks, and cleanup. They do not execute a
real WebGPU adapter or download the production model; browser/GPU compatibility and throughput
must be verified separately on deployment hardware.

`schemas/protocol-v1-integrity.json` pins the source repository commit and canonical SHA-256 for all
five schemas. Repository checks always compare the runtime TypeBox definitions to those digests and,
when a sibling multiview-pose checkout (or `MULTIVIEW_POSE_PROTOCOL_SCHEMA_DIR`) is available, also
fail on upstream working-copy drift. Contract fixtures are copied from that pinned package and
cross-checked against both the schema and block-facing codec.

Calibration uses one production backend: exact-pinned `@techstark/opencv-js` 4.12.0-release.1. A
requested sample lazily initializes the bundled backend and copies one video frame to a temporary
canvas, then OpenCV WebAssembly performs
chessboard detection, subpixel refinement, `calibrateCamera`, and Rodrigues conversion. There is no
separate CPU reference solver. Bundling the backend makes offline venue use possible but increases
the uncompressed extension bundle by about 11 MB. Unit tests inject the backend and Camera Source;
real camera, printed-board, OpenCV WASM initialization, and geometric accuracy require browser E2E
validation on deployment hardware.

## Rollback

Set `qrCourierPairing` to `false` before extension startup, stop the project to release temporary
skins, and use TurboWarp WebRTC's manual offer/answer copy-and-paste blocks. QR transport does not
change the WebRTC pairing code or protocol.
To roll back pose inference only, set `webgpuMoveNetMultiPose` to `false` before startup and reload
the project. Camera preview and pairing blocks remain independently available.
Set `protocolV1Codec` to `false` to remove the high-level codec blocks; unsupported versions remain
rejected rather than falling back to v1.
Set `cameraCalibrationV1` to `false` to stop new calibration sessions. Cancel before reload to release
temporary samples; retain and use only a previously validated exact v1 profile.

## License

[Mozilla Public License 2.0](LICENSE) (SPDX: `MPL-2.0`). Bundled third-party software is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
