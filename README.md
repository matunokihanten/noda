以下のマークダウン（Markdown）テキストをコピーして、プロジェクトの直下に README.md という名前で保存してください。

Markdown

# 🏮 松乃木飯店 順番待ちシステム (Matsunoki Hanten Queue System)

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socketdotio&logoColor=white)

松乃木飯店の店頭およびWebからの順番待ちをリアルタイムで管理・同期するフルスタックアプリケーションです。
お客様の利便性向上と、店舗スタッフの業務負担軽減を目的として設計されています。

## ✨ 主な機能 (Features)

* **🔄 リアルタイム同期**: Socket.ioを活用し、全端末（お客様スマホ、店頭タブレット、管理画面）で待ち状況を瞬時に同期。
* **📱 マルチデバイス対応**: 用途別に最適化された3つのUI（Web受付、店頭タブレット、管理ダッシュボード）。
* **📢 マルチチャネル通知**: 
  * ユーザー向け: ブラウザの音声読み上げ（SpeechSynthesis API）、チャイム音、バイブレーション。
  * 店舗向け: LINE Notify API連携、バックアップメール通知（Brevo/Gmail対応）。
* **🖨️ クラウドプリント連携**: Star Micronics CloudPRNTに対応し、店頭での自動発券を実現。
* **⏱️ スマート待ち時間計算**: 過去の案内実績から平均待ち時間を自動算出し、目安時間をお客様に提示。
* **🤖 運用自動化**: 不在客の自動削除（10分後）や、毎日深夜0時のシステム自動リセット機能。

---

## 🛠 技術スタック (Tech Stack)

* **Backend**: Node.js, Express.js
* **Realtime Communication**: Socket.io
* **Frontend**: HTML5, CSS3, Vanilla JavaScript
* **External Integrations**:
  * LINE Messaging API (通知用)
  * Nodemailer (メール送信用)
  * Star CloudPRNT (レシートプリンター用)
* **Data Storage**: Local JSON File (`queue-data.json`) / Persistent Storage

---

## 🖥 画面構成 (Screens)

### 1. Web受付画面 (`/index.html` または `/?type=web`)
* お客様がご自身のスマートフォンから順番待ちにエントリーする画面です。
* **機能**: 人数・座席指定、待ち状況の確認、予約キャンセル機能、ブラウザバックグラウンド通知（音声・バイブ）。

### 2. 店頭タブレット画面 (`/shop.html`)
* 店舗の入り口に設置し、直接来店されたお客様が操作する画面です。
* **機能**: 人数・座席指定での発券、クラウドプリンターへの印刷命令、Web予約客の到着確認。

### 3. 管理ダッシュボード (`/admin.html`)
* 店舗スタッフ・店長がキューを管理するためのコントロールパネルです。
* **機能**: お客様の呼出・再呼出・案内完了・不在処理、システム設定（受付停止/再開、音声ON/OFF、プリンターON/OFF）、本日の統計データ確認。

---

## 🚀 セットアップと起動 (Setup & Installation)

### 1. リポジトリのクローンとパッケージのインストール
```bash
git clone <your-repository-url>
cd matsunoki-hanten
npm install
2. 環境変数の設定
プロジェクトのルートディレクトリに .env ファイルを作成し、以下の情報を設定してください。

コード スニペット

# サーバーポート (デフォルト: 3000)
PORT=3000

# LINE通知設定 (LINE Developersで取得したトークン)
LINE_CHANNEL_ACCESS_TOKEN=your_line_access_token_here

# メール通知設定 (バックアップ用)
SHOP_EMAIL=matunokihanten.yoyaku@gmail.com

# Brevo (旧Sendinblue) SMTP設定 (優先)
BREVO_USER=your_brevo_smtp_user
BREVO_PASS=your_brevo_smtp_password

# Gmail SMTP設定 (Brevoが使えない場合のフォールバック)
GMAIL_USER=your_gmail_address
GMAIL_APP_PASS=your_gmail_app_password
3. アプリケーションの起動
Bash

npm start
起動後、ブラウザで以下のURLにアクセスして動作を確認します。

Web受付: http://localhost:3000/

店頭受付: http://localhost:3000/shop.html

管理画面: http://localhost:3000/admin.html

※ Renderなどのクラウドプラットフォームにデプロイする場合、環境変数はダッシュボード上で設定してください。

🖨️ プリンター (CloudPRNT) の設定
本システムは Star Micronics 製の CloudPRNT 対応プリンターでの発券をサポートしています。
プリンターの設定画面（Web管理画面）から、サーバーのURLを以下のように指定してください。

Server URL: https://<あなたのドメイン>/cloudprnt

Polling Interval: 2 (秒)推奨

📁 ディレクトリ構成 (Directory Structure)
Plaintext

.
├── app.js                 # サーバーサイドのメインロジック (Express + Socket.io)
├── package.json           # プロジェクトの依存関係とメタデータ
├── .env                   # 環境変数 (Gitには含めない)
├── queue-data.json        # キューと統計データの永続化ファイル (自動生成)
├── print_job.bin          # プリンターへの印刷ジョブファイル (自動生成)
└── public/                # フロントエンドの静的ファイル
    ├── index.html         # Web受付画面
    ├── shop.html          # 店頭タブレット画面
    └── admin.html         # 管理画面
📝 運用上の注意点 (Notes for Operation)
音声通知について: 最近のブラウザの仕様により、音声（SpeechSynthesis / AudioContext）を再生するには、ユーザーが一度画面をタップ等のインタラクションを行う必要があります。本システムでは「受付確定」ボタンのクリックを利用してこの制限をクリアしています。

データのリセット: 毎日 日本時間(JST)の 00:00 に、待機列と本日の統計データが自動的にリセットされます。

本番環境でのURL設定: クライアント側のHTMLファイル内で const socket = io('https://your-domain.com'); のように、明示的にバックエンドのURLを指定することで、別サーバーでの静的ホスティングも可能です。

© 2026 Matsunoki Hanten Queue System


---

### 💡 この README のポイント
* **見やすさ**: バッジ（Node.jsなどのロゴ）や絵文字を使うことで、プロっぽく洗練された印象になります。
* **網羅性**: システムの概要だけでなく、環境変数の設定（`.env`）やプリンターの連携方法まで記載しているため、数ヶ月後に見直した際や、他の人が開発を引き継ぐ際にも迷いません。

何か追加したい項目（例えば今後のアップデート予定など）があれば、お知らせくださいね！
