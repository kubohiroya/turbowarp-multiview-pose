# TurboWarp extension API

[User guide](../README.md) | [日本語](turbowarp-extension-api.ja.md) | [Architecture](architecture.md)

This is the public API reference for `@kubohiroya/turbowarp-multiview-pose` 0.2.0.
The supported integration surface is the unsandboxed TurboWarp extension: its extension ID,
opcodes, arguments, reporters, JSON contracts, and runtime capabilities. The TypeScript classes
under `src/` are implementation details and are not package exports.

## API identity and loading

| Item                 | Contract                                            |
| -------------------- | --------------------------------------------------- |
| Extension ID         | `kubohiroyamultiviewpose`                           |
| Bundle               | `dist/turbowarp-multiview-pose.js`                  |
| Machine-readable API | `dist/extension-manifest.json` (`formatVersion: 1`) |
| Execution mode       | Unsandboxed only                                    |
| Feature selection    | Startup-fixed; every feature is OFF by default      |

Load required provider extensions before this extension. Configure all desired features in one
assignment before loading the bundle:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {
  qrCourierPairing: true,
  webgpuMoveNetMultiPose: true,
  protocolV1Codec: true,
  cameraCalibrationV1: true,
  avatarRetargetV1: true,
  frameSyncPatternV1: true,
  poseFusion3D: true,
  glowStickMarkers: true,
};
globalThis.__TWMP_QR_CONFIG__ = { errorCorrectionLevel: "M" };
```

Only blocks belonging to enabled features appear in the palette. Changing the global object after
the extension has loaded has no effect; reload the project and extension after changing flags.

## Runtime dependencies

| Feature                  | Required provider             | Runtime boundary                        |
| ------------------------ | ----------------------------- | --------------------------------------- |
| `qrCourierPairing`       | TurboWarp-WebRTC 0.3.0        | `kubohiroyaWebRtcCapability`, version 2 |
| `webgpuMoveNetMultiPose` | TurboWarp-Camera-Source 0.5.0 | `acquireCamera({owner, cameraId})`      |
| `protocolV1Codec`        | None                          | Local validation only                   |
| `cameraCalibrationV1`    | TurboWarp-Camera-Source 0.5.0 | Shared named camera lease               |
| `avatarRetargetV1`       | TurboWarp-A-Frame 0.3.0       | Scene capability, version 1             |
| `frameSyncPatternV1`     | Camera Source 0.5.0 and WebRTC 0.3.0 | Camera frames and synchronized time |
| `poseFusion3D`           | None                           | PoseFrame2D and calibration JSON supplied through blocks |
| `glowStickMarkers`       | Pose and fusion features       | Camera pixels, Performance DSL palette, and identity fusion |

The extension does not call `getUserMedia()`. Pose and calibration features lease a camera owned by
Camera Source. MoveNet requires the TensorFlow.js `webgpu` backend and has no CPU, WASM, or WebGL
fallback. The first model load can require network access.

## Calling and error conventions

- Commands may throw. In TurboWarp, wait for a command block to finish before consuming its result.
- Reporter strings use `""` when no value or error is available. Count reporters use `0`.
- JSON arguments are strings, not Scratch lists or JavaScript objects.
- Pose, calibration, and avatar IDs accept 1–64 ASCII letters, digits, `.`, `_`, and `-`.
- The offer QR `PEER` value accepts 1–128 characters after surrounding whitespace is removed; this
  extension imposes no additional character-class restriction on it.
- Concurrent pose inference, calibration sampling, or calibration solving calls share their current
  in-flight operation; they do not create an unbounded queue.
- Project stop, project reload, and runtime disposal release temporary skins, detectors, camera
  leases, calibration samples, avatar instances, and in-memory retarget state.

## State and diagnostic reporters

| Area        | State values                                                                                                                | Diagnostic values                                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer QR    | `disabled`, `idle`, `generating-offer`, `rendering`, `displayed`, `error`                                                   | `offer QR error`                                                                                                                                                                                                                                                                            |
| Pose        | `disabled`, `idle`, `initializing-webgpu`, `loading-model`, `acquiring-camera`, `ready`, `inferencing`, `stopping`, `error` | `webgpu-unavailable`, `model-load-failed`, `camera-unavailable`, `camera-ended`, `inference-failed`, `invalid-output`                                                                                                                                                                       |
| Protocol    | latest schema/version, or `disabled`/`0`                                                                                    | JSON Pointer path and message                                                                                                                                                                                                                                                               |
| Calibration | `disabled`, `idle`, `acquiring-camera`, `sampling`, `ready`, `solving`, `solved`, `cancelling`, `error`                     | `invalid-board`, `camera-unavailable`, `camera-ended`, `resolution-mismatch`, `board-not-found`, `sample-low-quality`, `sample-too-similar`, `sample-limit`, `sample-insufficient`, `sample-failed`, `solve-failed`, `reprojection-too-high`, `invalid-calibration`, `credential-forbidden` |
| Avatar      | `disabled`, `idle`, `configured`, `bound`, `ready`, `partial`, `error`                                                      | Per-person messages in `avatar retarget error`                                                                                                                                                                                                                                              |
| Frame sync  | `idle`, `acquiring-camera`, `calibrating`, `ready`, `error`                                                                  | `panel-not-found`, `low-contrast`, `decode-unstable`, camera and runtime diagnostics |
| Pose fusion | `idle`, `buffering`, `fusing`, `ready`, `error`                                                                              | `pose fusion error code` and `pose fusion error` |

Rejected calibration samples set an error code but leave a valid session ready for another sample.
`cancel camera calibration` preserves the last validated profile; `cleanup camera calibration`
also removes that profile.

## JSON contracts

The protocol codec accepts exactly these schema/version pairs:

| `schema`                  | `version` | Principal limits                                                            |
| ------------------------- | --------: | --------------------------------------------------------------------------- |
| `twmp/session-policy`     |         1 | 1–16 cameras; at most 6 performers                                          |
| `twmp/camera-calibration` |         1 | 3x3 intrinsic matrix, up to 14 distortion coefficients, 4x4 world transform |
| `twmp/pose-frame-2d`      |         1 | At most 6 persons; ordered COCO-17 tuple; pixel coordinates                 |
| `twmp/pose-frame-2d`      |         2 | Version 1 fields plus sampled color markers                                |
| `twmp/pose-frame-3d`      |         1 | At most 6 persons; 2–16 unique camera IDs; ordered COCO-17 tuple; meters    |
| `twmp/performance-dsl`    |         1 | 1–6 performers and their glow-stick colors                                 |

Unknown fields, schemas, and versions are rejected. Keys associated with WebRTC pairing secrets
(`offer`, `answer`, SDP, ICE, DTLS, and credential forms) are rejected recursively. Timestamps are
non-negative safe integers in microseconds and remain opaque; synchronization is external.

The 17 keypoints must appear in this exact order:

```text
nose, left_eye, right_eye, left_ear, right_ear,
left_shoulder, right_shoulder, left_elbow, right_elbow,
left_wrist, right_wrist, left_hip, right_hip,
left_knee, right_knee, left_ankle, right_ankle
```

## Avatar rig JSON

`register avatar asset` accepts an A-Frame template JSON string and a separate rig mapping. Every
bone selector must contain `{avatar}`, which is replaced with the bound instance ID, and must match
exactly one node.

```json
{
  "rootScale": 1,
  "rootOffset": [0, 0, 0],
  "recognitionStartEvent": "twmp-recognition-start",
  "recognitionEndEvent": "twmp-recognition-end",
  "bones": [
    {
      "selector": "#{avatar}-left-arm",
      "rig": "LeftUpperArm",
      "offsetDegrees": [0, 0, 0]
    }
  ]
}
```

Supported `rig` values are `RightUpperArm`, `RightLowerArm`, `LeftUpperArm`, `LeftLowerArm`,
`RightHand`, `LeftHand`, `RightUpperLeg`, `RightLowerLeg`, `LeftUpperLeg`, `LeftLowerLeg`, `Spine`,
and `Hips`. `rootScale` must be positive, confidence thresholds are from 0 through 1, and a rig may
contain 1–32 bones. Recognition event data is compact JSON containing `personId`,
`avatarInstanceId`, and, when supplied by PoseFrame3D, `timestampUs`.

## Block reference

This section is generated from `src/block-definitions.json`. Block text is the English palette text;
opcodes and argument IDs are stable project-storage identifiers.

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

### `sample glow stick colors at [KEYPOINTS]`

Samples the named COCO-17 keypoints for a uniquely colored glow stick and reports PoseFrame2D v2.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `enableGlowStickMarkers` |
| `KEYPOINTS` | String, default: `right_wrist,left_wrist` |

### `stop sampling glow stick colors`

Returns pose reporting to PoseFrame2D v1 without glow stick markers.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `disableGlowStickMarkers` |

### `glow stick marker count`

Returns how many glow stick markers the latest pose frame carries.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `glowStickMarkerCount` |

### `load glow stick palette from PerformanceDSL [JSON]`

Loads the performer colors from a Performance DSL v1 payload for fusion identity.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `loadGlowStickPalette` |
| `JSON` | String, default: `{}` |

### `set performer [PERFORMER_ID] glow stick at [KEYPOINT]`

Chooses which COCO-17 keypoint one performer carries the glow stick at.

| Property | Value |
|---|---|
| Type | Command |
| Opcode | `setPerformerGlowStick` |
| `PERFORMER_ID` | String, default: `actor-1` |
| `KEYPOINT` | String, default: `right_wrist` |

### `glow stick palette size`

Returns how many performers the loaded palette describes.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `glowStickPaletteSize` |

### `identified performer count`

Returns how many fused people the last fusion identified by glow stick color.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `identifiedPerformerCount` |

### `mirror-corrected view count`

Returns how many camera views the last fusion corrected for swapped left and right labels.

| Property | Value |
|---|---|
| Type | Reporter |
| Opcode | `mirrorCorrectedViewCount` |

<!-- END GENERATED BLOCKS -->

## Compatibility policy

Adding a block is backward-compatible. Renaming the extension ID, an opcode, or an argument ID can
break stored `.sb3` projects and requires a migration. A manifest `formatVersion` change denotes an
incompatible manifest-format revision. Consumers should fail closed on unknown versions rather than
reading private runtime fields.
