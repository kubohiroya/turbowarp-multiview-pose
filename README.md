# TurboWarp Realtime Motion Capture

[日本語](README.ja.md)

**Documentation:** [TurboWarp extension API](docs/turbowarp-extension-api.md) ·
[Architecture](docs/architecture.md) ·
[Machine-readable manifest](dist/extension-manifest.json)

Composite TurboWarp blocks for camera and fusion applications using multiview pose estimation.

## What it does

- Displays WebRTC offer pairing codes as multipart QR sprites.
- Runs WebGPU MoveNet MultiPose for up to six people and reports PoseFrame2D v1/v2 JSON.
- Validates the owned multiview-pose JSON contracts.
- Calibrates shared cameras with a chessboard and OpenCV.js.
- Retargets external PoseFrame3D v1 data to declarative A-Frame avatar rigs.
- Measures camera timing, fuses synchronized 2D poses into 3D, and identifies performers by glow sticks.

## Requirements and safety

- TurboWarp with trusted unsandboxed custom extensions enabled.
- WebRTC 0.3.0 for QR/time, Camera Source 0.5.0 for video, and A-Frame 0.3.0 for avatars.
- TensorFlow.js WebGPU support for pose and WebAssembly support for calibration.

All features are startup-fixed and OFF by default. MoveNet has no CPU, WASM, or WebGL fallback and
its first model load can require network access. Pairing QR codes can expose ICE credentials and
local addresses; display and retain them only in a trusted environment. See the
[API reference](docs/turbowarp-extension-api.md) for exact dependencies and cleanup behavior.

## Installation

Load provider extensions first, then load `dist/turbowarp-realtime-motion-capture.js` as an unsandboxed custom
extension. The usual order is Camera Source, WebRTC, A-Frame, then Realtime Motion Capture; providers that are
not used may be omitted. A version-pinned package URL is:

```text
https://cdn.jsdelivr.net/npm/@kubohiroya/turbowarp-realtime-motion-capture@0.2.1/dist/turbowarp-realtime-motion-capture.js
```

The npm package distributes a standalone browser bundle, schemas, and documentation. It does not
publish a JavaScript or TypeScript Composition API. Integrate through the TurboWarp blocks and the
versioned runtime capabilities described in the [API reference](docs/turbowarp-extension-api.md).

Set the required features once before loading the extension:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {
  qrCourierPairing: true,
  webgpuMoveNetMultiPose: true,
  frameSyncPatternV1: true,
  poseFusion3D: true,
  glowStickMarkers: true,
};
```

Omitted features remain disabled. Reload the editor and extension after changing the object.

## Quick start

```text
prepare offer QR for peer [camera-1]
show offer QR part [1] on this sprite
repeat until courier photography is complete:
  show next offer QR part on this sprite
end offer QR display
```

Part indices exposed to blocks are one-based. Continue with the feature-specific workflows in the
[API reference](docs/turbowarp-extension-api.md).

## Block reference

This section is generated from `src/block-definitions.json`. For lifecycle values, errors, JSON
contracts, and avatar rig format, see the [complete API reference](docs/turbowarp-extension-api.md).

<!-- BEGIN GENERATED BLOCKS -->

See the [TurboWarp extension API](docs/turbowarp-extension-api.md) for every block.

<!-- END GENERATED BLOCKS -->

## Compatibility

| Identifier         | Value                                            |
| ------------------ | ------------------------------------------------ |
| npm package        | `@kubohiroya/turbowarp-realtime-motion-capture`           |
| Extension ID       | `kubohiroyarealtimemotioncapture`                        |
| WebRTC capability  | `kubohiroyaWebRtcCapability`, version 2          |
| Extension manifest | `dist/extension-manifest.json`, format version 1 |

## Development

Use Node.js 22.18 or later and the pnpm version declared in `package.json`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

Implementation and release details are documented in [Architecture](docs/architecture.md).

## Rollback

Set the affected startup flag to `false`, stop the project to release temporary resources, and reload
the editor. The eight feature groups are independent; QR pairing can fall back to WebRTC's manual
offer/answer blocks. Detailed rollback behavior is in the [API reference](docs/turbowarp-extension-api.md).

## License

[Mozilla Public License 2.0](LICENSE) (SPDX: `MPL-2.0`). Bundled third-party software is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
