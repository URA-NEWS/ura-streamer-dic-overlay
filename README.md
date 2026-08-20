# Streamer Dictionary Overlay

配信者図鑑をOBS内で右からスライドイン表示するオーバーレイツール。

## 仕様

- **キャンバスサイズ**: 1280×720
- **オーバーレイ幅**: 640px（画面右側に配置）
- **操作**: ドック（検索+50音索引）で配信者選択 → 表示側にスライドイン
- **通信**: WebSocket（リアルタイム同期）

## インストール

### 前提条件
- Node.js 16+ 
- npm

### セットアップ手順

```bash
# 1. リポジトリクローン
git clone https://github.com/YOUR_USER/streamer-dic-overlay.git
cd streamer-dic-overlay

# 2. 依存をインストール
npm install

# 3. 図鑑HTMLからデータ抽出（初回のみ）
# index_29_3.htmlを同ディレクトリに配置してから：
node extract_streamers.js index_29_3.html

# 4. サーバー起動
npm start
```

サーバー起動後：
- **ドック**: http://localhost:3942/dock
- **表示**: http://localhost:3942/overlay

## 使用方法

### ローカル環境

1. **npm start** でサーバー起動
2. **OBS設定**:
   - **カスタムブラウザドック**: `http://localhost:3942/dock` を追加（サイズ: 自由）
   - **ブラウザソース**: `http://localhost:3942/overlay` を追加
     - サイズ: 1280×720
     - **透明度**: チェック有効化（背景を透過）
3. ドック内で配信者をクリック → 表示側に自動スライドイン

### GitHub + Render デプロイ

```bash
# ローカルでリポジトリ初期化（初回）
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USER/streamer-dic-overlay.git
git push -u origin main
```

**Renderで:**
1. Web Service作成 → リポジトリ接続
2. 環境変数は不要（`streamers.json`がリポジトリに含まれている場合）
3. スタート コマンド: `npm start`

## ファイル構成

```
streamer-dic-overlay/
├── streamer-dic-server.js      WebSocketサーバー（ポート3942）
├── streamer_dic_dock.html      ドック UI（検索+50音索引）
├── streamer_dic_overlay.html   表示 UI（スライドイン/アウト）
├── extract_streamers.js        図鑑HTML → JSON変換スクリプト
├── streamers.json              配信者データ（自動生成 or 手動作成）
├── package.json
└── README.md
```

## データフォーマット

### streamers.json

```json
[
  {
    "id": "streamer_1",
    "name": "配信者名",
    "yomi": "はいしんしゃめい",
    "photoUrl": "https://...",
    "sns": [
      {
        "platform": "X",
        "id": "@username",
        "url": "https://x.com/username"
      }
    ],
    "sites": [
      {
        "name": "ふわっち",
        "id": "username"
      }
    ],
    "intro": "紹介文..."
  }
]
```

## 図鑑データの更新

**index_29_3.htmlを変更した場合:**

```bash
node extract_streamers.js index_29_3.html
git add streamers.json
git commit -m "Update streamer data"
git push
```

Renderは自動的に最新版をデプロイします（リポジトリ連携の場合）。

## トラブルシューティング

### WebSocketが接続できない
- ファイアウォール設定を確認
- ローカル: `http://localhost:3942/overlay` が正しいポート/ホストか確認
- Render: HTTPS環境ではWSS（Secure WebSocket）が必須

### オーバーレイが表示されない
- OBSのブラウザソース設定で「透明度」にチェック
- ブラウザキャッシュをクリア（OBS設定 → ブラウザ → キャッシュクリア）

### データが反映されない
- `streamers.json`が正しくJSON形式か確認: `node -e "console.log(require('./streamers.json'))"`
- サーバーログで読み込みエラーを確認: `npm start`でログ表示

## 機能概要

### ドック
- **テキスト検索**: 配信者名で検索
- **50音索引**: あ〜わで始まる配信者をフィルタ
- **配信者選択**: クリックで表示側に送信
- **非表示ボタン**: オーバーレイを一瞬で隠す

### 表示（オーバーレイ）
- **スライドイン**: 右からスムーズに出現（0.4秒）
- **スライドアウト**: 左へスムーズに消える
- **情報表示**:
  - 配信者写真（円形、グロー付き）
  - 名前・読み仮名
  - SNS（X, YouTube等）
  - 配信サイト（ふわっち, Kick, ツイキャス）
  - 紹介文

### WebSocket通信
- **ドック** → `selectStreamer` メッセージ → サーバー → すべての **表示** に配信
- **ドック** → `hideStreamer` メッセージ → サーバー → すべての **表示** に配信

## ライセンス

MIT

---

**Questions?** GitHubの Issues でお知らせください。
