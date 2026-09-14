# TurboWarp機能拡張API

[利用ガイド](../README.ja.md) | [English](turbowarp-extension-api.md) | [アーキテクチャ](architecture.ja.md)

これは`@kubohiroya/turbowarp-realtime-motion-capture` 0.2.1の公開APIリファレンスです。正式な公開面は、
サンドボックスなしで動作するTurboWarp機能拡張のID、opcode、引数、reporter、JSON契約、runtime
capabilityです。`src/`以下のTypeScript classは実装詳細であり、npm packageのexportではありません。

## APIの識別情報と読み込み

| 項目         | 契約                                                 |
| ------------ | ---------------------------------------------------- |
| Extension ID | `kubohiroyarealtimemotioncapture`                            |
| Bundle       | `dist/turbowarp-realtime-motion-capture.js`          |
| 機械可読API  | `dist/extension-manifest.json`（`formatVersion: 1`） |
| 実行mode     | サンドボックスなしのみ                               |
| 機能選択     | 起動時固定、すべて既定OFF                            |

必要なprovider拡張を先に読み込み、bundleを読み込む前に使う機能を1回の代入で設定します。

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

有効な機能のblockだけがpaletteに現れます。拡張読み込み後にglobal objectを変更しても反映されません。
flag変更後はprojectと拡張を再読み込みしてください。

## Runtime依存関係

| 機能                     | 必要なprovider                | Runtime境界                            |
| ------------------------ | ----------------------------- | -------------------------------------- |
| `qrCourierPairing`       | TurboWarp-WebRTC 0.3.0        | `kubohiroyaWebRtcCapability` version 2 |
| `webgpuMoveNetMultiPose` | TurboWarp-Camera-Source 0.5.0 | `acquireCamera({owner, cameraId})`     |
| `protocolV1Codec`        | なし                          | local validationのみ                   |
| `cameraCalibrationV1`    | TurboWarp-Camera-Source 0.5.0 | 共有named camera lease                 |
| `avatarRetargetV1`       | TurboWarp-A-Frame 0.3.0       | scene capability version 1             |
| `frameSyncPatternV1`     | Camera Source 0.5.0とWebRTC 0.3.0 | camera frameと同期時刻              |
| `poseFusion3D`           | なし                          | blockから渡すPoseFrame2D／calibration JSON |
| `glowStickMarkers`       | pose／fusion機能              | camera pixel、Performance DSL palette、identity fusion |

この拡張は`getUserMedia()`を呼びません。姿勢推定とcalibrationはCamera Sourceが所有するcameraを
leaseします。MoveNetはTensorFlow.jsの`webgpu` backend限定で、CPU／WASM／WebGL fallbackは
ありません。初回model loadにはnetwork接続が必要な場合があります。

## 呼び出し規約

- commandは失敗時に例外となります。結果を読む前にcommand blockの完了を待ちます。
- 値やerrorがない文字列reporterは`""`、count reporterは`0`を返します。
- JSON引数にはJavaScript objectではなくJSON文字列を渡します。
- pose、calibration、avatarのIDは1〜64文字の英数字、`.`、`_`、`-`です。
- offer QRの`PEER`は前後の空白を除いて1〜128文字です。この拡張では、それ以外の文字種制限を
  加えません。
- 同時に行ったpose inference、calibration sampling／solveは、実行中の1処理を共有します。
- project停止、再読み込み、runtime破棄時にskin、detector、camera lease、一時sample、生成avatarと
  retargetのmemory stateを解放します。

## Stateと診断

| 領域        | state                                                                                                                       | error code／診断                                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer QR    | `disabled`, `idle`, `generating-offer`, `rendering`, `displayed`, `error`                                                   | `offer QR error`                                                                                                                                                                                                                                                                            |
| Pose        | `disabled`, `idle`, `initializing-webgpu`, `loading-model`, `acquiring-camera`, `ready`, `inferencing`, `stopping`, `error` | `webgpu-unavailable`, `model-load-failed`, `camera-unavailable`, `camera-ended`, `inference-failed`, `invalid-output`                                                                                                                                                                       |
| Protocol    | 最新schema/version、または`disabled`/`0`                                                                                    | JSON Pointer pathとmessage                                                                                                                                                                                                                                                                  |
| Calibration | `disabled`, `idle`, `acquiring-camera`, `sampling`, `ready`, `solving`, `solved`, `cancelling`, `error`                     | `invalid-board`, `camera-unavailable`, `camera-ended`, `resolution-mismatch`, `board-not-found`, `sample-low-quality`, `sample-too-similar`, `sample-limit`, `sample-insufficient`, `sample-failed`, `solve-failed`, `reprojection-too-high`, `invalid-calibration`, `credential-forbidden` |
| Avatar      | `disabled`, `idle`, `configured`, `bound`, `ready`, `partial`, `error`                                                      | `avatar retarget error`内のperson別message                                                                                                                                                                                                                                                  |
| Frame sync  | `idle`, `acquiring-camera`, `calibrating`, `ready`, `error`                                                                  | `panel-not-found`, `low-contrast`, `decode-unstable`とcamera／runtime診断 |
| Pose fusion | `idle`, `buffering`, `fusing`, `ready`, `error`                                                                              | `pose fusion error code`と`pose fusion error` |

不採用のcalibration sampleはerror codeを設定しますが、有効なsessionは次のsampleを受け付けます。
`cancel camera calibration`は最後の検証済みprofileを保持し、`cleanup camera calibration`は
そのprofileも削除します。

## JSON契約

protocol codecが受け付ける組み合わせは次の5つだけです。

| `schema`                  | `version` | 主な制約                                                         |
| ------------------------- | --------: | ---------------------------------------------------------------- |
| `twrmc/session-policy`     |         1 | camera 1〜16台、performer最大6人                                 |
| `twrmc/camera-calibration` |         1 | 3x3 intrinsic、distortion最大14係数、4x4 world変換               |
| `twrmc/pose-frame-2d`      |         1 | person最大6人、順序固定COCO-17、pixel座標                        |
| `twrmc/pose-frame-2d`      |         2 | version 1のfieldとsample済みcolor marker                          |
| `twrmc/pose-frame-3d`      |         1 | person最大6人、重複なしcamera ID 2〜16個、順序固定COCO-17、meter |
| `twrmc/performance-dsl`    |         1 | performer 1〜6人とサイリウム色                                   |

unknown field／schema／versionは拒否します。WebRTC pairing secretに関係するkey（offer、answer、
SDP、ICE、DTLS、credentialの各形式）も入れ子の深さに関係なく拒否します。timestampは非負の
safe integerのmicrosecondsで、不透明値のまま運びます。時刻同期は外部serviceの責務です。

17 keypointは次の順序に固定されています。

```text
nose, left_eye, right_eye, left_ear, right_ear,
left_shoulder, right_shoulder, left_elbow, right_elbow,
left_wrist, right_wrist, left_hip, right_hip,
left_knee, right_knee, left_ankle, right_ankle
```

## Avatar rig JSON

`register avatar asset`にはA-Frame template JSON文字列と、別のrig mappingを渡します。各boneの
selectorには`{avatar}`が必要で、bindしたinstance IDへ置換後、ちょうど1 nodeに一致する必要があります。

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

`rig`は`RightUpperArm`, `RightLowerArm`, `LeftUpperArm`, `LeftLowerArm`, `RightHand`,
`LeftHand`, `RightUpperLeg`, `RightLowerLeg`, `LeftUpperLeg`, `LeftLowerLeg`, `Spine`, `Hips`
のいずれかです。`rootScale`は正数、confidenceは0〜1、boneは1〜32個です。recognition eventの
dataは`personId`、`avatarInstanceId`と、PoseFrame3Dに値がある場合の`timestampUs`を持つJSONです。

## Blockリファレンス

全blockの表示文、opcode、型、引数ID、既定値は[英語版の自動生成リファレンス](turbowarp-extension-api.md#block-reference)を参照してください。
`dist/extension-manifest.json`は同じopcodeと引数を機械可読形式で提供します。

機能別のcommandの流れは次のとおりです。

| 機能        | 開始                                         | 主処理                                                          | 終了／cleanup                                             |
| ----------- | -------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| QR          | `prepareOfferQr`または`createAndShowOfferQr` | `showOfferQrPart`, `showNextOfferQrPart`                        | `endOfferQrDisplay`                                       |
| Pose        | `startWebGpuMoveNetMultiPose`                | `inferNextPoseFrame`                                            | `stopWebGpuMoveNetMultiPose`                              |
| Protocol    | —                                            | `protocolJsonValid`, `decodeProtocolJson`, `encodeProtocolJson` | —                                                         |
| Calibration | `startCameraCalibration`                     | `addCameraCalibrationSample`, `solveCameraCalibration`          | `cancelCameraCalibration`または`cleanupCameraCalibration` |
| Avatar      | `registerAvatarAsset`, `bindAvatarPerson`    | `applyPoseFrame3DToAvatars`                                     | `unbindAvatarPerson`または`resetAvatarRetarget`           |
| Frame sync  | `showFrameSyncPattern`, `startFrameSyncDecoder` | `takeFrameSyncObservation`                                   | `hideFrameSyncPattern`, `stopFrameSyncDecoder`            |
| Pose fusion | `startPoseFusion`, `loadFusionCameraCalibration` | `bufferPoseFrame2D`, `fuseBufferedPoseFrame3D`                | `stopPoseFusion`または`cleanupPoseFusion`                 |
| Markers     | `enableGlowStickMarkers`, `loadGlowStickPalette` | pose frame生成とfusion時に自動処理                            | `disableGlowStickMarkers`                                 |

## 互換性方針

block追加は後方互換です。extension ID、opcode、argument IDの変更は保存済み`.sb3` projectを壊す
可能性があり、migrationが必要です。manifestの`formatVersion`変更はmanifest形式の非互換revisionを
表します。consumerはunknown versionを拒否し、private runtime fieldを連携APIにしないでください。
