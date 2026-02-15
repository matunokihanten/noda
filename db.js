// webapp/db.js
const { Pool } = require('pg');
require('dotenv').config();

// データベース接続設定
// 環境変数 DATABASE_URL があればそれを使い、なければローカルの設定を使う
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// テーブル初期化（なければ作成）
const initDB = async () => {
    const client = await pool.connect();
    try {
        console.log('🔌 データベースに接続中...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS guests (
                id SERIAL PRIMARY KEY,
                display_id VARCHAR(20) NOT NULL,
                type VARCHAR(10) NOT NULL,
                name VARCHAR(100),
                adults INTEGER DEFAULT 0,
                children INTEGER DEFAULT 0,
                infants INTEGER DEFAULT 0,
                pref VARCHAR(20),
                status VARCHAR(20) DEFAULT 'waiting',
                arrived BOOLEAN DEFAULT false,
                called BOOLEAN DEFAULT false,
                absent BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ データベーステーブルの準備完了');
    } catch (err) {
        console.error('❌ データベース初期化エラー:', err);
    } finally {
        client.release();
    }
};

initDB();

module.exports = pool;