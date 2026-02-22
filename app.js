const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios'); 
const fs = require('fs');
const iconv = require('iconv-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ⚙️ 環境設定
const LINE_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SHOP_EMAIL = process.env.SHOP_EMAIL || 'matunokihanten.yoyaku@gmail.com';
const BREVO_USER = process.env.BREVO_USER;
const BREVO_PASS = process.env.BREVO_PASS;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASS = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');

const DATA_FILE = path.join(__dirname, 'queue-data.json');
const PRINT_JOB_FILE = path.join(__dirname, 'print_job.bin');

let queue = [];
let nextNumber = 1;
let stats = { totalToday: 0, completedToday: 0 };
let printerEnabled = true;

// 💾 データの読み込み
if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queue = data.queue || [];
        nextNumber = data.nextNumber || 1;
        stats = data.stats || stats;
        printerEnabled = data.printerEnabled !== undefined ? data.printerEnabled : true;
    } catch (e) { console.error("データ読込エラー:", e); }
}

function saveData() {
    const data = { queue, nextNumber, stats, printerEnabled };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 🏮 LINE通知
async function sendLineNotification(messageText) {
    if (!LINE_ACCESS_TOKEN) return;
    try {
        await axios.post('https://api.line.me/v2/bot/message/broadcast', 
        { messages: [{ type: 'text', text: messageText }] },
        { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } }
        );
        console.log("✅ LINE通知を送信しました");
    } catch (e) { console.error("❌ LINE送信失敗:", e.response ? e.response.data : e.message); }
}

// 📧 メールバックアップ通知
async function sendEmailBackup(subject, text) {
    const mailOptions = { from: SHOP_EMAIL, to: SHOP_EMAIL, subject, text };
    if (BREVO_USER && BREVO_PASS) {
        try {
            const transport = nodemailer.createTransport({ host: 'smtp-relay.brevo.com', port: 587, auth: { user: BREVO_USER, pass: BREVO_PASS } });
            await transport.sendMail(mailOptions);
            return;
        } catch (e) { console.warn("⚠️ Brevoメール失敗:", e.message); }
    }
    if (GMAIL_USER && GMAIL_APP_PASS) {
        try {
            const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS } });
            await transport.sendMail(mailOptions);
        } catch (e) { console.error("❌ 全てのメール送信が失敗しました"); }
    }
}

// 🖨 プリンター制御
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
        fs.writeFileSync(PRINT_JOB_FILE, Buffer.concat([initCmd, headerBuf, expandCmd, ticketBuf, normalCmd, footerBuf, cutCmd]));
    } catch (e) { console.error("印刷エラー:", e); }
}

app.post('/cloudprnt', (req, res) => res.json({ jobReady: fs.existsSync(PRINT_JOB_FILE), mediaTypes: ["application/vnd.star.starprnt"] }));
app.get('/cloudprnt', (req, res) => {
    if (fs.existsSync(PRINT_JOB_FILE)) {
        const content = fs.readFileSync(PRINT_JOB_FILE);
        res.set({'Content-Type': 'application/vnd.star.starprnt', 'Content-Length': content.length});
        res.send(content);
    } else res.status(204).send();
});
app.delete('/cloudprnt', (req, res) => { if (fs.existsSync(PRINT_JOB_FILE)) fs.unlinkSync(PRINT_JOB_FILE); res.status(200).send(); });

// 💬 Socket.io 通信
io.on('connection', (socket) => {
    socket.emit('init', { isAccepting: true, queue, stats, printerEnabled });

    socket.on('register', async (data) => {
        const prefix = data.type === 'shop' ? 'S' : 'W';
        const newGuest = { 
            displayId: `${prefix}-${nextNumber++}`, 
            ...data, 
            targetTime: data.targetTime || '今すぐ', 
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString('ja-JP'),
            arrived: data.type === 'shop',
            called: false
        };
        queue.push(newGuest);
        stats.totalToday++;
        saveData();

        if (printerEnabled && data.type === 'shop') printTicket(newGuest);
        
        const msg = `【松乃木飯店 予約】\n番号：${newGuest.displayId}\n到着：${newGuest.targetTime}\n人数：${data.adults}名\n名前：${data.name || 'なし'}様`;
        sendLineNotification(msg);
        sendEmailBackup(`新規受付 ${newGuest.displayId}`, msg);

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

    socket.on('markArrived', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) { 
            guest.arrived = true; 
            saveData(); 
            io.emit('update', { queue, stats }); 
        }
    });

    // 📢 【今回追加】お客さんのスマホへ呼出を転送する
    socket.on('callGuest', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.called = true; // 呼出済みにする
            saveData();
            io.emit('update', { queue, stats });
            io.emit('called', guest); // お客さんのスマホへ「呼ばれたよ」と送る
        }
    });

    socket.on('resetQueueNumber', () => {
        if (queue.length === 0) { 
            nextNumber = 1; 
            saveData(); 
            io.emit('queueNumberReset', { nextNumber }); 
        } else {
            socket.emit('error', { message: '待ち客がいる間はリセットできません' });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 System Running on Port ${PORT}`));
