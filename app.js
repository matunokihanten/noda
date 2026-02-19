const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const iconv = require('iconv-lite'); // 文字化け対策用に追加

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
let lastResetDate = null; // 最後のリセット日
let printerEnabled = true; // プリンター印刷有効/無効
let waitTimeDisplayEnabled = true; // 待ち時間表示有効/無効

// --- 🖨️ CloudPRNT 印刷ジョブ管理 ---
let printJobs = []; // プリンターが取りに来るためのジョブ待ち行列

// 今日の日付を取得（YYYY-MM-DD形式）
function getTodayDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// データ永続化：起動時に読み込み + 日付チェック
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            lastResetDate = data.lastResetDate || null;
            printerEnabled = data.printerEnabled !== undefined ? data.printerEnabled : true;
            waitTimeDisplayEnabled = data.waitTimeDisplayEnabled !== undefined ? data.waitTimeDisplayEnabled : true;
            
            // 前回の起動日と今日の日付が違っていたらリセット
            const today = getTodayDate();
            if (lastResetDate !== today) {
                console.log(`📅 日付が変わりました: ${lastResetDate} → ${today}`);
                console.log('🔄 データをリセットします...');
                // データをリセット（統計と次番号のみ、既存キューは保持）
                stats = {
                    totalToday: 0,
                    completedToday: 0,
                    averageWaitTime: 0
                };
                // 待ちリストがなければ次番号もリセット
                if (queue.length === 0) {
                    nextNumber = 1;
                }
                absentTimers = {};
                lastResetDate = today;
                saveData();
                console.log('✅ リセット完了');
            } else {
                // 同じ日付ならデータを復元
                queue = data.queue || [];
                nextNumber = data.nextNumber || 1;
                isAccepting = data.isAccepting !== undefined ? data.isAccepting : true;
                stats = data.stats || stats;
                console.log('✅ データを復元しました:', { queue: queue.length, nextNumber, isAccepting });
            }
        } else {
            // 初回起動
            lastResetDate = getTodayDate();
            saveData();
        }
    } catch (error) {
        console.error('❌ データ読み込みエラー:', error.message);
        lastResetDate = getTodayDate();
    }
}

// データ永続化：変更時に保存
function saveData() {
    try {
        const data = { 
            queue, 
            nextNumber, 
            isAccepting, 
            stats, 
            lastResetDate,
            printerEnabled,
            waitTimeDisplayEnabled,
            lastUpdated: new Date().toISOString() 
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('❌ データ保存エラー:', error.message);
    }
}

// 定期的に日付をチェック（1時間ごと）
function checkDateChange() {
    setInterval(() => {
        const today = getTodayDate();
        if (lastResetDate !== today) {
            console.log(`🔄 日付が変わりました: ${lastResetDate} → ${today}`);
            stats = {
                totalToday: 0,
                completedToday: 0,
                averageWaitTime: 0
            };
            // 待ちリストがなければ次番号もリセット
            if (queue.length === 0) {
                nextNumber = 1;
            }
            absentTimers = {};
            lastResetDate = today;
            saveData();
            
            const queueWithEstimate = queue.map((g, index) => ({
                ...g,
                estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
            }));
            io.emit('update', { queue: queueWithEstimate, stats });
            io.emit('dailyReset');
            console.log('✅ 自動リセット完了');
        }
    }, 60 * 60 * 1000); // 1時間ごとにチェック
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

// プリンター印刷関数 (CloudPRNTのジョブキューに追加)
function printTicket(guest) {
    if (!printerEnabled) {
        console.log('🖨️ プリンター印刷: 無効');
        return;
    }
    
    try {
        // ESC/POS コマンド
        const ESC = '\x1B';
        const GS = '\x1D';
        
        let text = '';
        
        // 初期化
        text += ESC + '@';
        
        // 中央揃え
        text += ESC + 'a' + String.fromCharCode(1);
        
        // 店名（太字・大きい文字）
        text += GS + '!' + String.fromCharCode(0x11); // 2倍幅・2倍高さ
        text += '松乃木飯店\n\n';
        
        // リセット
        text += GS + '!' + String.fromCharCode(0);
        
        // 受付番号（特大）※数字は大きく印刷
        text += GS + '!' + String.fromCharCode(0x33); // 4倍幅・4倍高さ
        text += guest.displayId + '\n\n';
        text += GS + '!' + String.fromCharCode(0);
        
        // 名前（あれば）
        if (guest.name) {
            text += GS + '!' + String.fromCharCode(0x11);
            text += guest.name + '様\n\n';
            text += GS + '!' + String.fromCharCode(0);
        }
        
        // 詳細情報
        text += '--------------------------------\n';
        text += `大人: ${guest.adults}名\n`;
        text += `子供: ${guest.children}名\n`;
        text += `幼児: ${guest.infants}名\n`;
        text += `座席: ${guest.pref}\n`;
        text += `受付: ${guest.time}\n`;
        text += '--------------------------------\n\n';
        
        // 待ち時間目安（有効な場合）
        if (waitTimeDisplayEnabled) {
            const estimatedWait = calculateEstimatedWait(queue.indexOf(guest));
            if (estimatedWait > 0) {
                text += `待ち時間目安: 約${estimatedWait}分\n`;
                text += '※混雑状況により前後します\n\n';
            }
        }
        
        // 注意事項
        text += 'この番号を保管してください\n';
        text += '順番が近づきましたら\n';
        text += 'お呼び出しいたします\n\n';
        
        // 紙送り＆フルカット
        text += ESC + 'd' + String.fromCharCode(2); // 2行紙送り
        text += GS + 'V' + String.fromCharCode(66) + String.fromCharCode(0); // フルカット
        
        // 【文字化け対策】Shift_JISにエンコード
        const buffer = iconv.encode(text, 'SJIS');
        
        // 印刷ジョブをキューに追加（プリンターが取りに来るのを待つ）
        printJobs.push(buffer);
        console.log(`🖨️ 印刷ジョブを登録しました: ${guest.displayId}`);
        
    } catch (error) {
        console.error('❌ 印刷処理エラー:', error.message);
    }
}

// 待ち時間目安計算
function calculateEstimatedWait(guestIndex) {
    const beforeCount = guestIndex;
    if (beforeCount <= 0) return 0; // 先頭なら0
    const unitTime = Math.max(stats.averageWaitTime || 5, 5);
    let estimated = beforeCount * unitTime * 1.2;
    return Math.ceil(estimated / 5) * 5; // 5分単位で切り上げ
}

// --- 🌐 CloudPRNT ルーティング ---

// 1. プリンターが「仕事ある？」と聞きに来た時
app.post('/cloudprnt', (req, res) => {
    const hasJob = printJobs.length > 0;
    res.json({
        jobReady: hasJob,
        mediaTypes: ["application/vnd.star.starprnt"]
    });
});

// 2. プリンターが「データちょうだい」と来た時
app.get('/cloudprnt', (req, res) => {
    if (printJobs.length > 0) {
        const jobBuffer = printJobs[0];
        res.setHeader('Content-Type', 'application/vnd.star.starprnt');
        res.setHeader('Content-Length', jobBuffer.length); // 即座に印刷させるための魔法
        res.send(jobBuffer);
        console.log('🖨️ プリンターへデータを送信しました');
    } else {
        res.status(204).send();
    }
});

// 3. プリンターが「印刷終わったよ！」と報告してきた時
app.delete('/cloudprnt', (req, res) => {
    if (printJobs.length > 0) {
        printJobs.shift(); // 完了したジョブを先頭から削除
        console.log('✅ プリンターから印刷完了報告を受け取りました');
    }
    res.status(200).send();
});

// --- 既存ルーティング ---
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
        isAccepting,
        printerEnabled,
        waitTimeDisplayEnabled
    });
});

io.on('connection', (socket) => {
    console.log('🔌 クライアント接続:', socket.id);
    
    const queueWithEstimate = queue.map((g, index) => ({
        ...g,
        estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
    }));
    socket.emit('init', { 
        isAccepting, 
        queue: queueWithEstimate, 
        stats,
        printerEnabled,
        waitTimeDisplayEnabled
    });

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
                arrived: false,
                called: false,
                name: data.name || '',
                time: getJSTime(),
                fullDateTime: getFullDateTime(),
                timestamp
            };
            
            queue.push(newGuest);
            stats.totalToday++;
            
            saveData();
            
            // プリンター印刷（ジョブ追加）
            if (printerEnabled && data.type === 'shop') {
                printTicket(newGuest);
            }
            
            const queueWithEstimate = queue.map((g, index) => ({
                ...g,
                estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
            }));
            io.emit('update', { queue: queueWithEstimate, stats });
            
            const guestWithEstimate = {
                ...newGuest,
                estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(queue.length - 1) : null
            };
            socket.emit('registered', guestWithEstimate);
            
            console.log(`✅ 新規受付: ${displayId} ${newGuest.name ? `(${newGuest.name})` : ''} (大人${data.adults}/子${data.children}/幼${data.infants}) タイプ: ${data.type}`);
            
            if (data.type === 'web' && transporter) {
                const mailOptions = {
                    from: GMAIL_USER, 
                    to: SHOP_EMAIL,
                    subject: `【松乃木飯店】新規予約 ${displayId}`,
                    text: `予約通知\n\n番号：${displayId}\n${newGuest.name ? `お名前：${newGuest.name}\n` : ''}大人：${data.adults}名\n子供：${data.children}名\n幼児：${data.infants}名\n希望座席：${data.pref}\n受付時刻：${newGuest.fullDateTime}`
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

    socket.on('markArrived', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                guest.arrived = true;
                guest.arrivedTime = getJSTime();
                saveData();
                
                const queueWithEstimate = queue.map((g, index) => ({
                    ...g,
                    estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
                }));
                io.emit('update', { queue: queueWithEstimate, stats });
                io.emit('guestArrived', { displayId });
                console.log(`✅ 到着通知: ${displayId}`);
            }
        } catch (error) {
            console.error('❌ 到着通知エラー:', error.message);
        }
    });

    socket.on('callGuest', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                guest.called = true;
                guest.calledTime = getJSTime();
                saveData();
                
                const queueWithEstimate = queue.map((g, index) => ({
                    ...g,
                    estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
                }));
                io.emit('update', { queue: queueWithEstimate, stats });
                
                io.emit('guestCalled', { 
                    displayId, 
                    type: guest.type,
                    name: guest.name || '',
                    adults: guest.adults,
                    children: guest.children,
                    infants: guest.infants
                });
                console.log(`📢 呼び出し: ${displayId} ${guest.name ? `(${guest.name})` : ''} (タイプ: ${guest.type})`);
            }
        } catch (error) {
            console.error('❌ 呼び出しエラー:', error.message);
        }
    });

    socket.on('markAbsent', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                guest.absent = true;
                guest.absentTime = getJSTime();
                
                if (absentTimers[displayId]) {
                    clearTimeout(absentTimers[displayId]);
                }
                
                absentTimers[displayId] = setTimeout(() => {
                    const stillExists = queue.find(g => g.displayId === displayId);
                    if (stillExists && stillExists.absent) {
                        queue = queue.filter(g => g.displayId !== displayId);
                        delete absentTimers[displayId];
                        saveData();
                        
                        const queueWithEstimate = queue.map((g, index) => ({
                            ...g,
                            estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
                        }));
                        io.emit('update', { queue: queueWithEstimate, stats });
                        io.emit('guestAutoCancelled', { displayId });
                        console.log(`⏰ 自動キャンセル（不在10分経過）: ${displayId}`);
                    }
                }, 10 * 60 * 1000);
                
                saveData();
                const queueWithEstimate = queue.map((g, index) => ({
                    ...g,
                    estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
                }));
                io.emit('update', { queue: queueWithEstimate, stats });
                console.log(`⚠️ 不在マーク: ${displayId} (10分後に自動キャンセル)`);
            }
        } catch (error) {
            console.error('❌ 不在マークエラー:', error.message);
        }
    });

    socket.on('cancelAbsent', ({ displayId }) => {
        try {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest && guest.absent) {
                guest.absent = false;
                delete guest.absentTime;
                
                if (absentTimers[displayId]) {
                    clearTimeout(absentTimers[displayId]);
                    delete absentTimers[displayId];
                }
                
                saveData();
                const queueWithEstimate = queue.map((g, index) => ({
                    ...g,
                    estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
                }));
                io.emit('update', { queue: queueWithEstimate, stats });
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
                    const waitTime = (Date.now() - guest.timestamp) / 1000 / 60;
                    stats.averageWaitTime = Math.round(
                        (stats.averageWaitTime * (stats.completedToday - 1) + waitTime) / stats.completedToday
                    );
                }
                
                if (absentTimers[displayId]) {
                     clearTimeout(absentTimers[displayId]);
                    delete absentTimers[displayId];
                }
                
                queue = queue.filter(g => g.displayId !== displayId);
                saveData();
                console.log(`✅ 案内完了: ${displayId}`);
            }
            
            const queueWithEstimate = queue.map((g, index) => ({
                ...g,
                estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
            }));
            io.emit('update', { queue: queueWithEstimate, stats });
        } catch (error) {
            console.error('❌ ステータス更新エラー:', error.message);
        }
    });

    socket.on('setAcceptance', (data) => {
        try {
            isAccepting = data.status;
            if (stopTimer) { 
                clearTimeout(stopTimer); 
                stopTimer = null; 
            }

            if (!isAccepting && data.duration > 0) {
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
            const queueWithEstimate = queue.map((g, index) => ({
                ...g,
                estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
            }));
            io.emit('statusChange', { isAccepting, queue: queueWithEstimate });
        } catch (error) {
            console.error('❌ 受付設定エラー:', error.message);
        }
    });

    socket.on('resetStats', () => {
        stats = {
            totalToday: 0,
            completedToday: 0,
            averageWaitTime: 0
        };
        saveData();
        const queueWithEstimate = queue.map((g, index) => ({
            ...g,
            estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
        }));
        io.emit('update', { queue: queueWithEstimate, stats });
        console.log('📊 統計をリセットしました');
    });

    socket.on('resetQueueNumber', () => {
        try {
            if (queue.length > 0) {
                socket.emit('error', { message: '待ち客がいる間は番号リセットできません' });
                return;
            }
            nextNumber = 1;
            saveData();
            io.emit('queueNumberReset', { nextNumber });
            console.log('🔄 受付番号を手動リセット: 次番号 = 1');
        } catch (error) {
            console.error('❌ 番号リセットエラー:', error.message);
        }
    });

    socket.on('setPrinterEnabled', (data) => {
        try {
            printerEnabled = data.enabled;
            saveData();
            io.emit('printerStatusChanged', { printerEnabled });
            console.log(`🖨️ プリンター: ${printerEnabled ? '有効' : '無効'}`);
        } catch (error) {
            console.error('❌ プリンター設定エラー:', error.message);
        }
    });

    socket.on('setWaitTimeDisplay', (data) => {
        try {
            waitTimeDisplayEnabled = data.enabled;
            saveData();
            
            const queueWithEstimate = queue.map((g, index) => ({
                ...g,
                estimatedWait: waitTimeDisplayEnabled ? calculateEstimatedWait(index) : null
            }));
            
            io.emit('waitTimeDisplayChanged', { 
                waitTimeDisplayEnabled,
                queue: queueWithEstimate
            });
             console.log(`⏱️ 待ち時間表示: ${waitTimeDisplayEnabled ? '有効' : '無効'}`);
        } catch (error) {
            console.error('❌ 待ち時間表示設定エラー:', error.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 クライアント切断:', socket.id);
    });
});

loadData();
checkDateChange();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 松乃木飯店 受付システム起動`);
    console.log(`📅 本日の日付: ${lastResetDate}`);
    console.log(`📡 サーバー: http://localhost:${PORT}`);
    console.log(`👥 ネット受付: http://localhost:${PORT}`);
    console.log(`🏪 店舗受付: http://localhost:${PORT}/shop`);
    console.log(`🔧 管理画面: http://localhost:${PORT}/admin`);
    console.log(`🖨️ プリンター通信: CloudPRNT待ち受け中 (エンドポイント: /cloudprnt)`);
    console.log(`⏱️ 待ち時間表示: ${waitTimeDisplayEnabled ? '有効' : '無効'}`);
    console.log(`📊 待ち組数: ${queue.length}組`);
    console.log(`📈 本日累計: ${stats.totalToday}組`);
});
