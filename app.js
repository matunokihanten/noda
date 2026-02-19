const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const net = require('net');
const iconv = require('iconv-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静的ファイルの提供（publicフォルダ内の画像やCSS用）
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- 修正ポイント: 各画面へのルーティングを明示的に指定 ---

// 1. ネット予約画面（トップ）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. 店舗用画面 (/shop)
app.get('/shop', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'shop.html'));
});

// 3. 管理画面 (/admin)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- 以下、既存のロジックを保持 ---

const GMAIL_USER = process.env.GMAIL_USER || 'matunokihanten.yoyaku@gmail.com';
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || 'gphm kodc uzbp dcmh'; 
const DATA_FILE = path.join(__dirname, 'queue-data.json');

const PRINTER_IP = process.env.PRINTER_IP || '192.168.0.100';
const PRINTER_PORT = process.env.PRINTER_PORT || 9100;

let queue = [];
let nextNumber = 1;
let isAccepting = true;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
let printerEnabled = true; 
let waitTimeDisplayEnabled = true;

// データを読み込む
if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queue = data.queue || [];
        nextNumber = data.nextNumber || 1;
        stats = data.stats || stats;
    } catch (e) { console.error("Data load error"); }
}

function saveData() {
    const data = { queue, nextNumber, isAccepting, stats, printerEnabled, waitTimeDisplayEnabled };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 文字化け・サイズ・紙送り改善済みの印刷関数
function printTicket(guest) {
    if (!printerEnabled) return;
    const client = new net.Socket();
    client.setTimeout(5000);
    client.connect(PRINTER_PORT, PRINTER_IP, () => {
        const ESC = '\x1B';
        const GS = '\x1D';
        const FS = '\x1C';
        const buffers = [];
        buffers.push(Buffer.from(ESC + '@' + FS + '&' + ESC + 'a' + '\x01', 'ascii'));
        buffers.push(Buffer.from(GS + '!' + '\x11', 'ascii'));
        buffers.push(iconv.encode('松乃木飯店\n', 'Shift_JIS'));
        buffers.push(Buffer.from(GS + '!' + '\x33', 'ascii')); // 数字を大きく
        buffers.push(iconv.encode('\n' + guest.displayId + '\n\n', 'Shift_JIS'));
        let details = `大人:${guest.adults}名/子供:${guest.children}名\n--------------------------\n`;
        details += `受付:${new Date().toLocaleTimeString('ja-JP')}\n`;
        buffers.push(Buffer.from(GS + '!' + '\x00', 'ascii'));
        buffers.push(iconv.encode(details, 'Shift_JIS'));
        // PHPを参考にした紙送り＆カット
        buffers.push(Buffer.from(ESC + 'd' + '\x02' + GS + 'V' + '\x42' + '\x00', 'ascii'));
        client.write(Buffer.concat(buffers), () => client.end());
    });
    client.on('error', () => client.destroy());
}

io.on('connection', (socket) => {
    socket.emit('init', { isAccepting, queue, stats });
    socket.on('register', (data) => {
        const displayId = (data.type === 'shop' ? 'S-' : 'W-') + nextNumber++;
        const newGuest = { displayId, ...data, timestamp: Date.now() };
        queue.push(newGuest);
        stats.totalToday++;
        saveData();
        if (data.type === 'shop') printTicket(newGuest);
        io.emit('update', { queue, stats });
        socket.emit('registered', newGuest);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 System running on port ${PORT}`);
});
