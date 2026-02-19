const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_FILE = path.join(__dirname, 'queue-data.json');
let queue = [];
let nextNumber = 1;
let isAccepting = true;
let stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
let lastResetDate = null;

// 日本時間の今日の日付取得 [cite: 43]
function getToday() {
    return new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const today = getToday();
        if (data.lastResetDate !== today) {
            resetAll(today); // 日付が変わっていたらリセット [cite: 45, 57]
        } else {
            queue = data.queue || [];
            nextNumber = data.nextNumber || 1;
            stats = data.stats || stats;
            lastResetDate = today;
        }
    } else { resetAll(getToday()); }
}

function resetAll(today) {
    queue = []; nextNumber = 1;
    stats = { totalToday: 0, completedToday: 0, averageWaitTime: 0 };
    lastResetDate = today;
    saveData();
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ queue, nextNumber, isAccepting, stats, lastResetDate }, null, 2));
}

io.on('connection', (socket) => {
    socket.emit('init', { isAccepting, queue, stats });

    socket.on('register', (data) => {
        const prefix = data.type === 'shop' ? 'S' : 'W';
        const displayId = `${prefix}-${nextNumber++}`;
        const newGuest = { 
            displayId, ...data, status: 'waiting', 
            timestamp: Date.now(), time: new Date().toLocaleTimeString('ja-JP') 
        };
        queue.push(newGuest);
        stats.totalToday++;
        saveData();
        io.emit('update', { queue, stats });
        socket.emit('registered', newGuest);
    });

    socket.on('callGuest', ({ displayId }) => {
        const guest = queue.find(g => g.displayId === displayId);
        if (guest) {
            guest.called = true;
            saveData();
            io.emit('update', { queue, stats });
            io.emit('guestCalled', { displayId, name: guest.name, lineUserId: guest.lineUserId }); // LINE連携用 
        }
    });

    socket.on('updateStatus', ({ displayId, status }) => {
        if (status === 'completed') {
            const guest = queue.find(g => g.displayId === displayId);
            if (guest) {
                stats.completedToday++;
                const wait = (Date.now() - guest.timestamp) / 60000;
                stats.averageWaitTime = Math.round((stats.averageWaitTime * (stats.completedToday - 1) + wait) / stats.completedToday);
            }
            queue = queue.filter(g => g.displayId !== displayId);
            saveData();
            io.emit('update', { queue, stats });
        }
    });
});

loadData();
app.use(express.static(path.join(__dirname, 'public')));
server.listen(3000, '0.0.0.0', () => console.log('松乃木飯店システム起動中'));