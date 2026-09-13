# アーキテクチャ

[English](architecture.md)

## ビルド出力

このプロジェクトは実行時の動作と互換性メタデータを分離し、リポジトリに保存された同じソース定義から両方を生成します。

```text
src/index.ts + src/extension.ts
  -> vite-plugin-turbowarp-extension
  -> dist/<extension>.js

src/config.ts + src/block-definitions.json
  -> extension-api-manifest Viteプラグイン
  -> dist/extension-manifest.json
```

manifestプラグインはViteのビルド後フェーズで実行されます。これにより、JavaScriptプラグインの単一出力検証を維持しながら、TurboWarpバンドルの完成後にだけmanifestを追加します。

## 拡張機能API manifest v1

`schemas/extension-manifest.schema.json`が規範となるJSON Schemaです。`formatVersion`は`1`で、互換性のないmanifest形式を導入するときに変更する必要があります。

v1契約は次の情報を含みます。

- TurboWarp拡張機能のID
- 各ブロックのopcodeとブロック種類
- 各引数のID、引数種類、任意のメニュー参照
- 各メニューのIDとReporterブロックを受け付けるかどうか

ブロック、引数、メニューは、シリアライズ前に識別子で並べ替えられます。テキスト、説明、既定値、静的メニュー項目は、保存済みプロジェクトのAPI参照を識別しないため、意図的に除外しています。そのため互換性チェッカーは、API変更とドキュメントまたはローカライズの変更を区別できます。

## 差分の検出

`dist/`はリリース成果物としてコミットされます。`npm run check:dist`は両方のファイルを再ビルドし、`dist/`配下に変更、削除、未追跡ファイルがある場合に失敗します。これにより、ローカル検証とCIの両方でmanifestとバンドルの差分を検出できます。

## offer QRの縦切り

`config/feature-flags.ts`の`qrCourierPairing`は起動時固定・既定OFFです。有効時は
`kubohiroyaWebRtcCapability` version 2を要求し、`createOffer(peer)`の完了後に
`getOffer(peer)`でpairing codeを取得します。別機能拡張のprivate instanceには依存しません。

printable ASCIIのpairing codeを変更せず、version付き`twmp-qr/1` partへ格納します。
session ID、peer／message識別子、0始まりの順序、原文長、SHA-256 digestを全partに含めます。
byte modeで保守的に容量計算し、QR Version 40を上限とします。入力は128 KiB、64 part、
chunkごとに4096文字までです。

表示はrenderer上だけの一時SVG skinです。現在のdrawable skinを保持し、VM costumeを追加せず
QR skinへ切り替えます。明示終了、project停止、extension dispose、表示target削除で元skinを
復元し、一時resourceとQR dataを破棄します。

## 固定version application contract codec

`protocolV1Codec`は独立した起動時固定・既定OFF flagです。最大1 MiBのJSONをparseし、rootの
`schema`と`version`から明示対応した5種類のv1 TypeBox schemaだけへdispatchします。
version推測やfallbackは行いません。decode成功時はcompact JSONを1件保持し、失敗時は保持値を
消去して、最初の診断をJSON Pointer pathとmessageとして公開します。

schema定義は`schemas/protocol-v1-integrity.json`に記録したcommit時点の
`@multiview-pose/protocol`を反映します。5 runtime定義すべてをcanonical JSON SHA-256で固定し、
利用可能な上流working checkoutともrepository checkで比較します。schema変更時はpin、実装、
fixture、compatibility判断を同時に更新しない限りcheckが失敗します。

TypeBoxのtuple／array制約でCOCO-17順序、6人上限、matrix size、各数値境界を保証します。
別の再帰key guardにより、WebRTC offer／answer、SDP、ICE／DTLS material、credential fieldを
永続化前に拒否します。SessionPolicyはapplication validationとして`expiresAt > issuedAt`と
未期限切れも検証します。

PoseFrame2Dの`captureTimestampUs`とPoseFrame3Dの`timestampUs`は、別実装の同期済みlocal
time serviceから受け取る不透明値です。この機能拡張はclock同期、offset推定、probe、ping、
pongを実装せず、受け取ったtimestampを変更せずprotocolへ格納します。

## camera calibration workflow

`cameraCalibrationV1`は起動時固定・既定OFFです。camera／calibration ID、inner cornerが縦横
3〜20のchessboard、meter単位のsquare sizeを検証してから、named Camera Source leaseを取得
します。最初の実frame解像度をsession中は固定し、途中変更は検出前に拒否します。

明示的なsample要求ごとに一度だけvideoから一時canvasへcopyします。exact pinしたOpenCV.js
4.12 WebAssembly backendはbundle内に含め、最初のsampleまたはsolveで遅延初期化します。
完全なchessboardを検出してsubpixel精度へ補正し、board coverageと
Laplacian sharpnessから品質を評価します。quality 0.2未満、および保持viewのいずれかと正規化
RMS corner変位0.015未満のviewは拒否します。8〜40の多様なsampleを保持し、継続的なCPU
sampling loopや別の参照solverは実装しません。

`calibrateCamera`がintrinsic matrix、distortion vector、RMS reprojection errorを求めます。
最後のsampleを舞台world board配置として予約し、そのrotation／translationを反転してrow-major
4×4 `worldFromCameraMatrix`を作ります。設定RMS上限またはCameraCalibration v1境界を超える結果は
最後の有効profileを置き換えません。

cancel、project reload、extension disposeではleaseと一時sampleを解放し、最後の検証済みprofile
はmemoryに維持します。明示cleanupだけがprofileも消去します。importもexact v1 schemaで検証し、
pairing-secret keyを再帰的に拒否します。offline会場LANで唯一のproduction backendを使えるよう
非圧縮bundle約11 MB増を受け入れ、実camera／board幾何精度とWebAssembly起動はbrowser E2Eで
検証します。

## WebGPU MoveNet MultiPoseの縦切り

`webgpuMoveNetMultiPose`は独立した起動時固定・既定OFF flagです。TensorFlow.jsではWebGPU
backendだけをimportし、`setBackend("webgpu")`の結果を検証してから、trackingとbounding-box
trackerを有効にした`MULTIPOSE_LIGHTNING`を生成します。backendがWebGPU以外ならfail closedし、
CPU／WASM／WebGL推論fallbackは行いません。

controllerはCamera Sourceから`{cameraId: "pose"}`のleaseを取得し、media captureを所有しません。
同時に呼ばれた推論blockは1つのPromiseを共有するため、detector実行は重ならず、古いframe要求を
蓄積しません。成功時は最新video frameから最大6人を推定し、model tracking IDと17個すべての
名前付きCOCO keypointを必須として、`twmp/pose-frame-2d` version 1へserializeします。

停止時は実行中の初期化／推論を待ち、detectorをdisposeし、camera leaseと最新frameを解放します。
TensorFlow.js backendはprocess全体で共有されるためresetせず、本機能が所有するmodel resourceは
detectorのdisposeで解放します。

## 多視点3D pose fusion

`poseFusion3D`は独立した起動時固定・既定OFF flagです。bufferへ入力するPoseFrame2D JSONは
fusion appがWebRTC data channelで受信したものであり、本機能拡張はtransportもclockも所有しません。

cameraごとにtimestamp順のring bufferを持ちます。slot数は設定delayとjitter windowから算出し、
16〜600 frameに制限します。buffer対象cameraは最大16台です。jitter window内で順序が入れ替わった
frameは、ringの短い側をずらしてtimestamp位置へ挿入するため、通常の順序どおりの追加はO(1)の
ままです。timestampの重複、最新frameからjitter windowより古い到着、満杯ringの最古frameより
古い到着はdropとして計上し、bufferしません。ここではcameraごとのclock offsetを推定しません。
capture timestampは別実装の同期済みlocal time serviceが与える不透明値のまま扱います。

`fuse PoseFrame3D at buffered delay`は、最新のbuffered timestampから設定delayを引いた1つの過去の
瞬間を解決し、全cameraをその瞬間で再sampleします。前後のframeで挟めたkeypointは線形補間し、
片側がocclusionのkeypointは低信頼値を混ぜず見えている側の観測を採用します。挟めないcamera、
またはjitter windowの2倍より広い間隔しかないcameraは、最大1 jitter windowだけ直近frameを保持し、
それを超える場合は寄与しません。

camera間の対応付けは、異なるcameraの追跡人物のすべての組について、共有する確信のあるkeypoint
での2視点reprojection誤差の平均をcostとし、共有keypointが4点以上あることを要求します。costの
小さい組から貪欲にmergeし、同一cameraの2視点が1人になるmergeは拒否します。2台以上のcameraが
覆うclusterは、keypointごとにscore重み付き線形解法、cheirality判定、最悪視点を1回だけ除外する
reprojection判定で三角測量します。pixel観測はprofileのOpenCV rational modelで歪み補正するため、
係数0／4／5／8個に対応し、それ以外はprofile読み込み時に拒否します。

registryはcameraとtracking IDの重なりから`person-N`のidentityを維持し、keypointごとに最後に
三角測量できた位置を保持します。確信のある視点が2つ未満のkeypointはその位置を保持してscore `0`
を返し、実測値と保持値を利用側が区別できるようにします。組み立てたframeは保持する前に、
pinnedのPoseFrame3D v1 schemaで検証します。

bufferが空、覆うcameraが2台未満、多視点で見えた人物がいない場合は想定内の一時状態として
`false`を返し、直前の統合結果を保持したままerror codeを公開します。不正なJSON、他contractの
schema、不正なcalibration profileはerrorになります。project停止、project reload、extension dispose
ではbufferと統合結果を解放し、明示cleanupでは読み込み済みcalibration profileも解放します。
