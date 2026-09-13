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
