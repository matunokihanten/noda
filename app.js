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

// 📂 静的ファイル（HTML, MP3など）を 'public' フォルダから読み込む設定
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

// システムの状態変数 (詳細統計項目を保持)
let queue = [];
let nextNumber = 1;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0, totalWebToday: 0, totalShopToday: 0 };
let completedHistory = []; 
let printerEnabled = true;
let isAccepting = true;
let waitTimeDisplayEnabled = false;

let waitTimes = []; 
let acceptanceTimer = null; 
let absentTimers = {}; 

// 💾 データの読み込み
if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queue = data.queue || [];
        nextNumber = data.nextNumber || 1;
        stats = data.stats || stats;
        completedHistory = data.completedHistory || []; 
        if (stats.totalWebToday === undefined) stats.totalWebToday = 0;
        if (stats.totalShopToday === undefined) stats.totalShopToday = 0;
        printerEnabled = data.printerEnabled !== undefined ? data.printerEnabled : true;
        isAccepting = data.isAccepting !== undefined ? data.isAccepting : true;
        waitTimeDisplayEnabled = data.waitTimeDisplayEnabled !== undefined ? data.waitTimeDisplayEnabled : false;
    } catch (e) { console.error("データ読込エラー:", e); }
}

function saveData() {
    const data = { queue, nextNumber, stats, printerEnabled, isAccepting, waitTimeDisplayEnabled, completedHistory };
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
        const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const footerText = `日時：${nowJst}\n人数：大人${guest.adults}/子供${guest.children}/幼児${guest.infants}\n座席：${guest.pref}\n--------------------------\nご来店ありがとうございます\n\n\n\n`;
        const footerBuf = iconv.encode(footerText, "Shift_JIS");
        const cutCmd = Buffer.from([0x1b, 0x64, 0x02]); 
        fs.writeFileSync(PRINT_JOB_FILE, Buffer.concat([initCmd, headerBuf, expandCmd, ticketBuf, normalCmd, footerBuf, cutCmd]));
    } catch (e) { console.error("印刷エラー:", e); }
}

// 🖨 CloudPRNT用エンドポイント
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
    socket.emit('init', { isAccepting, queue, stats, printerEnabled, waitTimeDisplayEnabled, completedHistory });

    socket.on('register', async (data) => {
        if (!isAccepting) return;
        const prefix = data.type === 'shop' ? 'S' : 'W';
        const calcWait = stats.averageWaitTime > 0 ? stats.averageWaitTime : 5;
        const estimatedWait = queue.length * calcWait;

        const newGuest = { 
            displayId: `${prefix}-${nextNumber++}`, 
            ...data, 
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            arrived: data.type === 'shop',
            called: false,
            estimatedWait: estimatedWait
        };
        queue.push(newGuest);
        stats.totalToday++;
        if (data.type === 'shop') { stats.totalShopToday++; } else { stats.totalWebToday++; }
        saveData();
        if (printerEnabled && data.type === 'shop') printTicket(newGuest);
        const msg = `【松乃木飯店 予約】\n番号：${newGuest.displayId}\n人数：${data.adults}名\n名前：${data.name || 'なし'}様`;
        sendLineNotification(msg);
        sendEmailBackup(`新規受付 ${newGuest.displayId}`, msg);
        io.emit('update', { queue, stats, completedHistory });
        socket.emit('registered', newGuest);
    });

    socket.on('cancelReservation', ({ displayId }) => {
        const guestIndex = queue.findIndex(g => g.displayId === displayId);
        if (guestIndex !== -1) {
            queue.splice(guestIndex, 1);
            if (absentTimers[displayId]) { clearTimeout(absentTimers[displayId]); delete absentTimers[displayId]; }
            saveData();
            io.emit('update', { queue, stats, completedHistory });
        }
    });

    socket.on('updateStatus', ({ displayId, status }) => {
        if (status === 'completed') {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                const waitMins = Math.floor((Date.now() - guest.timestamp) / 60000);
                waitTimes.push(waitMins);
                if (waitTimes.length > 10) waitTimes.shift();
                stats.averageWaitTime = Math.floor(waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length);
                guest.completedTime = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
                completedHistory.push(guest);
            }
            queue = queue.filter(g => g.displayId !== displayId);
            stats.completedToday++;
            if (absentTimers[displayId]) { clearTimeout(absentTimers[displayId]); delete absentTimers[displayId]; }
            saveData();
            io.emit('update', { queue, stats, completedHistory });
        }
    });

    socket.on('markArrived', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) { 
            guest.arrived = true; saveData(); 
            io.emit('update', { queue, stats, completedHistory }); 
            io.emit('guestArrived', { displayId: guest.displayId });
        }
    });

    // ★ 不在マーク後の自動削除ロジックを履歴保存に対応
    socket.on('markAbsent', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.absent = true; 
            saveData(); 
            io.emit('update', { queue, stats, completedHistory });
            
            absentTimers[displayId] = setTimeout(() => {
                const autoDeletedGuest = queue.find(g => g.displayId === displayId);
                if (autoDeletedGuest) {
                    // ★ 履歴に「不在自動削除」として保存
                    autoDeletedGuest.completedTime = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
                    autoDeletedGuest.isAbsentDelete = true; 
                    completedHistory.push(autoDeletedGuest);
                    
                    queue = queue.filter(g => g.displayId !== displayId);
                    saveData(); 
                    io.emit('update', { queue, stats, completedHistory });
                }
                delete absentTimers[displayId];
            }, 600000); // 10分
        }
    });

    socket.on('cancelAbsent', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.absent = false; saveData(); io.emit('update', { queue, stats, completedHistory });
            if (absentTimers[displayId]) { clearTimeout(absentTimers[displayId]); delete absentTimers[displayId]; }
        }
    });

    socket.on('callGuest', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.called = true; saveData();
            io.emit('update', { queue, stats, completedHistory });
            io.emit('guestCalled', { displayId: guest.displayId, type: guest.type });
        }
    });

    socket.on('resetQueueNumber', () => {
        if (queue.length === 0) { nextNumber = 1; saveData(); io.emit('queueNumberReset', { nextNumber }); }
        else { socket.emit('error', { message: '待ち客がいる間はリセットできません' }); }
    });

    socket.on('resetStats', () => {
        stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0, totalWebToday: 0, totalShopToday: 0 };
        completedHistory = []; 
        waitTimes = []; saveData(); io.emit('update', { queue, stats, completedHistory });
    });

    socket.on('setAcceptance', ({ status, duration }) => {
        isAccepting = status;
        if (acceptanceTimer) { clearTimeout(acceptanceTimer); acceptanceTimer = null; }
        if (!status && duration > 0) {
            acceptanceTimer = setTimeout(() => {
                isAccepting = true; saveData(); io.emit('statusChange', { isAccepting: true });
            }, duration * 60 * 1000);
        }
        saveData(); io.emit('statusChange', { isAccepting });
    });

    socket.on('setPrinterEnabled', ({ enabled }) => { printerEnabled = enabled; saveData(); io.emit('printerStatusChanged', { printerEnabled }); });
    socket.on('setWaitTimeDisplay', ({ enabled }) => { waitTimeDisplayEnabled = enabled; saveData(); io.emit('waitTimeDisplayChanged', { waitTimeDisplayEnabled, queue }); });
});

// 🔄 日次リセット処理 (毎日深夜0時に実行)
setInterval(() => {
    const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    if (jstNow.getHours() === 0 && jstNow.getMinutes() === 0) {
        queue = []; nextNumber = 1; completedHistory = []; 
        stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0, totalWebToday: 0, totalShopToday: 0 };
        waitTimes = []; saveData(); io.emit('dailyReset');
    }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 System Running on Port ${PORT}`));
