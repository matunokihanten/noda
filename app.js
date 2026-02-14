const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- 設定 ---
const SHOP_EMAIL = process.env.SHOP_EMAIL || 'matunokihanten.yoyaku@gmail.com';
const GMAIL_USER = process.env.GMAIL_USER || 'matunokihanten.yoyaku@gmail.com'; 
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || 'gphm kodc uzbp dcmh'; 
const DATA_FILE = path.join(__dirname, 'queue-data.json');

// --- グローバル変数 ---
let queue = [];
let nextNumber = 1;
let isAccepting = true;
let stopTimer = null;
let stats = {
    totalToday: 0,
    completedToday: 0,
    averageWaitTime: 10
};
const pendingTimers = {}; // 不在タイマー管理用

// --- データ管理 ---
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            
            // 日付チェック（自動リセット）
            const todayStr = new Date().toLocaleDateString('ja-JP');
            const lastDate = data.lastDate || "";

            if (lastDate !== todayStr) {
                console.log('🌅 日付が変わったため、番号と統計をリセットします。');
                queue = [];
                nextNumber = 1;
                stats = { totalToday: 0, completedToday: 0, averageWaitTime: 10 };
            } else {
                queue = data.queue || [];
                nextNumber = data.nextNumber || 1;
                isAccepting = data.isAccepting !== undefined ? data.isAccepting : true;
                stats = data.stats || stats;
                console.log('✅ 前回のデータを復元しました。');
            }
        }
    } catch (error) {
        console.error('❌ データ読み込みエラー:', error.message);
    }
}

function saveData() {
    try {
        const data = { 
            queue, nextNumber, isAccepting, stats, 
            lastDate: new Date().toLocaleDateString('ja-JP'), // 今日の日付を保存
            lastUpdated: new Date().toISOString() 
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('❌ データ保存エラー:', error.message);
    }
}

const getJSTime = () => new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const getFullDateTime = () => new Date().toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// --- メール設定 ---
let transporter;
try {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS }
    });
} catch (error) { console.error('❌ メール設定エラー:', error.message); }

// --- ルーティング ---
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));

// --- Socket.IO ---
io.on('connection', (socket) => {
    // 初期化
    socket.emit('init', { isAccepting, queue, stats });

    // 新規受付
    socket.on('register', (data) => {
        if (!isAccepting) return socket.emit('error', { message: '現在受付を停止しています' });

        try {
            const prefix = data.type === 'shop' ? 'S' : 'W';
            const displayId = `${prefix}-${nextNumber++}`;
            
            const newGuest = { 
                displayId, ...data, 
                status: 'waiting', 
                time: getJSTime(), 
                fullDateTime: getFullDateTime(),
                timestamp: Date.now()
            };
            
            queue.push(newGuest);
            stats.totalToday++;
            saveData();
            
            io.emit('update', { queue, stats });
            socket.emit('registered', newGuest);
            console.log(`✅ 受付: ${displayId} (${data.type})`);

            // ★修正箇所：Web予約(type='web')の時だけメール送信
            if (data.type === 'web' && transporter) {
                transporter.sendMail({
                    from: GMAIL_USER,
                    to: SHOP_EMAIL,
                    subject: `【松乃木飯店】Web予約：${displayId}`,
                    text: `Webから予約が入りました。\n\n番号：${displayId}\n大人：${data.adults}名\n子供：${data.children}名\n幼児：${data.infants}名\n席希望：${data.pref}\n受付時刻：${newGuest.fullDateTime}`
                }).then(() => console.log(`✉️ メール送信成功: ${displayId}`))
                  .catch(err => console.error(`❌ メール送信失敗: ${err.message}`));
            }

        } catch (error) {
            socket.emit('error', { message: '受付処理エラー' });
        }
    });

    // チェックイン（来店確認）
    socket.on('checkIn', (displayId) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.status = 'checked-in';
            guest.checkInTime = getJSTime();
            // 不在タイマー解除
            if (pendingTimers[displayId]) {
                clearTimeout(pendingTimers[displayId]);
                delete pendingTimers[displayId];
            }
            saveData();
            io.emit('update', { queue, stats });
            socket.emit('checkInSuccess', { displayId });
        }
    });

    // 呼び出し
    socket.on('callGuest', (displayId) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            io.emit('calledNotice', { displayId });
            console.log(`📢 呼出: ${displayId}`);
        }
    });

    // 不在処理（10分タイマー）
    socket.on('setPending', (displayId) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.status = 'pending';
            guest.pendingStart = Date.now();
            io.emit('update', { queue, stats });

            if (pendingTimers[displayId]) clearTimeout(pendingTimers[displayId]);
            pendingTimers[displayId] = setTimeout(() => {
                queue = queue.filter(g => g.displayId !== displayId);
                delete pendingTimers[displayId];
                saveData();
                io.emit('update', { queue, stats });
                console.log(`🗑️ 自動キャンセル: ${displayId}`);
            }, 600000); // 10分
        }
    });

    // ステータス更新（完了・削除）
    socket.on('updateStatus', ({ displayId, status }) => {
        if (status === 'completed' || status === 'delete') {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest && status === 'completed') {
                stats.completedToday++;
                const wait = (Date.now() - guest.timestamp) / 60000;
                stats.averageWaitTime = Math.round((stats.averageWaitTime * (stats.completedToday - 1) + wait) / stats.completedToday);
            }
            queue = queue.filter(g => g.displayId !== displayId);
            if (pendingTimers[displayId]) {
                clearTimeout(pendingTimers[displayId]);
                delete pendingTimers[displayId];
            }
            saveData();
        }
        io.emit('update', { queue, stats });
    });

    // 受付停止・再開
    socket.on('setAcceptance', (data) => {
        isAccepting = data.status;
        if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
        if (!isAccepting && data.duration > 0) {
            stopTimer = setTimeout(() => {
                isAccepting = true;
                io.emit('statusChange', { isAccepting });
                saveData();
            }, data.duration * 60000);
        }
        saveData();
        io.emit('statusChange', { isAccepting });
    });

    // 統計リセット
    socket.on('resetStats', () => {
        stats = { totalToday: 0, completedToday: 0, averageWaitTime: 10 };
        saveData();
        io.emit('update', { queue, stats });
    });
});

// 起動
loadData();
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 松乃木飯店システム起動 (Port:${PORT})`);
});
