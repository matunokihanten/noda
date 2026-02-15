// webapp/app.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const nodemailer = require('nodemailer');
const pool = require('./db'); // データベース接続
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 環境変数
const SHOP_EMAIL = process.env.SHOP_EMAIL || 'shop@example.com';
const GMAIL_USER = process.env.GMAIL_USER || 'your-email@gmail.com';
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || 'your-app-pass';

// 変数（メモリ上の一時データではなく、設定など）
let isAccepting = true;
let stopTimer = null;

// 今日の日付文字列（DB検索用）
const getTodayString = () => new Date().toISOString().split('T')[0];

// 時刻フォーマット
const getJSTime = () => new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

// メール設定
let transporter;
try {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS }
    });
} catch (e) { console.error('メール設定エラー:', e); }

// --- データベース操作ヘルパー ---

// 今日の待ち行列を取得
async function getQueue() {
    try {
        // 今日のデータで、完了(completed)・削除(delete) 以外を取得
        const res = await pool.query(`
            SELECT * FROM guests 
            WHERE date(created_at AT TIME ZONE 'Asia/Tokyo') = date(now() AT TIME ZONE 'Asia/Tokyo')
            AND status NOT IN ('completed', 'delete')
            ORDER BY id ASC
        `);
        // DBのカラム名をフロントエンド用に整形
        return res.rows.map(row => ({
            ...row,
            displayId: row.display_id, // フロントエンドは camelCase を期待しているため変換
            time: new Date(row.created_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }),
            timestamp: new Date(row.created_at).getTime()
        }));
    } catch (err) {
        console.error('データ取得エラー:', err);
        return [];
    }
}

// 統計情報の取得
async function getStats() {
    try {
        const today = await pool.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
            FROM guests
            WHERE date(created_at AT TIME ZONE 'Asia/Tokyo') = date(now() AT TIME ZONE 'Asia/Tokyo')
        `);
        
        // 平均待ち時間の計算（完了した人の作成時間と更新時間の差分）
        const timeRes = await pool.query(`
            SELECT EXTRACT(EPOCH FROM (updated_at - created_at))/60 as wait_min
            FROM guests
            WHERE status = 'completed'
            AND date(created_at AT TIME ZONE 'Asia/Tokyo') = date(now() AT TIME ZONE 'Asia/Tokyo')
        `);
        
        let avg = 0;
        if (timeRes.rows.length > 0) {
            const totalMin = timeRes.rows.reduce((sum, r) => sum + r.wait_min, 0);
            avg = Math.round(totalMin / timeRes.rows.length);
        }

        return {
            totalToday: parseInt(today.rows[0].total),
            completedToday: parseInt(today.rows[0].completed),
            averageWaitTime: avg
        };
    } catch (err) {
        console.error('統計取得エラー:', err);
        return { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
    }
}

// --- ルーティング ---
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- Socket.IO イベント ---
io.on('connection', async (socket) => {
    // 接続時に最新データを送信
    const queue = await getQueue();
    const stats = await getStats();
    socket.emit('init', { isAccepting, queue, stats });

    // 新規登録
    socket.on('register', async (data) => {
        if (!isAccepting) return;
        try {
            // 本日の連番を取得
            const countRes = await pool.query(`
                SELECT COUNT(*) FROM guests 
                WHERE date(created_at AT TIME ZONE 'Asia/Tokyo') = date(now() AT TIME ZONE 'Asia/Tokyo')
            `);
            const nextNum = parseInt(countRes.rows[0].count) + 1;
            const prefix = data.type === 'shop' ? 'S' : 'W';
            const displayId = `${prefix}-${nextNum}`;

            // DBに保存
            const insertRes = await pool.query(`
                INSERT INTO guests (display_id, type, name, adults, children, infants, pref)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [displayId, data.type, data.name || '', data.adults, data.children, data.infants, data.pref]);

            const newGuest = insertRes.rows[0];
            
            // フロントエンド用に整形して通知
            const formattedGuest = {
                ...newGuest,
                displayId: newGuest.display_id,
                time: getJSTime(),
                timestamp: new Date(newGuest.created_at).getTime()
            };

            const updatedQueue = await getQueue();
            const updatedStats = await getStats();
            
            io.emit('update', { queue: updatedQueue, stats: updatedStats });
            socket.emit('registered', formattedGuest);

            // メール送信（Web予約のみ）
            if (data.type === 'web' && transporter) {
                transporter.sendMail({
                    from: GMAIL_USER,
                    to: SHOP_EMAIL,
                    subject: `【松乃木飯店】新規予約 ${displayId}`,
                    text: `番号：${displayId}\n大人：${data.adults}名\n時刻：${getJSTime()}`
                }).catch(e => console.error(e));
            }

        } catch (err) {
            console.error('登録エラー:', err);
            socket.emit('error', { message: '登録に失敗しました' });
        }
    });

    // 状態更新（到着・呼び出し・不在・完了）
    const updateGuestStatus = async (displayId, updates) => {
        try {
            // クエリの構築
            const keys = Object.keys(updates);
            const values = Object.values(updates);
            const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
            
            await pool.query(`
                UPDATE guests SET ${setClause}, updated_at = NOW()
                WHERE display_id = $1 AND date(created_at AT TIME ZONE 'Asia/Tokyo') = date(now() AT TIME ZONE 'Asia/Tokyo')
            `, [displayId, ...values]);

            const queue = await getQueue();
            const stats = await getStats();
            io.emit('update', { queue, stats });
            return true;
        } catch (err) {
            console.error('更新エラー:', err);
            return false;
        }
    };

    socket.on('markArrived', ({ displayId }) => {
        updateGuestStatus(displayId, { arrived: true });
        io.emit('guestArrived', { displayId });
    });

    socket.on('callGuest', async ({ displayId }) => {
        await updateGuestStatus(displayId, { called: true });
        // 呼び出しに必要な情報を取得して通知
        const res = await pool.query("SELECT * FROM guests WHERE display_id = $1", [displayId]);
        if (res.rows.length > 0) {
            const g = res.rows[0];
            io.emit('guestCalled', { 
                displayId, type: g.type, name: g.name, 
                adults: g.adults, children: g.children, infants: g.infants 
            });
        }
    });

    socket.on('markAbsent', ({ displayId }) => {
        updateGuestStatus(displayId, { absent: true });
        // 10分後の自動削除ロジックはサーバー負荷軽減のため一旦省略、またはDBのcronでやるのが理想
        // ここでは簡易的にJSタイマーを使用
        setTimeout(async () => {
            const check = await pool.query("SELECT absent FROM guests WHERE display_id = $1", [displayId]);
            if (check.rows.length > 0 && check.rows[0].absent) {
                updateGuestStatus(displayId, { status: 'delete' });
            }
        }, 10 * 60 * 1000);
    });

    socket.on('cancelAbsent', ({ displayId }) => {
        updateGuestStatus(displayId, { absent: false });
    });

    socket.on('updateStatus', ({ displayId, status }) => {
        updateGuestStatus(displayId, { status });
    });

    // 受付停止・再開
    socket.on('setAcceptance', (data) => {
        isAccepting = data.status;
        io.emit('statusChange', { isAccepting });
        if (!isAccepting && data.duration > 0) {
            setTimeout(() => {
                isAccepting = true;
                io.emit('statusChange', { isAccepting });
            }, data.duration * 60000);
        }
    });

    socket.on('resetStats', () => {
        // DB版では物理削除しないので、この機能は「表示上のリセット」または「何もせずログ出力」にする
        console.log('管理者による統計リセット要求（DB版のためデータは保持されます）');
        // 必要なら今日のデータをすべて 'delete' ステータスにする処理などを記述
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 松乃木飯店 DB版システム起動: Port ${PORT}`);
});