<?php
// 松乃木飯店 順番待ち発券システム (cloudprnt.php)
$dir = dirname(__FILE__) . '/';
$jobFile     = $dir . 'print_job.bin';
$logFile     = $dir . 'log.txt';
$counterFile = $dir . 'counter.txt';   // ★ 追加: 受付番号カウンター

function writeLog($msg) {
    global $logFile;
    // ログが大きくなりすぎないよう、1MBを超えたらリセットします
    if (file_exists($logFile) && filesize($logFile) > 1000000) { unlink($logFile); }
    file_put_contents($logFile, date('[Y-m-d H:i:s] ') . $msg . "\n", FILE_APPEND);
}

// ★ 追加: 次の受付番号を取得してカウントアップする関数
function getNextTicketNumber() {
    global $counterFile;
    $current = 100; // 初回は W-101 から始める
    if (file_exists($counterFile)) {
        $val = (int)file_get_contents($counterFile);
        if ($val >= 100) $current = $val;
    }
    $next = $current + 1;
    // 999を超えたら101にリセット（必要に応じて変更可）
    if ($next > 999) $next = 101;
    file_put_contents($counterFile, $next);
    return $next;
}

$method = $_SERVER['REQUEST_METHOD'];
$hasJob = (file_exists($jobFile) && filesize($jobFile) > 0);

// 1. 印刷予約
if ($method === 'GET' && isset($_GET['action']) && $_GET['action'] == 'queue') {
    $ticketNum = getNextTicketNumber();                    // ★ 変更: 番号を動的取得
    $ticketStr = 'W-' . $ticketNum;                       // ★ 変更: 例) W-101, W-102...
    $data = "\x1b\x40" . // 初期化
            mb_convert_encoding("      松乃木飯店\n--------------------------\n受付番号：\n", "SJIS-win", "UTF-8") .
            "\x1b\x69\x01\x01" . mb_convert_encoding($ticketStr . "\n", "SJIS-win", "UTF-8") . "\x1b\x69\x00\x00" . // ★ 変更: 動的番号
            mb_convert_encoding("日時：" . date("Y-m-d H:i:s") . "\n--------------------------\nご来店ありがとうございます\n", "SJIS-win", "UTF-8") .
            "\x1b\x64\x02"; // カット
    file_put_contents($jobFile, $data);
    writeLog("★Button: Job created. Ticket=" . $ticketStr);  // ★ 変更: 番号をログに記録
    echo "OK";
    exit;
}

// 2. プリンターからの「仕事ある？」の確認 (POST)
if ($method === 'POST') {
    // 調査のため、プリンターが来るたびにログを残します（不要になったら消せます）
    // writeLog("Printer: Polling check (JobReady: " . ($hasJob ? "YES" : "NO") . ")");

    header('Content-Type: application/json');
    echo json_encode([
        "jobReady"   => $hasJob,
        "mediaTypes" => ["application/vnd.star.starprnt"]
    ]);
    exit;
}

// 3. データ送信 (GET)
if ($method === 'GET') {
    if ($hasJob) {
        $content = file_get_contents($jobFile);
        writeLog("Printer: Downloading data...");
        header('Content-Type: application/vnd.star.starprnt');
        header('Content-Length: ' . strlen($content));
        echo $content;
    } else {
        http_response_code(204);
    }
    exit;
}

// 4. 完了報告 (DELETE)
if ($method === 'DELETE') {
    if (file_exists($jobFile)) {
        unlink($jobFile);
        file_put_contents($jobFile, "");
    }
    writeLog("Printer: Print complete.");
    http_response_code(200);
    exit;
}
?>