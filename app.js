const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- ルーティング ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- データ管理 ---
const DATA_FILE = path.join(__dirname, 'queue-data.json');
let queue = [];
let nextNumber = 1;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
let printJobBuffer = null;

if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queue = data.queue || [];
        nextNumber = data.nextNumber || 1;
        stats = data.stats || stats;
    } catch (e) { console.log("New data file will be created."); }
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ queue, nextNumber, stats }, null, 2));
}

// --- 🖨️ CloudPRNT 制御 (文字化け・サイズ・カット修正済) ---
app.post('/cloudprnt', (req, res) => {
    res.json({ jobReady: printJobBuffer !== null, mediaTypes: ["application/vnd.star.starprnt"] });
});

app.get('/cloudprnt', (req, res) => {
    if (printJobBuffer) {
        res.setHeader('Content-Type', 'application/vnd.star.starprnt');
        res.send(printJobBuffer);
        printJobBuffer = null;
    } else {
        res.status(204).end();
    }
});

function createPrintJob(guest) {
    const ESC = '\x1B'; const GS = '\x1D'; const FS = '\x1C';
    const buffers = [];
    // 初期化 + 中央揃え
    buffers.push(Buffer.from(ESC + '@' + FS + '&' + ESC + 'a' + '\x01', 'ascii'));
    // 店名 (2倍サイズ)
    buffers.push(Buffer.from(GS + '!' + '\x11', 'ascii'));
    buffers.push(iconv.encode('松乃木飯店\n', 'Shift_JIS'));
    // 受付番号 (4倍特大サイズ)
    buffers.push(Buffer.from(GS + '!' + '\x33', 'ascii'));
    buffers.push(iconv.encode('\n' + guest.displayId + '\n\n', 'Shift_JIS'));
    // 詳細 (通常サイズ)
    buffers.push(Buffer.from(GS + '!' + '\x00', 'ascii'));
    let details = `大人:${guest.adults}名 / 子供:${guest.children}名\n`;
    details += `--------------------------\n`;
    details += `受付:${new Date().toLocaleTimeString('ja-JP')}\n\n`;
    buffers.push(iconv.encode(details, 'Shift_JIS'));
    // 紙送り＆カット
    buffers.push(Buffer.from(ESC + 'd' + '\x02' + GS + 'V' + '\x42' + '\x00', 'ascii'));
    printJobBuffer = Buffer.concat(buffers);
}

// --- Socket.io ロジック ---
io.on('connection', (socket) => {
    socket.emit('init', { queue, stats });
    socket.on('register', (data) => {
        const displayId = (data.type === 'shop' ? 'S-' : 'W-') + nextNumber++;
        const newGuest = { displayId, ...data, timestamp: Date.now(), status: 'waiting' };
        queue.push(newGuest);
        stats.totalToday++;
        saveData();
        if (data.type === 'shop') createPrintJob(newGuest);
        io.emit('update', { queue, stats });
        socket.emit('registered', newGuest);
    });
    socket.on('updateStatus', ({ displayId, status }) => {
        if (status === 'completed' || status === 'delete') {
            queue = queue.filter(g => g.displayId !== displayId);
            if (status === 'completed') stats.completedToday++;
            saveData();
            io.emit('update', { queue, stats });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
