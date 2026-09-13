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
- multiview-poseの5種類のv1 application contractを検証し、JSONをround-tripします。
- 共有cameraによるchessboardのintrinsic／world-extrinsic calibration workflowを提供します。
- jitterを含むPoseFrame2D streamをcameraごとにbufferingし、過去の同一瞬間で再sampleします。
- 同期した2D setを三角測量し、`twmp/pose-frame-3d` version 1の3D poseへ統合します。

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

5契約codecも独立した既定OFF flagで有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {protocolV1Codec: true};
```

camera calibrationも独立して有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {cameraCalibrationV1: true};
```

多視点3D pose fusionも独立して有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {poseFusion3D: true};
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
  infer latest pose frame timestamp [(同期済みtimestamp us)] us
  set [poseJson] to (latest PoseFrame2D JSON)
stop WebGPU MoveNet MultiPose
```

同時に呼ばれた推論は1件のin-flight処理へまとめ、古いframe requestをqueueしません。
stop、project reload、dispose時にはdetectorとcamera leaseを解放します。

protocol codecはpayloadの`schema`と`version`から、SessionPolicy、CameraCalibration、
PoseFrame2D、PoseFrame3D、Performance DSLの明示対応v1へdispatchします。
unknown field／versionはfail closedし、診断をJSON Pointer pathとmessageで取得できます。
offer、answer、SDP、ICE、DTLS、credentialに相当するkeyは再帰的に拒否し、pairing secretを
永続application contractへ混入させません。

`captureTimestampUs`とPoseFrame3Dの`timestampUs`は、別実装の同期済みlocal time serviceが
与える不透明値です。本機能拡張は値を変更せず運び、clock初期化、offset推定、probe、ping、
pongのlogicを持ちません。

camera app／fusion app共用のcalibration workflowは次のとおりです。

```text
start camera calibration camera [pose] profile [calibration-1] board [9] by [6]
  square [0.025] m max error [1.5] px
repeat until <camera calibration sample count = 8>:
  add camera calibration sample
solve camera calibration
set [calibrationJson] to (CameraCalibration v1 JSON)
```

intrinsic sampleごとにboardを移動・傾斜させ、最後のsampleではboardを舞台world原点に置きます。
最後のboard poseから`worldFromCameraMatrix`を作成します。session開始時のCamera Source実frame
解像度を固定し、途中変更を拒否します。完全なinner corner grid、quality 0.2以上、保持sample
すべてに対する正規化corner変位0.015以上を要求し、8〜40 sampleでsolveします。設定した
reprojection RMSを超える解は拒否し、最後の検証済みprofileを置き換えません。

fusion appのpipelineは、各camera peerがWebRTC data channelで送るPoseFrame2D JSONと、
camera 1台につき1件のCameraCalibration v1 profileを使います。

```text
load fusion camera calibration [(camera-1のprofile JSON)]
load fusion camera calibration [(camera-2のprofile JSON)]
start pose fusion delay [120] ms jitter [80] ms min keypoint score [0.3]
forever:
  buffer PoseFrame2D JSON [(data channelで受信したmessage)]
  fuse PoseFrame3D at buffered delay
  set [poseJson] to (latest PoseFrame3D JSON)
stop pose fusion
```

cameraごとにtimestamp順のring bufferを持ちます。jitter window内で順序が入れ替わって届いた
frameはtimestamp位置へ挿入します。profile未読み込みのcamera（`unknown-camera`）、profileと
`calibrationId`や解像度が一致しないframe（`calibration-mismatch`）、timestampの重複、jitter window
より古い到着、満杯のringより古い到着は、`dropped pose frame count`へ計上してbufferしません。
各cameraのprofileは、そのcameraのframeが届き始める前に読み込んでください。

`fuse PoseFrame3D at buffered delay`は、最新のbuffered timestampから設定delayだけ過去の瞬間を
統合します。delayは最も遅いcameraのjitterを吸収できる値にしてください。その共通の瞬間で
全cameraを再sampleし、前後のframeで挟めたkeypointは線形補間、片側がocclusionのkeypointは
見えている側の観測を採用し、前後で挟めないcameraは最大1 jitter window分だけ直近frameを保持
します。明示した過去の瞬間を統合する場合は`fuse PoseFrame3D at timestamp [] us`を使います。

同期した2D setは2視点のreprojection誤差でcamera間対応付けし、1人が同じcameraから2視点を
取ることはありません。2台以上のcameraが観測したclusterをkeypointごとに、score重み付けと
cheirality判定付きで三角測量し、`person-N`のidentityを維持します。視点同士が食い違う場合は、
reprojection閾値内で1点に一致する最大の視点集合を採用するため、少数の誤検出はkeypointを
引きずらずに捨てられます。確信のある視点が2つ未満のkeypointは、最後に三角測量できた位置を
保持しscore `0`を返します。

一時的な不足ではerrorをthrowせず、直前の統合結果も置き換えません。`fuse`は`false`を返し、
`pose fusion state`は`buffering`、`pose fusion error code`は`empty-buffer`、
`insufficient-cameras`、`no-fused-person`のいずれかを返します。bufferできないframeも
`unknown-camera`、`calibration-mismatch`、`frame-dropped`を返すだけでthrowしないため、設定を
誤ったpeer 1台で実行中のscriptが止まることはありません。不正なJSON、他contractのschema、
不正なcalibration profileはerrorになります。scriptが走り終わっただけではbufferを破棄せず、
停止ボタン、project reload、disposeで破棄します。

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

`schemas/protocol-v1-integrity.json`は上流source commitと5 schemaのcanonical SHA-256を
固定します。repository checkはruntime TypeBox定義との一致を常時検証し、隣接する
multiview-pose checkoutまたは`MULTIVIEW_POSE_PROTOCOL_SCHEMA_DIR`があれば上流作業copyの
driftも検出します。上流fixtureのcopyはschemaとblock向けcodecの両方でcross-checkします。

calibrationのproduction backendはexact pinした`@techstark/opencv-js` 4.12.0-release.1だけです。
最初のsampleまたはsolveでbundle内backendを遅延初期化し、sample要求時だけvideo frameを
一時canvasへcopyします。OpenCV WebAssemblyでchessboard検出、subpixel
refinement、`calibrateCamera`、Rodrigues変換を行います。別のCPU参照solverは作りません。
offline会場で利用できる代わりに、非圧縮bundleは約11 MB増加します。unit testではbackendと
Camera Sourceを注入し、実camera／印刷board／OpenCV WASM初期化／幾何精度は配備機材上の
browser E2Eで別途検証します。

## ロールバック

起動前に`qrCourierPairing`をOFFにし、projectを停止して一時skinを解放したあと、
TurboWarp WebRTCのmanual copy/paste pairingへ戻します。
姿勢推定だけを切り戻す場合は、起動前に`webgpuMoveNetMultiPose`をOFFにしてprojectを
再読み込みします。camera previewとpairing blockは独立して利用できます。
`cameraCalibrationV1`をOFFにすると新規sessionを停止できます。一時sampleをcancelで解放し、
検証済みのexact v1 profileだけを維持します。
高位codecだけを切り戻す場合は`protocolV1Codec`をOFFにします。未知versionをv1として
解釈するfallbackは行いません。

## ライセンス

[Mozilla Public License 2.0](LICENSE)（SPDX: `MPL-2.0`）。third-party softwareは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載します。
