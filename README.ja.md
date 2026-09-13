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
- 外部PoseFrame3D v1を最大6人の宣言的A-Frame avatar rigへretargetします。

## 要件と安全性

- unsandboxed custom extensionを利用できるTurboWarp
- 先に読み込まれた、runtime capability v2対応の`@kubohiroya/turbowarp-webrtc` 0.3.0
- 姿勢推定より先に読み込まれた`@kubohiroya/turbowarp-camera-source` 0.5.0
- TensorFlow.js WebGPUに対応するbrowser／GPU
- avatar利用時は先に読み込んだscene capability v1対応`turbowarp-aframe` 0.3.0
- 起動前に明示的に有効化する`qrCourierPairing` feature flag（既定OFF）

scene capability v1は`@kubohiroya/turbowarp-aframe@0.3.0`で公開済みです。capability v1がない
場合consumerはfail closedします。

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

avatar retargetも独立して有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {avatarRetargetV1: true};
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

avatar retargetは次のように利用します。

```text
register avatar asset [actor] template JSON [(templateJson)] rig JSON [(rigJson)]
bind person [performer-1] to avatar [avatar-1] asset [actor] under [#scene] confidence [0.3]
forever:
  apply PoseFrame3D [(externalPoseFrame3D)] with PoseFrame2D [(matchingPoseFrame2D)] to avatars
```

rig JSONではKalidokit pose出力を`{avatar}`を含むA-Frame template node selectorへ対応付けます。
PoseFrame3Dの`personId`とPoseFrame2Dの`trackingId`を対応させ、両方のCOCO-17 recordを決定論的に
BlazePose-33へ変換し、exact pinした`kalidokit@1.1.5`の`Pose.solve`だけをrotation solverとして
使います。PoseFrame2D座標は宣言されたframe sizeで正規化します。存在しないhand／foot／face
landmarkは意図的に低visibilityで複製または補間するため、native BlazePose-33入力より精度が
低くなります。rootはKalidokitのhips結果に設定scale／offsetを適用します。低confidence／missing
jointでは該当boneの直前transformを維持し、1人の欠落や更新失敗で他avatarを停止しません。
認識遷移はavatar rootから設定可能なA-Frame event（既定`twmp-recognition-start`／
`twmp-recognition-end`）を送ります。

PoseFrame3Dは別実装の3D serviceが生成する境界dataです。この機能拡張は不透明な`timestampUs`を
recognition eventへ移すだけで、frame alignment、履歴保存／query、triangulation、3D solveを
実装しません。Kalidokitは上流でdeprecatedとなっておりBlazePose landmark向けなので、release
時には対象GLTF rigと実browser動作を検証する必要があります。自前solver fallbackはありません。

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

avatar unit testはA-Frame scene capability v1をmockし、exact PoseFrame3D validation、root／bone
transform、confidence、6人上限、1人単位の失敗分離、recognition event、rebind、scene reset検出、
cleanupを検証します。実A-Frame scene／GLTF asset／avatar rigはbrowser E2Eで別途検証します。

## ロールバック

起動前に`qrCourierPairing`をOFFにし、projectを停止して一時skinを解放したあと、
TurboWarp WebRTCのmanual copy/paste pairingへ戻します。
姿勢推定だけを切り戻す場合は、起動前に`webgpuMoveNetMultiPose`をOFFにしてprojectを
再読み込みします。camera previewとpairing blockは独立して利用できます。
`cameraCalibrationV1`をOFFにすると新規sessionを停止できます。一時sampleをcancelで解放し、
検証済みのexact v1 profileだけを維持します。
高位codecだけを切り戻す場合は`protocolV1Codec`をOFFにします。未知versionをv1として
解釈するfallbackは行いません。
avatar retargetだけを切り戻す場合は起動前に`avatarRetargetV1`をOFFにします。A-Frameの汎用
scene graphと静的avatar表示は維持されます。

## ライセンス

[Mozilla Public License 2.0](LICENSE)（SPDX: `MPL-2.0`）。third-party softwareは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載します。
