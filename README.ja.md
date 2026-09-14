# TurboWarp Realtime Motion Capture

[English](README.md)

**ドキュメント:** [TurboWarp機能拡張API](docs/turbowarp-extension-api.ja.md) ·
[アーキテクチャ](docs/architecture.ja.md) ·
[機械可読manifest](dist/extension-manifest.json)

multiview pose estimationを使うcamera／fusion application向けの複合TurboWarp機能拡張です。

## できること

- WebRTC offer pairing codeを複数のQR spriteとして表示します。
- WebGPU MoveNet MultiPoseで最大6人を追跡し、PoseFrame2D v1／v2 JSONを返します。
- このpackageが所有するmultiview-pose JSON contractを検証します。
- chessboardとOpenCV.jsで共有cameraをcalibrationします。
- 外部PoseFrame3D v1を宣言的なA-Frame avatar rigへretargetします。
- camera timingを計測し、同期した2D poseを3Dへ統合して、サイリウムで演者を識別します。

## 要件と安全性

- 信頼できるunsandboxed custom extensionを利用できるTurboWarp
- QR／時刻用WebRTC 0.3.0、video用Camera Source 0.5.0、avatar用A-Frame 0.3.0
- 姿勢推定用TensorFlow.js WebGPUとcalibration用WebAssembly

全機能は起動時固定・既定OFFです。MoveNetにCPU／WASM／WebGL fallbackはなく、初回model loadは
network接続を必要とする場合があります。QRにはICE credentialやlocal addressが含まれ得るため、
信頼できる環境だけで表示・保管してください。正確な依存関係とcleanupは
[APIリファレンス](docs/turbowarp-extension-api.ja.md)を参照してください。

## 使い方

provider拡張を先に読み込み、その後に`dist/turbowarp-realtime-motion-capture.js`をサンドボックスなしの
custom extensionとして読み込みます。通常の順序はCamera Source、WebRTC、A-Frame、Realtime Motion Capture
です。使わないproviderは省略できます。

version固定CDN URL:

```text
https://cdn.jsdelivr.net/npm/@kubohiroya/turbowarp-realtime-motion-capture@0.2.0/dist/turbowarp-realtime-motion-capture.js
```

npm packageが公開するのはbrowser向けstandalone bundle、schema、文書です。Composition APIは
公開していません。TurboWarp blockとversion管理されたruntime capabilityを通じて連携します。

拡張を読み込む前に、必要な機能を1回だけ設定します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {
  qrCourierPairing: true,
  webgpuMoveNetMultiPose: true,
  frameSyncPatternV1: true,
  poseFusion3D: true,
  glowStickMarkers: true,
};
```

省略した機能は無効です。変更後はeditorと拡張を再読み込みしてください。

```text
prepare offer QR for peer [camera-1]
show offer QR part [1] on this sprite
show next offer QR part on this sprite
end offer QR display
```

block上のpart番号は1始まりです。姿勢推定、protocol、calibration、avatarのworkflowは
[APIリファレンス](docs/turbowarp-extension-api.ja.md)へまとめています。

## 開発

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

実装・releaseの詳細は[アーキテクチャ](docs/architecture.ja.md)に記載しています。

## ロールバック

対象feature flagを`false`にし、projectを停止して一時resourceを解放してからeditorを再読み込み
します。8つの機能は独立しています。QRはWebRTCのmanual offer／answer blockへ切り戻せます。
詳細は[APIリファレンス](docs/turbowarp-extension-api.ja.md)を参照してください。

## ライセンス

[Mozilla Public License 2.0](LICENSE)（SPDX: `MPL-2.0`）。third-party softwareは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載します。
