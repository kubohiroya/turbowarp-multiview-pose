# TurboWarp-Multiview-Pose

[English](README.md)

multiview-poseの`camera app`と`fusion app`を構築するための複合TurboWarp機能拡張です。
最初の縦切りとして、名前付きpeerのWebRTC offerをQR courier partへ分割し、一時的な
スプライトskinとして表示します。

## できること

- version管理されたTurboWarp WebRTC runtime capabilityからofferを生成します。
- pairing codeを変更せず、単独で読める`twmp-qr/1` envelopeへ分割します。
- QR Version 40までのlossless SVGを生成し、実行中スプライトに表示します。
- 終了時に元のskinを復元し、一時skinとpairing情報を破棄します。
- TensorFlow.js WebGPU限定でMoveNet MultiPose Lightningを実行し、最大6人を追跡します。
- COCO-17観測を`twmp/pose-frame-2d` version 1 JSONとして取得できます。

## 要件と安全性

- unsandboxed custom extensionを利用できるTurboWarp
- 先に読み込まれた、runtime capability v2対応の`@kubohiroya/turbowarp-webrtc`
- 姿勢推定より先に読み込まれた`@kubohiroya/turbowarp-camera-source` 0.4以降
- TensorFlow.js WebGPUに対応するbrowser／GPU
- 起動前に明示的に有効化する`qrCourierPairing` feature flag（既定OFF）

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {qrCourierPairing: true};
globalThis.__TWMP_QR_CONFIG__ = {errorCorrectionLevel: "M"}; // L, M, Q, H
```

姿勢推定は独立して有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {webgpuMoveNetMultiPose: true};
```

起動時にTensorFlow.js backendとして`webgpu`を明示選択し、それ以外なら
`webgpu-unavailable`でfail closedします。CPU／WASM／WebGL推論fallbackはありません。
本機能拡張は`getUserMedia()`を呼ばず、先に読み込んだ`turbowarp-camera-source`の
`acquireCamera()`からnamed camera leaseを取得します。初回model loadは通常TensorFlow Hubへ
接続するため、会場LANをofflineにする前にmodelをcacheしてください。

pairing codeにはLAN address、ICE credential、DTLS fingerprintが含まれる場合があります。
信頼できる会場内だけで表示し、撮影画像はpairing後に削除してください。本機能拡張は
QR画像をuploadせず、project costumeとして永続化しません。

## 使い方

```text
prepare offer QR for peer [camera-1]
show offer QR part [1] on this sprite
show next offer QR part on this sprite
end offer QR display
```

block上のpart番号は1始まり、wire envelopeの`partIndex`は0始まりです。project停止、
機能拡張dispose、表示終了時には元skinを復元して一時dataを破棄します。Stageとcloneへの
表示は初期版では対応せず、明示的なerrorにします。

```text
start WebGPU MoveNet MultiPose camera [pose] peer [source-1] calibration [calibration-1]
forever:
  infer latest pose frame
  set [poseJson] to (latest PoseFrame2D JSON)
stop WebGPU MoveNet MultiPose
```

同時に呼ばれた推論は1件のin-flight処理へまとめ、古いframe requestをqueueしません。
stop、project reload、dispose時にはdetectorとcamera leaseを解放します。

## 開発

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

生成QRはjsQR coreでdecodeし、順不同・重複を含むscanから元のpairing codeへ完全一致で
再構成するintegration testを含みます。

unit testではmodel／camera portを注入し、protocol、6人上限、tracking ID、推論非重複、
backend fail closed、cleanupを検証します。実WebGPU adapterとproduction model downloadは
test環境では実行しないため、実機browser／GPUで互換性とthroughputを別途検証します。

## ロールバック

起動前に`qrCourierPairing`をOFFにし、projectを停止して一時skinを解放したあと、
TurboWarp WebRTCのmanual copy/paste pairingへ戻します。
姿勢推定だけを切り戻す場合は、起動前に`webgpuMoveNetMultiPose`をOFFにしてprojectを
再読み込みします。camera previewとpairing blockは独立して利用できます。

## ライセンス

[Mozilla Public License 2.0](LICENSE)（SPDX: `MPL-2.0`）。third-party softwareは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載します。
