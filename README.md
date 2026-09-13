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

## Requirements and safety

- TurboWarp with custom unsandboxed extensions enabled.
- `@kubohiroya/turbowarp-webrtc` with runtime capability v2, loaded first.
- The startup-fixed `qrCourierPairing` feature flag is OFF by default.

Set the flag before loading the extension:

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {qrCourierPairing: true};
globalThis.__TWMP_QR_CONFIG__ = {errorCorrectionLevel: "M"}; // L, M, Q, or H
```

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

<!-- END GENERATED BLOCKS -->

## Important behavior

| Situation | Behavior |
|---|---|
| Feature flag OFF | Blocks are hidden; manual WebRTC pairing is unaffected. |
| Repeated prepare | Existing QR skins and session data are cleaned before creating a new offer. |
| Project stop or disposal | Original skins are restored and temporary skins/session strings are discarded. |
| Stage or clone target | The display command fails explicitly; the initial release supports original sprites only. |
| Missing capability v2 | Offer preparation fails before accessing any unversioned extension internals. |

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

## Rollback

Set `qrCourierPairing` to `false` before extension startup, stop the project to release temporary
skins, and use TurboWarp WebRTC's manual offer/answer copy-and-paste blocks. QR transport does not
change the WebRTC pairing code or protocol.

## License

[Mozilla Public License 2.0](LICENSE) (SPDX: `MPL-2.0`). Bundled third-party software is listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
