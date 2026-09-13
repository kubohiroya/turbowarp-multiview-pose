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

## 要件と安全性

- unsandboxed custom extensionを利用できるTurboWarp
- 先に読み込まれた、runtime capability v2対応の`@kubohiroya/turbowarp-webrtc`
- 起動前に明示的に有効化する`qrCourierPairing` feature flag（既定OFF）

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {qrCourierPairing: true};
globalThis.__TWMP_QR_CONFIG__ = {errorCorrectionLevel: "M"}; // L, M, Q, H
```

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

## 開発

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

生成QRはjsQR coreでdecodeし、順不同・重複を含むscanから元のpairing codeへ完全一致で
再構成するintegration testを含みます。

## ロールバック

起動前に`qrCourierPairing`をOFFにし、projectを停止して一時skinを解放したあと、
TurboWarp WebRTCのmanual copy/paste pairingへ戻します。

## ライセンス

[Mozilla Public License 2.0](LICENSE)（SPDX: `MPL-2.0`）。third-party softwareは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載します。
