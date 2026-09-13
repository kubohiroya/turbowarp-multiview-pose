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
- COCO-17観測を`twmp/pose-frame-2d` version 1、サイリウムmarker併用時はversion 2として取得できます。
- multiview-poseのapplication契約（PoseFrame2D v1／v2を含む）を所有し、検証とround-tripを行います。
- 共有cameraによるchessboardのintrinsic／world-extrinsic calibration workflowを提供します。
- 外部PoseFrame3D v1を最大6人の宣言的A-Frame avatar rigへretargetします。
- jitterを含むPoseFrame2D streamをcameraごとにbufferingし、過去の同一瞬間で再sampleします。
- 同期した2D setを三角測量し、`twmp/pose-frame-3d` version 1の3D poseへ統合します。
- 演者ごとに固有色のサイリウムを読み取り、識別・追跡と背面/腹面の取り違え補正に使います。

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
多視点3D pose fusionも独立して有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {poseFusion3D: true};
```

サイリウムmarkerも独立して有効化します。

```js
globalThis.__TWMP_FEATURE_FLAGS__ = {glowStickMarkers: true};
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

演者が固有色のサイリウムを持つ場合、camera appはkeypointと同一の映像frameから色をsampleします。

```text
start WebGPU MoveNet MultiPose camera [pose] peer [source-1] calibration [calibration-1]
sample glow stick colors at [right_wrist,left_wrist]
forever:
  infer latest pose frame timestamp [(同期済みtimestamp us)] us
  set [poseJson] to (latest PoseFrame2D JSON)
```

sample中は`latest PoseFrame2D JSON`が`twmp/pose-frame-2d` version 2を返します。各人物は最大4件の
markerを持ち、彩度の高い色を見つけたCOCO-17 keypoint、`#RRGGBB`の色、patch内の占有率を含みます。
sampleを止めればversion 1に戻ります。色はpose frame内を運ばれるため、fusion app側で別messageとの
時刻対応付けは不要です。

fusion appは、`glowStickColor`を既に持つperformance DSLで色と演者を対応付け、演者ごとに
サイリウムを持つkeypointを指定します。

```text
load glow stick palette from PerformanceDSL [(performance DSLのJSON)]
set performer [actor-1] glow stick at [right_wrist]
set performer [actor-2] glow stick at [right_wrist]
```

paletteは精度に2つの効果があります。色で識別できた人物は`personId`が演者IDになるため、
occlusion、再入場、tracking ID変化をまたいで同一性が保たれ、別演者の視点同士が統合されることも
ありません。色が指定keypointの左右反転側で見つかった場合、そのcameraは背面を腹面として読んだ
ことになるため、三角測量の前にその視点の左右labelを入れ替えます。これにより、手首が体を横切って
しまうような背面/腹面の取り違えを取り除きます。効果は`identified performer count`と
`mirror-corrected view count`で確認できます。

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

application契約は本packageが所有します。正本は`src/protocol/schemas.ts`で、`pnpm run schemas`が
`schemas/`配下の配布用JSON Schemaを再生成し、repository checkがTypeBox定義との一致を検証します。
applicationが本packageに依存する一方向の関係であり、本packageがapplication repositoryから
契約定義を読むことはありません。fixtureはschemaとblock向けcodecの両方でcross-checkします。

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
