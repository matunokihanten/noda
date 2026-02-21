// app.jp.js
// 松乃木飯店 サーバー（日本語版）
// 既存の機能を維持しつつ、SendGrid API をフォールバック実装として追加

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const iconv = require('iconv-lite'); // Shift_JIS変換用

// SendGrid 用クライアント（任意）
let sgMail = null;
if (process.env.SENDGRID_API_KEY) {
  try {
    sgMail = require('@sendgrid/mail');
    sgMail.setApiKey((process.env.SENDGRID_API_KEY || '').trim());
  } catch (e) {
    console.warn('SendGrid モジュールの初期化に失敗しました:', e.message);
    sgMail = null;
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 環境変数（Render の Environment で設定）
const SHOP_EMAIL = process.env.SHOP_EMAIL || 'matunokihanten.yoyaku@gmail.com';
const GMAIL_USER = process.env.GMAIL_USER || 'matunokihanten.yoyaku@gmail.com';
const GMAIL_APP_PASS = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');
const DATA_FILE = path.join(__dirname, 'queue-data.json');
const PRINT_JOB_FILE = path.join(__dirname, 'print_job.bin');

let queue = [];
let nextNumber = 1;
let isAccepting = true;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
let lastResetDate = null;
let printerEnabled = true;
let waitTimeDisplayEnabled = false;

// 起動時にデータを読み込む
if (fs.existsSync(DATA_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    queue = data.queue || [];
    nextNumber = data.nextNumber || 1;
    stats = data.stats || stats;
    printerEnabled = data.printerEnabled !== undefined ? data.printerEnabled : true;
    waitTimeDisplayEnabled = data.waitTimeDisplayEnabled !== undefined ? data.waitTimeDisplayEnabled : false;
    lastResetDate = data.lastResetDate || null;
  } catch (e) {
    console.error("データ読込エラー:", e);
  }
}

function saveData() {
  const data = { queue, nextNumber, isAccepting, stats, lastResetDate, printerEnabled, waitTimeDisplayEnabled };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('データ保存エラー:', e);
  }
}

// StarPRNT 用バイナリ生成（印刷）
function printTicket(guest) {
  if (!printerEnabled) return;
  try {
    const initCmd = Buffer.from([0x1b, 0x40]);
    const headerBuf = iconv.encode("      松乃木飯店\n--------------------------\n受付番号：\n", "Shift_JIS");
    const expandCmd = Buffer.from([0x1b, 0x69, 0x01, 0x01]);
    const ticketBuf = iconv.encode(guest.displayId + "\n", "Shift_JIS");
    const normalCmd = Buffer.from([0x1b, 0x69, 0x00, 0x00]);
    const footerText = `日時：${new Date().toLocaleString('ja-JP')}\n到着予定：${guest.targetTime || '今すぐ'}\n人数：${guest.adults}名\n座席：${guest.pref}\n--------------------------\nご来店ありがとうございます\n\n\n\n`;
    const footerBuf = iconv.encode(footerText, "Shift_JIS");
    const cutCmd = Buffer.from([0x1b, 0x64, 0x02]);

    const printData = Buffer.concat([initCmd, headerBuf, expandCmd, ticketBuf, normalCmd, footerBuf, cutCmd]);
    fs.writeFileSync(PRINT_JOB_FILE, printData);
  } catch (e) {
    console.error("印刷エラー:", e);
  }
}

// Nodemailer（Gmail SMTP）設定（フォールバック用）
let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS }
  });

  // 起動時に verify を試す（ログ出力のみ）
  transporter.verify()
    .then(() => console.log('✅ SMTP transporter is ready'))
    .catch(err => console.warn('❌ SMTP transporter verify failed:', err && err.message ? err.message : err));
} else {
  console.warn('GMAIL_USER または GMAIL_APP_PASS が設定されていません。SMTP は無効です。');
}

// SendGrid 経由で送信する関数
async function sendViaSendGrid(to, subject, text) {
  if (!sgMail) {
    console.warn('SendGrid 未設定または初期化失敗。');
    return null;
  }
  const msg = {
    to,
    from: GMAIL_USER || 'no-reply@example.com',
    subject,
    text
  };
  try {
    const res = await sgMail.send(msg);
    console.log('📧 SendGrid 送信成功:', res && res[0] && res[0].statusCode);
    return res;
  } catch (err) {
    console.error('❌ SendGrid 送信エラー:', err && err.message ? err.message : err);
    if (err && err.response && err.response.body) {
      console.error('SendGrid response body:', JSON.stringify(err.response.body));
    }
    return null;
  }
}

// 汎用送信関数：まず SendGrid を試し、失敗したら SMTP にフォールバック
async function sendNotificationMail(to, subject, text) {
  // 1) SendGrid が使えるならまず試す
  if (sgMail) {
    const sgRes = await sendViaSendGrid(to, subject, text);
    if (sgRes) return { via: 'sendgrid', result: sgRes };
    // 失敗したらフォールバックへ
  }

  // 2) SMTP が使えるなら送る
  if (transporter) {
    try {
      const info = await transporter.sendMail({ from: GMAIL_USER, to, subject, text });
      console.log('📧 SMTP sendMail success:', info && info.response ? info.response : info);
      return { via: 'smtp', result: info };
    } catch (err) {
      console.error('❌ SMTP send error:', err);
      return { via: 'smtp', error: err };
    }
  }

  console.warn('メール送信手段がありません（SendGrid も SMTP も利用不可）。');
  return null;
}

// CloudPRNT API
app.post('/cloudprnt', (req, res) => {
  res.json({ jobReady: fs.existsSync(PRINT_JOB_FILE), mediaTypes: ["application/vnd.star.starprnt"] });
});

app.get('/cloudprnt', (req, res) => {
  if (fs.existsSync(PRINT_JOB_FILE)) {
    const content = fs.readFileSync(PRINT_JOB_FILE);
    res.set({ 'Content-Type': 'application/vnd.star.starprnt', 'Content-Length': content.length });
    res.send(content);
  } else res.status(204).send();
});

app.delete('/cloudprnt', (req, res) => {
  if (fs.existsSync(PRINT_JOB_FILE)) fs.unlinkSync(PRINT_JOB_FILE);
  res.status(200).send();
});

// WebSocket / Socket.IO
io.on('connection', (socket) => {
  socket.emit('init', { isAccepting, queue, stats, printerEnabled, waitTimeDisplayEnabled });

  socket.on('register', async (data) => {
    const prefix = data.type === 'shop' ? 'S' : 'W';
    const newGuest = {
      displayId: `${prefix}-${nextNumber++}`,
      ...data,
      targetTime: data.targetTime || '今すぐ',
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('ja-JP')
    };
    queue.push(newGuest);
    stats.totalToday++;
    saveData();

    if (printerEnabled && data.type === 'shop') printTicket(newGuest);

    // メール送信（店舗・ネット両対応）
    const mailText = `新規予約通知\n\n番号：${newGuest.displayId}\n到着予定：${newGuest.targetTime}\nお名前：${data.name || 'なし'}様\n人数：${data.adults}名\n座席：${data.pref}`;
    try {
      const mailRes = await sendNotificationMail(SHOP_EMAIL, `【松乃木飯店】新規受付 ${newGuest.displayId}`, mailText);
      if (mailRes && mailRes.error) {
        console.error('メール送信でエラーが発生しました:', mailRes.error);
      }
    } catch (e) {
      console.error('メール送信例外:', e);
    }

    io.emit('update', { queue, stats });
    socket.emit('registered', newGuest);
  });

  socket.on('updateStatus', ({ displayId, status }) => {
    if (status === 'completed') {
      queue = queue.filter(g => g.displayId !== displayId);
      stats.completedToday++;
      saveData();
      io.emit('update', { queue, stats });
    }
  });

  socket.on('resetQueueNumber', () => {
    if (queue.length === 0) { nextNumber = 1; saveData(); io.emit('queueNumberReset', { nextNumber }); }
    else socket.emit('error', { message: '待ち客がいる間はリセットできません' });
  });

  socket.on('setPrinterEnabled', (data) => { printerEnabled = data.enabled; saveData(); io.emit('printerStatusChanged', { printerEnabled }); });
  socket.on('setWaitTimeDisplay', (data) => { waitTimeDisplayEnabled = data.enabled; saveData(); io.emit('waitTimeDisplayChanged', { waitTimeDisplayEnabled, queue }); });
});

// 簡易ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ status: 'ok', queueLength: queue.length, nextNumber });
});

// サーバ起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`System Running on ${PORT}`));
