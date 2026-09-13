# アーキテクチャ

[利用ガイド](../README.ja.md) | [TurboWarp機能拡張API](turbowarp-extension-api.ja.md) |
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

manifestとTurboWarp blockがpackageの公開APIです。source levelのcontroller／portは内部の実装境界で、
npm exportではありません。読み込み順、lifecycle値、error、data contractは
[機能拡張APIリファレンス](turbowarp-extension-api.ja.md)を参照してください。

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

契約は本packageが所有します。正本は`src/protocol/schemas.ts`、`pnpm run schemas`が`schemas/`配下の
配布用JSON Schemaを生成し、repository checkは、生成物が定義からdriftした場合、file名が宣言した
`version` literalや`$id`と食い違う場合、dispatch対象のversionに対応するfileが無い場合に失敗します。
applicationは本packageと配布された`schemas/`を通して契約を利用します。本packageがapplication
repositoryから契約定義を読むことはなく、依存方向はapplication → extensionの一方向に保たれます。

契約はversionを切って追加し、公開済みversionを書き換えません。`protocolSchemas`はschema識別子と
versionの2段でdispatchするため、`twmp/pose-frame-2d`はv1とv2を受理し、v1利用者はv2 payloadを
拒否し続けます。PoseFrame2D v2は人物ごとに最大4件のサイリウムmarkerを追加します。各markerは、
一意な色の発光体を観測したCOCO-17 keypoint、`#RRGGBB`の色、patch内で色が占めた割合を持ちます。
色はkeypointと同一の映像frame・同一のcapture timestampの観測なので、別messageではなくpose frame
内で運び、受信側での時刻対応付けを不要にします。

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

## PoseFrame3D avatar retarget

`avatarRetargetV1`は独立した起動時固定・既定OFF flagです。runtime key
`turbowarpAFrameCapability`へ`requireVersion(1)`を呼び、TurboWarp-A-Frame capabilityの公開同期
scene操作7種だけを利用します。A-Frame DOM、Three.js `object3D`、GLTF内部boneへはアクセス
しません。capability v1は`@kubohiroya/turbowarp-aframe@0.3.0`で公開済みです。

asset登録では宣言的template JSONをA-Frameへ送り、検証済みrig mappingを保持します。各boneは
対応するKalidokit pose rig出力、`{avatar}`を含むselector、任意Euler offset degreeで定義します。
適用時は対応するexact-v1 PoseFrame3DとPoseFrame2Dの両方を要求します。PoseFrame3Dの`personId`と
PoseFrame2Dの`trackingId`が一致するpersonだけを結合しますが、これは時刻alignmentではありません。

adapterは両方のCOCO-17 recordを、exact pinした`kalidokit@1.1.5`が要求する33 positionへ
決定論的に変換します。screen座標にはPoseFrame2Dの`frameWidth`／`frameHeight`を使い、world座標は
外部serviceの値を維持します。不足するBlazePose face／hand／foot pointは低visibilityで中点補間
または複製します。`runtime: "tfjs"`、`enableLegs: true`のKalidokit `Pose.solve`だけをrotation
solverとし、radian出力をA-Frame degreeへ変換します。hips結果にroot scale／offsetを適用し、
自前rotation fallbackは持ちません。joint／personがbinding threshold未満なら該当transformだけを
skipし、直前値を維持します。

最大6 person IDを一意なtemplate instanceへbindします。recognition遷移は設定可能なA-Frame
eventで通知し、application側がPerformance DSLのstart／end effectへ接続できます。1人の
capability失敗は`partial`診断へ集約し、他avatarを継続します。rebind、明示reset、project
lifecycle reset、disposeでは可能ならend eventを送り、生成instanceと一時状態をcleanupします。

PoseFrame3Dは別実装の3D serviceから届くexact v1境界dataです。`timestampUs`は不透明値として
recognition event dataへcopyするだけです。frame alignment、履歴保持／query、triangulation、
3D solveは行いません。Kalidokitは上流でdeprecatedでありnative BlazePose landmarkを想定するため、
このCOCO-17拡張は明示的な精度制約です。release前に対象GLTF rigを実browserで検証します。

## フレーム同期パターンの縦切り

`frameSyncPatternV1`は独立した起動時固定・既定OFF flagです。fusion application向けに、
「ある出来事の後、各カメラPCがそれを写したフレームを記録し終えるまで何ms遅れるか」だけを答えます。

表示側は画面全体のoverlayに、黒地の4×4パネルを描きます。12セルが4096msで一周するミリ秒
カウンタ、4セルがそのカウンタから導くcheck bitです。露光が画面のリフレッシュをまたぐと2つの
codeが混ざりますが、check bitがその読み取りを拒否するので、誤った時刻は通りません。1つの
animation frameで描いた内容は次のリフレッシュで画面に出るため、符号化する時刻は現在の時計に
実測したリフレッシュ間隔を1つ足した値です。残るプロジェクタ遅延は全カメラ共通なので、
カメラ間のoffsetでは相殺されます。

カメラ側は名前付きのCamera Source leaseを取得し、`getUserMedia`は呼びません。届いたframeは
240×180の輝度bufferへ縮小します。bufferはdecoderが同期的に読み終えるため再利用します。
キャリブレーションは実際のパターンに対して2段階で走ります。前半60%で画素ごとの輝度min/maxを
記録し、高レンジ画素の最大連結領域のうちパネル形状のものをbounding boxとして採用します。
後半でセルごとの明暗レベルを学習し、復号成功率を測ります。投影は不均一なのでレベルはセル単位で
持ち、学習済みレベルの中間に落ちた読み取りは捨てます。信用できないlatencyを返す代わりに、
`panel-not-found`、`low-contrast`、`decode-unstable`で失敗します。受け付ける窓は6.2秒からです。
最も遅いセルの変化周期2048msと、レベル学習に割り当てる窓の割合から導いた下限で、全セルを
両方のレベルで観測できない窓は、後からlow contrastとして失敗する代わりに最初に拒否します。
どちらの段階も共有時計で終了するため、カメラが止まってもcontrollerが待ち続けることはありません。
また、キャリブレーション中に停止した場合は、camera faultとして記録せずに終了します。

復号できたframeはobservationとしてqueueに入ります。timestampは外部の同期時刻サービスから
読み取った不透明な値で、frameがアプリケーションへ届いた時点で取得します。センサの露光時刻が
必要な呼び出し側のために、browserが報告するframe ageは別に公開します。clock probe、latency
サンプル、カメラ別の集計レポートはWebRTC機能拡張側の責務なので、clock・offset・ping・pongの
ロジックはここには置きません。
## 多視点3D pose fusion

`poseFusion3D`は独立した起動時固定・既定OFF flagです。bufferへ入力するPoseFrame2D JSONは
fusion appがWebRTC data channelで受信したものであり、本機能拡張はtransportもclockも所有しません。

cameraごとにtimestamp順のring bufferを持ちます。slot数は設定delayとjitter windowから算出し、
16〜600 frameに制限します。buffer対象cameraは最大16台です。jitter window内で順序が入れ替わった
frameは、ringの短い側をずらしてtimestamp位置へ挿入するため、通常の順序どおりの追加はO(1)の
ままです。timestampの重複、最新frameからjitter windowより古い到着、満杯ringの最古frameより
古い到着はdropとして計上し、bufferしません。ここではcameraごとのclock offsetを推定しません。
capture timestampは別実装の同期済みlocal time serviceが与える不透明値のまま扱います。

frameをbufferするのは、その`cameraId`のcalibration profileが読み込み済みで、かつそのprofileが
frameを説明できる場合だけです。`calibrationId`や解像度が一致しないframeは、誤ったintrinsicで
そのまま三角測量されてしまうため拒否します。これらは重複や遅延到着と同様にdropとして計上し、
throwしません。ingestはdata channelのhot pathであり、設定を誤ったpeer 1台で実行中のscriptを
止めるべきではないからです。calibration済みcameraしかbufferしないので、未知のcamera IDが
ring bufferを占有することもありません。

`fuse PoseFrame3D at buffered delay`は、最新のbuffered timestampから設定delayを引いた1つの過去の
瞬間を解決し、全cameraをその瞬間で再sampleします。前後のframeで挟めたkeypointは線形補間し、
片側がocclusionのkeypointは低信頼値を混ぜず見えている側の観測を採用します。挟めないcamera、
またはjitter windowの2倍より広い間隔しかないcameraは、最大1 jitter windowだけ直近frameを保持し、
それを超える場合は寄与しません。

camera間の対応付けは、異なるcameraの追跡人物のすべての組について、共有する確信のあるkeypoint
での2視点reprojection誤差の平均をcostとし、共有keypointは4点以上・最大12点で打ち切ります。costの
小さい組から貪欲にmergeし、同一cameraの2視点が1人になるmergeは拒否します。2視点の三角測量は
2本の視線の最短距離の中点を閉形式で求め、この二乗オーダーの段を反復解法から外します。3視点
以上はscore重み付き線形解法（Jacobiは相対収束判定）を使います。16 camera×6人の上限で1回の統合
は約80 ms、4 camera×2人では約1 msです。

2台以上のcameraが覆うclusterは、keypointごとにcheirality判定とreprojection判定付きで三角測量
します。全視点が一致しない場合は、2視点ごとの仮解に対してreprojection閾値内に収まる視点数を
数え、最大の一致集合で三角測量し直します。これにより少数の誤検出はkeypointを引きずらずに
捨てられます（視点が2つの解に均等に割れる場合は原理的に区別できません）。pixel観測はprofileの
OpenCV rational modelで歪み補正するため、係数0／4／5／8個に対応し、それ以外はprofile読み込み時
に拒否します。

registryはcameraとtracking IDの重なりから`person-N`のidentityを維持し、keypointごとに最後に
三角測量できた位置を保持します。確信のある視点が2つ未満のkeypointはその位置を保持してscore `0`
を返し、実測値と保持値を利用側が区別できるようにします。組み立てたframeは保持する前に、
pinnedのPoseFrame3D v1 schemaで検証します。

bufferが空、覆うcameraが2台未満、多視点で見えた人物がいない場合は想定内の一時状態として
`false`を返し、直前の統合結果を保持したままerror codeを公開します。不正なJSON、他contractの
schema、不正なcalibration profileはerrorになります。停止ボタン、project reload、extension dispose
ではbufferと統合結果を解放し、明示cleanupでは読み込み済みcalibration profileも解放します。
`PROJECT_RUN_STOP`では解放しません。runtimeはthread queueが空になるたびにこのeventを出すため、
hat scriptでframeをbufferするevent駆動のprojectがmessageの合間にjitter bufferを失ってしまいます。
camera leaseと一時skinはこのeventでも解放します。

## サイリウムによる識別と向きの補正

`glowStickMarkers`は独立した起動時固定・既定OFF flagです。camera側では推論のたびに、追跡中の各
人物について設定したkeypointごとに1つのpatchを、keypointと同一の映像frameから、直後に破棄する
一時canvas経由でsampleします。patchはhueで評価します。彩度または明度が閾値未満のpixelは無視し、
残りのhueを円環平均するため、0度をまたぐ赤は赤のまま扱えます。色が占める割合が閾値を超えた場合
だけmarkerとして採用し、keypointごとに最も強い観測をPoseFrame2D v2のmarkerにします。sampleを
止めている間、frameはv1のままです。

fusion側では、performance DSLが演者の色を与え、演者がサイリウムを持つkeypointはfusion側の設定と
します（その契約は持ち手を記述しないため）。cameraのsampleごとに、観測の強い順で貪欲に割り当て、
1人の演者が同じcameraで2人を占めることはありません。

割り当ては2つの効果を持ちます。1つは識別です。統合された人物は演者IDを`personId`とするため、
occlusion、再入場、tracking ID変化をまたいで同一性が保たれ、対応付けでは別演者の視点の統合を拒否し、
同一演者の視点はreprojection costより先に統合します。もう1つは向きの補正です。指定keypointの
左右反転側で色が見つかった場合、そのcameraは背面を腹面として読んでいるため、三角測量の前に
その視点の左右keypointを入れ替えます。補正しなければ、その視点は手足を体の反対側へ引きずるか、
reprojection判定で落ちてしまいます。
