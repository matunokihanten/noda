const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- ルーティング設定（Cannot GET 対策） ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- データ管理 ---
const DATA_FILE = path.join(__dirname, 'queue-data.json');
let queue = [];
let nextNumber = 1;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
let printJobBuffer = null; // 印刷待ちデータの一時保存用

if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        queue = data.queue || [];
        nextNumber = data.nextNumber || 1;
        stats = data.stats || stats;
    } catch (e) { console.error("Data load error"); }
}

function saveData() {
    const data = { queue, nextNumber, stats };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- 🖨️ CloudPRNT 対応セクション（重要） ---

// 1. プリンターが「仕事ある？」とPOSTしてくる口
app.post('/cloudprnt', (req, res) => {
    res.json({
        jobReady: printJobBuffer !== null,
        mediaTypes: ["application/vnd.star.starprnt"]
    });
});

// 2. プリンターがデータをダウンロードしに来る口
app.get('/cloudprnt', (req, res) => {
    if (printJobBuffer) {
        res.setHeader('Content-Type', 'application/vnd.star.starprnt');
        res.send(printJobBuffer);
        // 印刷データを送ったらバッファをクリア（1回きり）
        printJobBuffer = null;
    } else {
        res.status(204).end();
    }
});

// 3. 印刷データを生成する関数
function createPrintJob(guest) {
    const ESC = '\x1B';
    const GS = '\x1D';
    const FS = '\x1C';
    const buffers = [];

    // 初期化 + 中央揃え
    buffers.push(Buffer.from(ESC + '@' + FS + '&' + ESC + 'a' + '\x01', 'ascii'));
    
    // 店名
    buffers.push(Buffer.from(GS + '!' + '\x11', 'ascii'));
    buffers.push(iconv.encode('松乃木飯店\n', 'Shift_JIS'));
    
    // 受付番号（特大）
    buffers.push(Buffer.from(GS + '!' + '\x33', 'ascii'));
    buffers.push(iconv.encode('\n' + guest.displayId + '\n\n', 'Shift_JIS'));
    
    // 詳細
    buffers.push(Buffer.from(GS + '!' + '\x00', 'ascii'));
    let details = `大人:${guest.adults}名 / 子供:${guest.children}名\n`;
    details += `--------------------------\n`;
    details += `受付:${new Date().toLocaleTimeString('ja-JP')}\n`;
    details += `ご来店お待ちしております\n\n\n`;
    buffers.push(iconv.encode(details, 'Shift_JIS'));
    
    // 紙送り＆カット
    buffers.push(Buffer.from(ESC + 'd' + '\x02' + GS + 'V' + '\x42' + '\x00', 'ascii'));
    
    printJobBuffer = Buffer.concat(buffers);
}

// --- Socket.io 通信 ---
io.on('connection', (socket) => {
    socket.emit('init', { queue, stats });

    socket.on('register', (data) => {
        const displayId = (data.type === 'shop' ? 'S-' : 'W-') + nextNumber++;
        const newGuest = { displayId, ...data, timestamp: Date.now() };
        queue.push(newGuest);
        stats.totalToday++;
        saveData();

        // 店舗受付なら印刷ジョブを作成
        if (data.type === 'shop') {
            createPrintJob(newGuest);
        }

        io.emit('update', { queue, stats });
        socket.emit('registered', newGuest);
    });
    
    // 案内完了処理など
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
server.listen(PORT, () => {
    console.log(`🚀 松乃木飯店システム Port:${PORT} で稼働中`);
});
