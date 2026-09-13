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
- Retargets external PoseFrame3D v1 data onto up to six declarative A-Frame avatar rigs.

- Shows a time coded pattern and decodes it per camera to measure frame recording latency.

## Requirements and safety

- TurboWarp with custom unsandboxed extensions enabled.
- `@kubohiroya/turbowarp-webrtc` 0.3.0 with runtime capability v2, loaded first.
- `@kubohiroya/turbowarp-camera-source` 0.5.0, loaded before pose startup.
- A browser and GPU combination supported by TensorFlow.js WebGPU.
- WebAssembly support for the bundled OpenCV.js 4.12 calibration backend.
- `@kubohiroya/turbowarp-aframe` 0.3.0 with scene capability v1, loaded before avatar setup.
- The frame sync decoder needs Camera Source and the WebRTC synchronized time reporter.
- The startup-fixed feature flags are independently OFF by default.

Scene capability v1 is published in `@kubohiroya/turbowarp-aframe@0.3.0`. The consumer fails closed
when capability v1 is absent.

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

Enable avatar retargeting independently:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {avatarRetargetV1: true};
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

The avatar retarget vertical slice is:

```text
register avatar asset [actor] template JSON [(templateJson)] rig JSON [(rigJson)]
bind person [performer-1] to avatar [avatar-1] asset [actor] under [#scene] confidence [0.3]
forever:
  apply PoseFrame3D [(externalPoseFrame3D)] with PoseFrame2D [(matchingPoseFrame2D)] to avatars
```

Rig JSON maps Kalidokit pose outputs to declarative A-Frame template selectors containing
`{avatar}`. The controller matches PoseFrame3D `personId` to PoseFrame2D `trackingId`, adapts both
COCO-17 records deterministically to BlazePose-33, and uses exact-pinned `kalidokit@1.1.5`
`Pose.solve` as its only rotation solver. PoseFrame2D coordinates are normalized using its declared
frame size. Missing hand, foot, and face landmarks are duplicated or interpolated with deliberately
low visibility; this compatibility adapter is less precise than native BlazePose-33 input. The root
uses Kalidokit's hips result plus the configured scale and offset. A low-confidence or missing joint
preserves that bone's last transform; one missing or invalid performer does not stop other bindings.
Recognition transitions emit configurable A-Frame events (default
`twmp-recognition-start` and `twmp-recognition-end`) from the avatar root.

PoseFrame3D is boundary data produced by a separate 3D service. This extension carries its opaque
`timestampUs` into recognition events only; it does not align frames, retain/query history,
triangulate observations, or solve 3D coordinates. Kalidokit is deprecated upstream and was designed
for BlazePose landmarks, so release validation must include the intended GLTF rigs and real browser
motion; no custom solver fallback is provided.

The frame sync vertical slice measures how long after the projected pattern each camera computer
finishes recording a frame:

```text
(the computer driving the projector)
show frame sync pattern

(every camera computer)
start frame sync decoder for camera [camera-1] calibrating for [8] seconds
repeat until <the measurement window is over>:
  if <frame sync observation available?> then
    take next frame sync observation
    record frame sync sample for camera [camera-1]
      capture (frame sync frame timestamp us) pattern (frame sync pattern timestamp us)
      wrap (frame sync pattern wrap us) from peer [fusion]
send frame sync report for camera [camera-1] to peer [fusion]
stop frame sync decoder
```

The pattern is a 4 by 4 grid. Twelve cells carry a millisecond counter that wraps every 4096 ms and
four cells carry check bits, so a reading whose exposure straddled a display refresh is discarded
instead of being reported as a wrong time. Calibration locates the panel by watching which pixels
change over time, learns the light and dark level of every cell, and fails with `panel-not-found`,
`low-contrast`, or `decode-unstable` rather than producing numbers it cannot stand behind. The
window must be at least 6.2 seconds: the slowest cell changes once per 2048 ms and calibration
spends only part of the window learning levels, so a shorter window can leave a cell at one level
and fail for a reason the operator cannot act on.

`frame sync frame timestamp us` is the moment this computer finished recording the frame, read from
the same external synchronized time service as `captureTimestampUs`. Subtract `frame sync frame age
us` from it when the sensor exposure time is wanted instead. The clock probe, the latency samples,
and the aggregated per-camera report live in `@kubohiroya/turbowarp-webrtc`; a delay that every
camera shares, such as the projector, stays in the absolute latency and cancels out of the
per-camera offsets.

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

### `register avatar asset [ASSET_ID] template JSON [TEMPLATE_JSON] rig JSON [RIG_JSON]`

Registers an A-Frame 0.3.0 template and its Kalidokit rig-output selector mapping.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `registerAvatarAsset` |
| `ASSET_ID` | String, default: `actor` |
| `TEMPLATE_JSON` | String, default: `{"type":"group","children":[]}` |
| `RIG_JSON` | String, default: `{"bones":[{"selector":"#{avatar}-left-arm","rig":"LeftUpperArm"}]}` |

### `bind person [PERSON_ID] to avatar [INSTANCE_ID] asset [ASSET_ID] under [PARENT] confidence [CONFIDENCE]`

Creates an avatar instance and binds one PoseFrame3D person ID to it.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `bindAvatarPerson` |
| `PERSON_ID` | String, default: `performer-1` |
| `INSTANCE_ID` | String, default: `avatar-1` |
| `ASSET_ID` | String, default: `actor` |
| `PARENT` | String, default: `#scene` |
| `CONFIDENCE` | Number, default: `0.3` |

### `unbind avatar for person [PERSON_ID]`

Emits recognition end, removes the created avatar instance, and clears its binding.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `unbindAvatarPerson` |
| `PERSON_ID` | String, default: `performer-1` |

### `apply PoseFrame3D [POSE3D_JSON] with PoseFrame2D [POSE2D_JSON] to avatars`

Adapts corresponding exact v1 frames to BlazePose-33, solves only with Kalidokit, and applies up to six rigs.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `applyPoseFrame3DToAvatars` |
| `POSE3D_JSON` | String, default: `{}` |
| `POSE2D_JSON` | String, default: `{}` |

### `reset avatar retarget state`

Removes retarget-created instances and clears assets, bindings, effects, and diagnostics after a scene reset.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `resetAvatarRetarget` |

### `avatar binding count`

Returns the current person-to-avatar binding count, at most six.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `avatarBindingCount` |

### `avatars updated by last frame`

Returns how many bound avatars accepted the last PoseFrame3D.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `avatarUpdatedCount` |

### `avatar retarget state`

Returns disabled, idle, configured, bound, ready, partial, or error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `avatarRetargetState` |

### `avatar retarget error`

Returns per-person errors from the latest frame while other avatars continue updating.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `avatarRetargetError` |

### `show frame sync pattern`

Covers the screen with the time coded pattern that cameras decode through the projector.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `showFrameSyncPattern` |

### `hide frame sync pattern`

Removes the frame sync pattern overlay.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `hideFrameSyncPattern` |

### `frame sync pattern shown?`

Reports whether the frame sync pattern overlay is on screen.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `frameSyncPatternShown` |

### `frame sync pattern wrap us`

Returns the period after which the encoded display time repeats, in microseconds.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncPatternWrapUs` |

### `start frame sync decoder for camera [CAMERA_ID] calibrating for [SECONDS] seconds`

Leases the camera, locates the projected pattern, learns its light and dark levels, and reports failure when readings do not decode often enough. The window must be at least 6.2 seconds so that every pattern cell changes at least once.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `startFrameSyncDecoder` |
| `CAMERA_ID` | String, default: `camera-1` |
| `SECONDS` | Number, default: `8` |

### `calibrate frame sync decoder for [SECONDS] seconds`

Runs calibration again on the running decoder, for example after the camera or the projector moved. The window must be at least 6.2 seconds so that every pattern cell changes at least once.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `calibrateFrameSyncDecoder` |
| `SECONDS` | Number, default: `8` |

### `stop frame sync decoder`

Stops decoding and releases the camera lease.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `stopFrameSyncDecoder` |

### `frame sync decoder state`

Returns idle, acquiring-camera, calibrating, ready, or error.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncDecoderState` |

### `frame sync decoder error`

Returns the last decoder error code, or an empty string when there is none.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncDecoderError` |

### `frame sync decode rate`

Returns the share of recent camera frames the decoder could read, between 0 and 1.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncDecodeRate` |

### `frame sync observation available?`

Reports whether a decoded frame is waiting to be taken.

| Property | Value |
|---|---|
| Type | Boolean |
| Opcode | `frameSyncObservationAvailable` |

### `take next frame sync observation`

Removes the oldest decoded frame from the queue and exposes it to the observation reporters.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `takeFrameSyncObservation` |

### `frame sync frame timestamp us`

Returns when this computer finished recording the taken frame, read from the external synchronized time service.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncFrameTimestampUs` |

### `frame sync frame age us`

Returns how old the taken frame already was when the browser delivered it, or 0 when the browser does not report a capture time.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncFrameAgeUs` |

### `frame sync pattern timestamp us`

Returns the display time decoded out of the taken frame, within the current pattern wrap window.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `frameSyncPatternTimestampUs` |

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

Avatar tests inject A-Frame scene capability v1 and exercise exact PoseFrame3D validation, root and
bone transforms, confidence handling, six-person limits, per-person failure isolation, recognition
events, rebind, scene-reset detection, and cleanup. A real A-Frame scene, GLTF asset, and avatar rig
still require browser E2E validation.

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
Set `avatarRetargetV1` to `false` before startup to remove retarget blocks while preserving the
generic A-Frame scene graph and static avatars.

## License

[Mozilla Public License 2.0](LICENSE) (SPDX: `MPL-2.0`). Bundled third-party software is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
