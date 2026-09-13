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
