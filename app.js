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

const SHOP_EMAIL = process.env.SHOP_EMAIL || 'matunokihanten.yoyaku@gmail.com';
const GMAIL_USER = process.env.GMAIL_USER || 'matunokihanten.yoyaku@gmail.com'; 
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || 'gphm kodc uzbp dcmh'; 
const DATA_FILE = path.join(__dirname, 'queue-data.json');

let queue = [];
let nextNumber = 1;
let isAccepting = true;
let stopTimer = null;
let stats = {
    totalToday: 0,
    completedToday: 0,
    averageWaitTime: 0
};
let absentTimers = {}; // 不在タイマー管理

// データ永続化：起動時に読み込み
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            queue = data.queue || [];
            nextNumber = data.nextNumber || 1;
            isAccepting = data.isAccepting !== undefined ? data.isAccepting : true;
            stats = data.stats || stats;
            console.log('✅ データを復元しました:', { queue: queue.length, nextNumber, isAccepting });
        }
    } catch (error) {
        console.error('❌ データ読み込みエラー:', error.message);
    }
}

// データ永続化：変更時に保存
function saveData() {
    try {
        const data = { queue, nextNumber, isAccepting, stats, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('❌ データ保存エラー:', error.message);
    }
}

// 日次リセット機能
function scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const timeUntilMidnight = tomorrow - now;
    
    setTimeout(() => {
        console.log('🔄 日次リセット実行中...');
        queue = [];
        nextNumber = 1;
        stats = {
            totalToday: 0,
            completedToday: 0,
            averageWaitTime: 0
        };
        absentTimers = {};
        saveData();
        io.emit('update', { queue, stats });
        io.emit('dailyReset');
        console.log('✅ 日次リセット完了');
        
        // 次の日のリセットをスケジュール
        scheduleDailyReset();
    }, timeUntilMidnight);
    
    console.log(`⏰ 次の自動リセット: ${tomorrow.toLocaleString('ja-JP')}`);
}

const getJSTime = () => new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo', 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit'
});

const getFullDateTime = () => new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
});

// メール送信トランスポーター（エラーハンドリング付き）
let transporter;
try {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', 
        port: 465, 
        secure: true,
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS }
    });
} catch (error) {
    console.error('❌ メール設定エラー:', error.message);
}

// ルーティング
app.get('/shop', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'shop.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API: 現在の統計情報
app.get('/api/stats', (req, res) => {
    res.json({
        queue: queue.length,
        totalToday: stats.totalToday,
        completedToday: stats.completedToday,
        averageWaitTime: stats.averageWaitTime,
        isAccepting
    });
});

io.on('connection', (socket) => {
    console.log('🔌 クライアント接続:', socket.id);
    
    // 初期データ送信
    socket.emit('init', { isAccepting, queue, stats });

    socket.on('register', (data) => {
        if (!isAccepting) {
            socket.emit('error', { message: '現在受付を停止しています' });
            return;
        }

        try {
            const prefix = data.type === 'shop' ? 'S' : 'W';
            const displayId = `${prefix}-${nextNumber++}`;
            const timestamp = Date.now();
            const newGuest = { 
                displayId, 
                ...data, 
                status: 'waiting',
                arrived: false, // 到着フラグ
                called: false,  // 呼び出しフラグ
                time: getJSTime(),
                fullDateTime: getFullDateTime(),
                timestamp
            };
            
            queue.push(newGuest);
            stats.totalToday++;
            
            saveData();
            
            io.emit('update', { queue, stats });
            socket.emit('registered', newGuest);

            console.log(`✅ 新規受付: ${displayId} (大人${data.adults}/子${data.children}/幼${data.infants}) タイプ: ${data.type}`);

            // Web予約の場合はメール通知
            if (data.type === 'web' && transporter) {
                const mailOptions = {
                    from: GMAIL_USER, 
                    to: SHOP_EMAIL,
                    subject: `【松乃木飯店】新規予約 ${displayId}`,
                    text: `予約通知\n\n番号：${displayId}\n大人：${data.adults}名\n子供：${data.children}名\n幼児：${data.infants}名\n希望座席：${data.pref}\n受付時刻：${newGuest.fullDateTime}`
                };
                
                transporter.sendMail(mailOptions).catch(err => {
                    console.error('❌ メール送信エラー:', err.message);
                });
            }
        } catch (error) {
            console.error('❌ 受付エラー:', error.message);
            socket.emit('error', { message: '受付処理に失敗しました' });
        }
    });

    // 到着通知
    socket.on('markArrived', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                guest.arrived = true;
                guest.arrivedTime = getJSTime();
                saveData();
                io.emit('update', { queue, stats });
                io.emit('guestArrived', { displayId });
                console.log(`✅ 到着通知: ${displayId}`);
            }
        } catch (error) {
            console.error('❌ 到着通知エラー:', error.message);
        }
    });

    // 呼び出し機能
    socket.on('callGuest', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                guest.called = true;
                guest.calledTime = getJSTime();
                saveData();
                io.emit('update', { queue, stats });
                // 呼び出し通知を送信
                io.emit('guestCalled', { displayId, type: guest.type });
                console.log(`📢 呼び出し: ${displayId} (タイプ: ${guest.type})`);
            }
        } catch (error) {
            console.error('❌ 呼び出しエラー:', error.message);
        }
    });

    // 不在ボタン
    socket.on('markAbsent', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                guest.absent = true;
                guest.absentTime = getJSTime();
                
                // 既存のタイマーをクリア
                if (absentTimers[displayId]) {
                    clearTimeout(absentTimers[displayId]);
                }
                
                // 10分後に自動キャンセル
                absentTimers[displayId] = setTimeout(() => {
                    const stillExists = queue.find(g => g.displayId === displayId);
                    if (stillExists && stillExists.absent) {
                        queue = queue.filter(g => g.displayId !== displayId);
                        delete absentTimers[displayId];
                        saveData();
                        io.emit('update', { queue, stats });
                        io.emit('guestAutoCancelled', { displayId });
                        console.log(`⏰ 自動キャンセル（不在10分経過）: ${displayId}`);
                    }
                }, 10 * 60 * 1000); // 10分
                
                saveData();
                io.emit('update', { queue, stats });
                console.log(`⚠️ 不在マーク: ${displayId} (10分後に自動キャンセル)`);
            }
        } catch (error) {
            console.error('❌ 不在マークエラー:', error.message);
        }
    });

    // 不在キャンセル
    socket.on('cancelAbsent', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest && guest.absent) {
                guest.absent = false;
                delete guest.absentTime;
                
                // タイマーをクリア
                if (absentTimers[displayId]) {
                    clearTimeout(absentTimers[displayId]);
                    delete absentTimers[displayId];
                }
                
                saveData();
                io.emit('update', { queue, stats });
                console.log(`✅ 不在解除: ${displayId}`);
            }
        } catch (error) {
            console.error('❌ 不在解除エラー:', error.message);
        }
    });

    socket.on('updateStatus', ({ displayId, status }) => {
        try {
            if (status === 'delete' || status === 'completed') {
                const guest = queue.find(g => g.displayId === displayId);
                if (guest && status === 'completed') {
                    stats.completedToday++;
                    // 待ち時間を計算（平均待ち時間更新）
                    const waitTime = (Date.now() - guest.timestamp) / 1000 / 60; // 分単位
                    stats.averageWaitTime = Math.round(
                        (stats.averageWaitTime * (stats.completedToday - 1) + waitTime) / stats.completedToday
                    );
                }
                
                // タイマーをクリア
                if (absentTimers[displayId]) {
                    clearTimeout(absentTimers[displayId]);
                    delete absentTimers[displayId];
                }
                
                queue = queue.filter(g => g.displayId !== displayId);
                saveData();
                console.log(`✅ 案内完了: ${displayId}`);
            }
            io.emit('update', { queue, stats });
        } catch (error) {
            console.error('❌ ステータス更新エラー:', error.message);
        }
    });

    // 管理画面からの受付設定
    socket.on('setAcceptance', (data) => {
        try {
            isAccepting = data.status;
            if (stopTimer) { 
                clearTimeout(stopTimer); 
                stopTimer = null; 
            }

            if (!isAccepting && data.duration > 0) {
                // 指定時間（分）が経過したら自動で再開
                stopTimer = setTimeout(() => {
                    isAccepting = true;
                    io.emit('statusChange', { isAccepting, message: '受付を自動再開しました' });
                    saveData();
                    stopTimer = null;
                    console.log('✅ 受付自動再開');
                }, data.duration * 60000);
                console.log(`⏸️ 受付停止（${data.duration}分後に自動再開）`);
            } else if (!isAccepting) {
                console.log('⏸️ 受付停止');
            } else {
                console.log('▶️ 受付再開');
            }
            
            saveData();
            io.emit('statusChange', { isAccepting });
        } catch (error) {
            console.error('❌ 受付設定エラー:', error.message);
        }
    });

    // 統計リセット（管理画面用）
    socket.on('resetStats', () => {
        stats = {
            totalToday: 0,
            completedToday: 0,
            averageWaitTime: 0
        };
        saveData();
        io.emit('update', { queue, stats });
        console.log('📊 統計をリセットしました');
    });

    socket.on('disconnect', () => {
        console.log('🔌 クライアント切断:', socket.id);
    });
});

// 起動時にデータを読み込む
loadData();

// 日次リセットをスケジュール
scheduleDailyReset();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 松乃木飯店 受付システム起動`);
    console.log(`📡 サーバー: http://localhost:${PORT}`);
    console.log(`👥 ネット受付: http://localhost:${PORT}`);
    console.log(`🏪 店舗受付: http://localhost:${PORT}/shop`);
    console.log(`🔧 管理画面: http://localhost:${PORT}/admin`);
    console.log(`📊 待ち組数: ${queue.length}組`);
    console.log(`📈 本日累計: ${stats.totalToday}組`);
});
