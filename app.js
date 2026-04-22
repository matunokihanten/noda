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

const LINE_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SHOP_EMAIL = process.env.SHOP_EMAIL || 'matunokihanten.yoyaku@gmail.com';
const BREVO_USER = process.env.BREVO_USER;
const BREVO_PASS = process.env.BREVO_PASS;

const DATA_FILE = path.join(__dirname, 'queue-data.json');
const PRINT_JOB_FILE = path.join(__dirname, 'print_job.bin');

let queue = [];
let nextNumber = 1;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0, totalWebToday: 0, totalShopToday: 0 };
let printerEnabled = true;
let isAccepting = true;

let waitTimes = []; 
let acceptanceTimer = null; 
let absentTimers = {}; 

if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queue = data.queue || [];
        nextNumber = data.nextNumber || 1;
        stats = data.stats || stats;
        printerEnabled = data.printerEnabled !== undefined ? data.printerEnabled : true;
        isAccepting = data.isAccepting !== undefined ? data.isAccepting : true;
    } catch (e) { console.error("データ読込エラー:", e); }
}

function saveData() {
    const data = { queue, nextNumber, stats, printerEnabled, isAccepting };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function sendLineNotification(messageText) {
    if (!LINE_ACCESS_TOKEN) return;
    try {
        await axios.post('https://api.line.me/v2/bot/message/broadcast', 
        { messages: [{ type: 'text', text: messageText }] },
        { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } }
        );
    } catch (e) { console.error("❌ LINE送信失敗:", e.response ? e.response.data : e.message); }
}

function printTicket(guest) {
    if (!printerEnabled) return;
    try {
        const initCmd = Buffer.from([0x1b, 0x40]); 
        const headerBuf = iconv.encode("      松乃木飯店\n--------------------------\n受付番号：\n", "Shift_JIS");
        const expandCmd = Buffer.from([0x1b, 0x69, 0x01, 0x01]); 
        const ticketBuf = iconv.encode(guest.displayId + "\n", "Shift_JIS");
        const normalCmd = Buffer.from([0x1b, 0x69, 0x00, 0x00]); 
        const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const arrivalText = guest.targetTime ? `到着予定：${guest.targetTime}\n` : "";
        const footerText = `日時：${nowJst}\n${arrivalText}人数：大人${guest.adults}/子供${guest.children}/幼児${guest.infants}\n座席：${guest.pref}\n--------------------------\nご来店ありがとうございます\n\n\n\n`;
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

io.on('connection', (socket) => {
    socket.emit('init', { isAccepting, queue, stats, printerEnabled });

    socket.on('register', async (data) => {
        if (!isAccepting) return;
        const prefix = data.type === 'shop' ? 'S' : 'W';
        const newGuest = { 
            displayId: `${prefix}-${nextNumber++}`, 
            ...data, 
            timestamp: Date.now(), 
            time: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            arrived: data.type === 'shop',
            called: false
        };
        queue.push(newGuest);
        stats.totalToday++;
        if (data.type === 'shop') { stats.totalShopToday++; } else { stats.totalWebToday++; }
        saveData();
        if (printerEnabled && data.type === 'shop') printTicket(newGuest);
        const msg = `【予約】${newGuest.displayId}\n到着:${data.targetTime || '未定'}\n人数:${data.adults}名\n${data.name || 'なし'}様`;
        sendLineNotification(msg);
        io.emit('update', { queue, stats });
        socket.emit('registered', newGuest);
    });

    socket.on('cancelReservation', ({ displayId }) => {
        queue = queue.filter(g => g.displayId !== displayId);
        if (absentTimers[displayId]) { clearTimeout(absentTimers[displayId]); delete absentTimers[displayId]; }
        saveData();
        io.emit('update', { queue, stats });
    });

    socket.on('updateStatus', ({ displayId, status }) => {
        if (status === 'completed') {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                const waitMins = Math.floor((Date.now() - guest.timestamp) / 60000);
                waitTimes.push(waitMins);
                if (waitTimes.length > 10) waitTimes.shift();
                stats.averageWaitTime = Math.floor(waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length);
            }
            queue = queue.filter(g => g.displayId !== displayId);
            stats.completedToday++;
            if (absentTimers[displayId]) { clearTimeout(absentTimers[displayId]); delete absentTimers[displayId]; }
            saveData();
            io.emit('update', { queue, stats });
        }
    });

    socket.on('markArrived', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) { 
            guest.arrived = true; 
            saveData(); 
            if (printerEnabled) printTicket(guest);
            io.emit('update', { queue, stats }); 
            io.emit('guestArrived', { displayId: guest.displayId });
        }
    });

    socket.on('callGuest', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.called = true; saveData();
            io.emit('update', { queue, stats });
            io.emit('guestCalled', { displayId: guest.displayId });
        }
    });

    socket.on('markAbsent', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.absent = true; saveData(); io.emit('update', { queue, stats });
            absentTimers[displayId] = setTimeout(() => {
                queue = queue.filter(g => g.displayId !== displayId);
                saveData(); io.emit('update', { queue, stats });
                delete absentTimers[displayId];
            }, 600000);
        }
    });

    socket.on('cancelAbsent', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.absent = false; saveData(); io.emit('update', { queue, stats });
            if (absentTimers[displayId]) { clearTimeout(absentTimers[displayId]); delete absentTimers[displayId]; }
        }
    });

    socket.on('setAcceptance', ({ status, duration }) => {
        isAccepting = status;
        if (acceptanceTimer) { clearTimeout(acceptanceTimer); acceptanceTimer = null; }
        if (!status && duration > 0) {
            acceptanceTimer = setTimeout(() => { isAccepting = true; saveData(); io.emit('statusChange', { isAccepting: true }); }, duration * 60 * 1000);
        }
        saveData(); io.emit('statusChange', { isAccepting });
    });

    socket.on('setPrinterEnabled', ({ enabled }) => { printerEnabled = enabled; saveData(); io.emit('printerStatusChanged', { printerEnabled }); });
    socket.on('resetStats', () => { stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0, totalWebToday: 0, totalShopToday: 0 }; waitTimes = []; saveData(); io.emit('update', { queue, stats }); });
    socket.on('resetQueueNumber', () => { if (queue.length === 0) { nextNumber = 1; saveData(); io.emit('queueNumberReset', { nextNumber }); } else { socket.emit('error', { message: '待ち客がいる間はリセットできません' }); } });
});

setInterval(() => {
    const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    if (jstNow.getHours() === 0 && jstNow.getMinutes() === 0) {
        queue = []; nextNumber = 1;
        stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0, totalWebToday: 0, totalShopToday: 0 };
        waitTimes = []; saveData(); io.emit('dailyReset');
    }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on Port ${PORT}`));
