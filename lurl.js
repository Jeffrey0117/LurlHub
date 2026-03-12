/**
 * ============================================================================
 * LurlHub - CloudPipe 子專案
 * ============================================================================
 *
 * 【架構說明】
 *
 *   CloudPipe (主平台)
 *   ├── /_admin              ← CloudPipe 主控台（public/admin*.html）
 *   │   └── /_admin/lurlhub  ← LurlHub 概覽（只是快捷入口，不放詳細功能）
 *   │
 *   └── /lurl                ← LurlHub 子專案（本檔案處理所有 /lurl/* 路由）
 *       ├── /lurl/admin      ← LurlHub 管理後台（所有管理功能都在這）
 *       ├── /lurl/browse     ← 公開瀏覽頁
 *       ├── /lurl/login      ← 登入頁
 *       └── /lurl/api/*      ← API 端點
 *
 * 【重要】
 *   - LurlHub 的所有功能都應該在 /lurl/* 底下
 *   - 使用者管理、記錄管理等都應該在 /lurl/admin 用 tab 切換
 *   - /_admin/lurlhub 只是「概覽」，不應放詳細管理功能
 *   - 詳見 docs/architecture.md
 *
 * ============================================================================
 *
 * 【路由總覽】
 *
 * 頁面：
 *   GET  /lurl/admin   - 管理後台（含：記錄、使用者、版本、維護）
 *   GET  /lurl/browse  - 公開瀏覽頁
 *   GET  /lurl/login   - 登入頁
 *   GET  /lurl/health  - 健康檢查
 *
 * API：
 *   POST /lurl/api/rpc         - RPC 統一入口（cb, rc, vr, bl, rd）
 *   POST /lurl/api/capture     - 接收影片/圖片資料
 *   POST /lurl/api/upload      - 分塊上傳
 *   GET  /lurl/api/records     - 記錄列表
 *   GET  /lurl/api/stats       - 統計資料
 *   GET  /lurl/api/users       - 使用者列表
 *   PATCH /lurl/api/users/:id  - 更新使用者
 *
 * 靜態檔案：
 *   GET  /lurl/files/videos/:name      - 影片
 *   GET  /lurl/files/images/:name      - 圖片
 *   GET  /lurl/files/thumbnails/:name  - 縮圖
 *
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const sharp = require('sharp');
const zlib = require('zlib');

// 維護系統
const RecordChecker = require('./_lurl-checker');
const {
  MaintenanceScheduler,
  DownloadStrategy,
  ThumbnailStrategy,
  PreviewStrategy,
  HLSStrategy,
  CleanupStrategy,
} = require('./maintenance');

// Gzip 壓縮輔助函數
function sendCompressed(req, res, statusCode, headers, body) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const contentType = headers['Content-Type'] || '';

  // 只壓縮文字類型（HTML, JSON, JS, CSS）
  const shouldCompress = acceptEncoding.includes('gzip') &&
    (contentType.includes('text/') ||
     contentType.includes('application/json') ||
     contentType.includes('application/javascript'));

  if (shouldCompress && body.length > 1024) { // 大於 1KB 才壓縮
    zlib.gzip(body, (err, compressed) => {
      if (err) {
        // 壓縮失敗，發送原始內容
        res.writeHead(statusCode, headers);
        res.end(body);
      } else {
        res.writeHead(statusCode, {
          ...headers,
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length
        });
        res.end(compressed);
      }
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(body);
  }
}

// 備援下載模組 (Puppeteer - 在頁面 context 下載)
let lurlRetry = null;
try {
  lurlRetry = require('./_lurl-retry');
  console.log('[lurl] ✅ Puppeteer 備援模組已載入');
} catch (e) {
  console.log('[lurl] ⚠️ Puppeteer 備援模組未載入:', e.message);
}

// Workr 外部 Worker 平台
let workr = null;
try {
  workr = require('./_workr-client');
  console.log('[lurl] ✅ Workr client 已載入');
} catch (e) {
  console.log('[lurl] ⚠️ Workr client 未載入:', e.message);
}

// SQLite 資料庫
const lurlDb = require('./_lurl-db');
lurlDb.init();

// Pokkit 儲存引擎（檔案索引）
const PokkitStore = require('../pokkit/core');
const fileStore = new PokkitStore({
  dataDir: path.join(__dirname, 'data'),
  buckets: {
    videos: { mode: 'flat' },
    images: { mode: 'flat' },
    thumbnails: { mode: 'flat' },
    previews: { mode: 'flat' },
    hls: { mode: 'flat' },
  },
  dbName: 'pokkit.db',
});

// ==================== 安全配置 ====================
// 從環境變數讀取，請在 .env 檔案中設定
const ADMIN_PASSWORD = process.env.LURL_ADMIN_PASSWORD || 'change-me';
const CLIENT_TOKEN = process.env.LURL_CLIENT_TOKEN || 'change-me';
const SESSION_SECRET = process.env.LURL_SESSION_SECRET || 'change-me';

// 資料存放位置
const DATA_DIR = path.join(__dirname, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const QUOTAS_FILE = path.join(DATA_DIR, 'quotas.jsonl');
const REDEMPTIONS_FILE = path.join(DATA_DIR, 'redemptions.jsonl');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const HLS_DIR = path.join(DATA_DIR, 'hls');
const PREVIEWS_DIR = path.join(DATA_DIR, 'previews');

// HLS 轉檔佇列
const hlsQueue = [];
let hlsProcessing = false;

// 修復服務設定
const FREE_QUOTA = 3;
// VIP 白名單（無限額度），用逗號分隔多個 visitorId
const VIP_WHITELIST = (process.env.LURL_VIP_WHITELIST || '').split(',').filter(Boolean);

// JWT 設定
const JWT_SECRET = process.env.LURL_JWT_SECRET || SESSION_SECRET;
const JWT_EXPIRES = 7 * 24 * 60 * 60 * 1000; // 7 天
const REFRESH_EXPIRES = 30 * 24 * 60 * 60 * 1000; // 30 天

// ==================== 維護系統初始化 ====================
// 建立 RecordChecker 實例
const recordChecker = new RecordChecker(DATA_DIR, HLS_DIR, PREVIEWS_DIR);

// 延遲初始化維護調度器（需要在 readAllRecords/updateRecord 定義後）
let maintenanceScheduler = null;

function initMaintenanceScheduler() {
  if (maintenanceScheduler) return maintenanceScheduler;

  maintenanceScheduler = new MaintenanceScheduler({
    dataDir: DATA_DIR,
    readAllRecords: () => lurlDb.getAllRecords(),
    updateRecord: (id, updates) => lurlDb.updateRecord(id, updates),
    checker: recordChecker,
    context: {
      workr,
      lurlRetry,
      generateVideoThumbnail,
      downloadFile,
      broadcastLog,
      fileStore,
    },
    config: {
      autoRun: false, // 預設不自動執行
    },
  });

  // 註冊策略
  maintenanceScheduler.register(new DownloadStrategy());
  maintenanceScheduler.register(new ThumbnailStrategy());
  maintenanceScheduler.register(new PreviewStrategy());
  maintenanceScheduler.register(new HLSStrategy({ hlsDir: HLS_DIR }));
  maintenanceScheduler.register(new CleanupStrategy());

  // 載入歷史記錄
  maintenanceScheduler.loadHistory();

  console.log('[lurl] ✅ 維護系統已初始化');

  return maintenanceScheduler;
}

// ==================== 會員認證工具 ====================

// 密碼雜湊（使用 PBKDF2）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === verify;
}

// JWT Token
function generateJWT(payload, expiresIn = JWT_EXPIRES) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Date.now();
  const exp = now + expiresIn;

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({ ...payload, iat: now, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}

function verifyJWT(token) {
  try {
    const [headerB64, payloadB64, signature] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (signature !== expectedSig) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

// 從 Cookie 或 Header 取得 JWT
function getMemberToken(req) {
  // 先從 Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 再從 Cookie
  const cookies = parseCookies(req.headers.cookie || '');
  return cookies.lurl_member_token;
}

// 驗證會員身份
function getMemberFromRequest(req) {
  const token = getMemberToken(req);
  if (!token) return null;

  const payload = verifyJWT(token);
  if (!payload || !payload.userId) return null;

  const user = lurlDb.getUser(payload.userId);
  if (!user) return null;

  return user;
}

// SSE 即時日誌客戶端
const sseClients = new Set();

function broadcastLog(log) {
  const data = `data: ${JSON.stringify(log)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(data);
    } catch (e) {
      sseClients.delete(client);
    }
  });
}

// ==================== HLS 轉檔系統 ====================

// 確保 HLS 和 Previews 目錄存在
if (!fs.existsSync(HLS_DIR)) {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}
if (!fs.existsSync(PREVIEWS_DIR)) {
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

// HLS 畫質設定
const HLS_QUALITIES = [
  { name: '1080p', height: 1080, bitrate: '5000k', audioBitrate: '192k', crf: 22 },
  { name: '720p', height: 720, bitrate: '2500k', audioBitrate: '128k', crf: 23 },
  { name: '480p', height: 480, bitrate: '1000k', audioBitrate: '96k', crf: 24 }
];

// 取得影片資訊
function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', data => stdout += data);
    ffprobe.stderr.on('data', data => stderr += data);

    ffprobe.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        resolve({
          width: videoStream?.width || 1920,
          height: videoStream?.height || 1080,
          duration: parseFloat(info.format?.duration || 0)
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// 計算預覽片段長度
function getPreviewDuration(videoDuration) {
  if (videoDuration < 10) return 0;      // 不產生預覽（短影片）
  if (videoDuration < 30) return 3;      // 短影片 3 秒
  return 6;                               // 標準 6 秒
}

// 產生預覽片段 (240p, 3-6秒, ~200KB)
function generatePreviewClip(inputPath, recordId, videoDuration) {
  return new Promise((resolve, reject) => {
    const previewDuration = getPreviewDuration(videoDuration);

    if (previewDuration === 0) {
      console.log(`[Preview] 跳過 ${recordId}：影片太短 (${videoDuration.toFixed(1)}s)`);
      resolve({ skipped: true, reason: 'short_video' });
      return;
    }

    const outputPath = path.join(PREVIEWS_DIR, `${recordId}.mp4`);

    // 如果已存在則跳過
    if (fs.existsSync(outputPath)) {
      console.log(`[Preview] 跳過 ${recordId}：預覽已存在`);
      resolve({ skipped: true, reason: 'exists' });
      return;
    }

    const args = [
      '-i', inputPath,
      '-t', String(previewDuration),       // 前 N 秒
      '-vf', 'scale=426:240',              // 240p
      '-c:v', 'libx264',
      '-profile:v', 'baseline',            // 最大相容性
      '-preset', 'fast',
      '-crf', '28',                         // 較高壓縮
      '-c:a', 'aac',
      '-b:a', '64k',                        // 低碼率音訊
      '-movflags', '+faststart',           // 快速啟動
      '-y',
      outputPath
    ];

    console.log(`[Preview] 開始產生 ${recordId} (${previewDuration}s)...`);
    const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

    let stderr = '';
    ffmpeg.stderr.on('data', data => stderr += data.toString());

    ffmpeg.on('close', code => {
      if (code !== 0) {
        console.error(`[Preview] ${recordId} 失敗:`, stderr.slice(-300));
        reject(new Error(`Preview generation failed: ${stderr.slice(-300)}`));
        return;
      }

      const stats = fs.statSync(outputPath);
      const sizeKB = Math.round(stats.size / 1024);
      console.log(`[Preview] ${recordId} 完成 (${sizeKB}KB)`);
      resolve({ success: true, path: `previews/${recordId}.mp4`, size: stats.size });
    });
  });
}

// 單一畫質 HLS 轉檔
function transcodeToHLS(inputPath, outputDir, quality, videoInfo) {
  return new Promise((resolve, reject) => {
    const qualityDir = path.join(outputDir, quality.name);
    if (!fs.existsSync(qualityDir)) {
      fs.mkdirSync(qualityDir, { recursive: true });
    }

    // 如果原始影片高度小於目標，跳過此畫質
    if (videoInfo.height < quality.height && quality.height > 480) {
      console.log(`[HLS] 跳過 ${quality.name}（原始 ${videoInfo.height}p < 目標 ${quality.height}p）`);
      resolve({ skipped: true, quality: quality.name });
      return;
    }

    const playlistPath = path.join(qualityDir, 'playlist.m3u8');
    const segmentPattern = path.join(qualityDir, 'segment%03d.ts');

    // 計算目標寬度（保持比例）
    const targetHeight = Math.min(quality.height, videoInfo.height);
    const targetWidth = Math.round(videoInfo.width * (targetHeight / videoInfo.height) / 2) * 2;

    const args = [
      '-i', inputPath,
      '-vf', `scale=${targetWidth}:${targetHeight}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', String(quality.crf),
      '-c:a', 'aac',
      '-b:a', quality.audioBitrate,
      '-hls_time', '2',
      '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      '-hls_playlist_type', 'vod',
      '-y',
      playlistPath
    ];

    console.log(`[HLS] 開始轉檔 ${quality.name}...`);
    const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

    let stderr = '';
    ffmpeg.stderr.on('data', data => {
      stderr += data.toString();
      // 解析進度
      const timeMatch = stderr.match(/time=(\d+:\d+:\d+\.\d+)/g);
      if (timeMatch) {
        const lastTime = timeMatch[timeMatch.length - 1];
        broadcastLog({ type: 'hls_progress', quality: quality.name, time: lastTime });
      }
    });

    ffmpeg.on('close', code => {
      if (code !== 0) {
        console.error(`[HLS] ${quality.name} 轉檔失敗:`, stderr.slice(-500));
        reject(new Error(`FFmpeg failed for ${quality.name}`));
        return;
      }
      console.log(`[HLS] ${quality.name} 轉檔完成`);
      resolve({ skipped: false, quality: quality.name, playlist: playlistPath });
    });
  });
}

// 產生 master.m3u8
function generateMasterPlaylist(outputDir, qualities, videoInfo) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];

  for (const q of qualities) {
    // 跳過比原始畫質高的（除了 480p 保底）
    if (videoInfo.height < q.height && q.height > 480) continue;

    const targetHeight = Math.min(q.height, videoInfo.height);
    const targetWidth = Math.round(videoInfo.width * (targetHeight / videoInfo.height) / 2) * 2;
    const bandwidth = parseInt(q.bitrate) * 1000;

    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${targetWidth}x${targetHeight},NAME="${q.name}"`);
    lines.push(`${q.name}/playlist.m3u8`);
    lines.push('');
  }

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, lines.join('\n'));
  return masterPath;
}

// 完整 HLS 轉檔流程（含預覽片段產生）
async function processHLSTranscode(recordId) {
  const records = readAllRecords();
  const record = records.find(r => r.id === recordId);

  if (!record || record.type !== 'video') {
    console.log(`[HLS] 跳過 ${recordId}：非影片或不存在`);
    return { success: false, error: 'Not a video' };
  }

  const inputPath = path.join(DATA_DIR, record.backupPath);
  if (!fs.existsSync(inputPath)) {
    console.log(`[HLS] 跳過 ${recordId}：原始檔案不存在`);
    return { success: false, error: 'Source file not found' };
  }

  const outputDir = path.join(HLS_DIR, recordId);

  // 檢查是否已轉檔
  if (fs.existsSync(path.join(outputDir, 'master.m3u8'))) {
    console.log(`[HLS] 跳過 ${recordId}：已存在 HLS 版本`);
    return { success: true, skipped: true };
  }

  try {
    console.log(`[HLS] 開始處理 ${recordId}...`);
    broadcastLog({ type: 'hls_start', recordId, title: record.title });

    // 取得影片資訊
    const videoInfo = await getVideoInfo(inputPath);
    console.log(`[HLS] 影片資訊: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s`);

    // 儲存影片長度到記錄
    updateRecord(recordId, { duration: videoInfo.duration });

    // 短影片處理（<10秒）：保留 MP4，不轉 HLS
    if (videoInfo.duration < 10) {
      console.log(`[HLS] 短影片 ${recordId}：保留 MP4，不轉 HLS (${videoInfo.duration.toFixed(1)}s)`);
      updateRecord(recordId, {
        isShortVideo: true,
        hlsReady: false,
        previewReady: false
      });
      broadcastLog({ type: 'hls_complete', recordId, title: record.title, isShortVideo: true });
      return { success: true, isShortVideo: true };
    }

    // 1. 先產生預覽片段（快速完成）
    try {
      const previewResult = await generatePreviewClip(inputPath, recordId, videoInfo.duration);
      if (previewResult.success) {
        updateRecord(recordId, {
          previewPath: previewResult.path,
          previewReady: true
        });
      }
    } catch (e) {
      console.error(`[Preview] ${recordId} 產生失敗:`, e.message);
      // 預覽失敗不影響 HLS 轉檔
    }

    // 2. 建立 HLS 輸出目錄
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 3. 依序轉檔各畫質（避免同時佔用太多資源）
    const results = [];
    for (const quality of HLS_QUALITIES) {
      try {
        const result = await transcodeToHLS(inputPath, outputDir, quality, videoInfo);
        results.push(result);
      } catch (e) {
        console.error(`[HLS] ${quality.name} 失敗:`, e.message);
        results.push({ skipped: false, quality: quality.name, error: e.message });
      }
    }

    // 4. 產生 master playlist
    generateMasterPlaylist(outputDir, HLS_QUALITIES, videoInfo);

    // 5. 更新記錄
    updateRecord(recordId, {
      hlsReady: true,
      hlsPath: `hls/${recordId}/master.m3u8`,
      isShortVideo: false
    });

    // 6. 刪除原始檔案（HLS 轉檔成功後不再需要，預覽已產生）
    if (fs.existsSync(inputPath)) {
      try {
        fs.unlinkSync(inputPath);
        console.log(`[HLS] 已刪除原始檔: ${path.basename(inputPath)}`);
      } catch (e) {
        console.error(`[HLS] 刪除原始檔失敗:`, e.message);
      }
    }

    console.log(`[HLS] ${recordId} 處理完成`);
    broadcastLog({ type: 'hls_complete', recordId, title: record.title });

    return { success: true, results };
  } catch (error) {
    console.error(`[HLS] ${recordId} 處理失敗:`, error);
    broadcastLog({ type: 'hls_error', recordId, error: error.message });
    return { success: false, error: error.message };
  }
}

// HLS 轉檔佇列處理
async function processHLSQueue() {
  if (hlsProcessing || hlsQueue.length === 0) return;

  hlsProcessing = true;

  while (hlsQueue.length > 0) {
    const recordId = hlsQueue.shift();
    try {
      await processHLSTranscode(recordId);
    } catch (e) {
      console.error(`[HLS] 佇列處理錯誤:`, e);
    }
  }

  hlsProcessing = false;
}

// 加入 HLS 轉檔佇列（使用 workr 外部平台）
async function queueHLSTranscode(recordId) {
  // 如果 workr 可用，使用外部 worker
  if (workr) {
    try {
      const records = readAllRecords();
      const record = records.find(r => r.id === recordId);
      if (!record || record.type !== 'video') {
        console.log(`[HLS] 跳過 ${recordId}：非影片或不存在`);
        return;
      }

      const inputPath = path.join(DATA_DIR, record.backupPath);
      if (!fs.existsSync(inputPath)) {
        console.log(`[HLS] 跳過 ${recordId}：原始檔案不存在`);
        return;
      }

      const outputDir = path.join(HLS_DIR, recordId);

      // 檢查是否已轉檔
      if (fs.existsSync(path.join(outputDir, 'master.m3u8'))) {
        console.log(`[HLS] 跳過 ${recordId}：已存在 HLS 版本`);
        return;
      }

      const { jobId } = await workr.submitJob('hls', {
        inputPath,
        outputDir
      }, {
        callback: `http://localhost:8787/lurl/api/callback/hls/${recordId}`
      });

      console.log(`[HLS] 已提交到 workr: ${recordId} -> ${jobId}`);
      return;
    } catch (e) {
      console.error(`[HLS] workr 提交失敗，fallback 到內部佇列:`, e.message);
    }
  }

  // Fallback: 使用內部佇列
  if (!hlsQueue.includes(recordId)) {
    hlsQueue.push(recordId);
    console.log(`[HLS] 加入內部佇列: ${recordId}，目前 ${hlsQueue.length} 個待處理`);
    processHLSQueue();
  }
}

// 取得 HLS 狀態
function getHLSStatus() {
  return {
    processing: hlsProcessing,
    queue: hlsQueue.length,
    currentItem: hlsProcessing && hlsQueue.length > 0 ? hlsQueue[0] : null
  };
}

// ==================== 安全函數 ====================

function generateSessionToken(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password).digest('hex').substring(0, 32);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length) {
      cookies[name] = rest.join('=');
    }
  });
  return cookies;
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.lurl_session;
  const validToken = generateSessionToken(ADMIN_PASSWORD);
  return sessionToken === validToken;
}

function isClientAuthenticated(req) {
  const token = req.headers['x-client-token'];
  return token === CLIENT_TOKEN;
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl - 登入</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: #1a1a2e; padding: 40px; border-radius: 12px; width: 100%; max-width: 360px; }
    .login-box h1 { text-align: center; margin-bottom: 30px; font-size: 1.5em; }
    .login-box input { width: 100%; padding: 12px 16px; border: none; border-radius: 8px; background: #0f0f0f; color: white; font-size: 1em; margin-bottom: 15px; }
    .login-box input:focus { outline: 2px solid #3b82f6; }
    .login-box button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: #3b82f6; color: white; font-size: 1em; cursor: pointer; }
    .login-box button:hover { background: #2563eb; }
    .error { color: #f87171; text-align: center; margin-bottom: 15px; font-size: 0.9em; }
    .logo { text-align: center; margin-bottom: 20px; }
    .logo img { height: 60px; }
    .dev-notice { background: linear-gradient(135deg, #1e3a5f, #1a2744); border: 1px solid #3b82f6; border-radius: 8px; padding: 16px; margin-top: 20px; font-size: 0.85em; line-height: 1.6; }
    .dev-notice-title { color: #60a5fa; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .dev-notice-text { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo"><img src="/lurl/files/LOGO.png" alt="Lurl"></div>
    <h1>登入</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/lurl/login">
      <input type="password" name="password" placeholder="請輸入密碼" autofocus required>
      <input type="hidden" name="redirect" value="">
      <button type="submit">登入</button>
    </form>
    <div class="dev-notice">
      <div class="dev-notice-title">🚧 功能開發中</div>
      <div class="dev-notice-text">
        會員系統正在規劃中，目前僅限管理員登入。<br>
        一般用戶請使用免費的救援功能，敬請期待後續更新！
      </div>
    </div>
  </div>
  <script>
    document.querySelector('input[name="redirect"]').value = new URLSearchParams(window.location.search).get('redirect') || '/lurl/browse';
  </script>
</body>
</html>`;
}

// ==================== 工具函數 ====================

function ensureDirs() {
  [DATA_DIR, VIDEOS_DIR, IMAGES_DIR, THUMBNAILS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    // 移除所有 emoji（更全面的範圍）
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu, '')
    // 移除其他特殊符號
    .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf._-]/g, '')
    .replace(/_+/g, '_') // 多個底線合併
    .replace(/^_|_$/g, '') // 移除開頭結尾底線
    .substring(0, 200) || `untitled_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

async function downloadFile(url, destPath, pageUrl = '', cookies = '') {
  // 根據 CDN 來源決定 Referer
  // lurl CDN 需要 https://lurl.cc/ 當 referer
  // myppt CDN 需要 https://myppt.cc/ 當 referer
  let baseReferer = 'https://lurl.cc/';
  if (url.includes('myppt.cc')) {
    baseReferer = 'https://myppt.cc/';
  }

  // 斷點續傳：使用 .tmp 檔案
  const tmpPath = destPath + '.tmp';
  let startByte = 0;

  // 檢查是否有未完成的下載
  if (fs.existsSync(tmpPath)) {
    const stats = fs.statSync(tmpPath);
    startByte = stats.size;
    console.log(`[lurl] 發現未完成下載，從 ${startByte} bytes 繼續`);
  }

  // 策略清單：有 cookie 優先試 cookie
  const strategies = [];

  // 策略 1：用前端傳來的 cookies（最可能成功）
  if (cookies) {
    strategies.push({ referer: baseReferer, cookie: cookies, name: 'cookie+referer' });
  }

  // 策略 2：只用 referer（fallback）
  strategies.push({ referer: baseReferer, cookie: '', name: 'referer-only' });
  if (pageUrl) {
    strategies.push({ referer: pageUrl, cookie: '', name: 'pageUrl-referer' });
  }

  for (const strategy of strategies) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-CH-UA': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"Android"',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-site',
        'Range': `bytes=${startByte}-`,
      };

      if (strategy.referer) {
        headers['Referer'] = strategy.referer;
      }
      if (strategy.cookie) {
        headers['Cookie'] = strategy.cookie;
      }

      console.log(`[lurl] 嘗試下載 (策略: ${strategy.name}, 起始: ${startByte} bytes)`);
      const response = await fetch(url, { headers });

      // 206 = 部分內容（斷點續傳成功），200 = 完整檔案
      if (!response.ok && response.status !== 206) {
        console.log(`[lurl] 策略失敗: HTTP ${response.status}`);
        continue;
      }

      // 如果伺服器不支援 Range（返回 200），重新開始
      if (response.status === 200 && startByte > 0) {
        console.log(`[lurl] 伺服器不支援斷點續傳，重新下載`);
        startByte = 0;
      }

      // 寫入 tmp 檔案（append 模式用於續傳）
      const fileStream = fs.createWriteStream(tmpPath, {
        flags: startByte > 0 && response.status === 206 ? 'a' : 'w'
      });
      await pipeline(response.body, fileStream);

      // 下載完成，重命名為正式檔案
      fs.renameSync(tmpPath, destPath);
      console.log(`[lurl] 下載成功 (策略: ${strategy.name})`);
      return true;
    } catch (err) {
      console.log(`[lurl] 策略錯誤: ${err.message}`);
    }
  }

  console.error(`[lurl] 下載失敗: ${url} (所有策略都失敗)`);
  return false;
}

// 用 ffmpeg 產生影片縮圖
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function generateVideoThumbnail(videoPath, thumbnailPath) {
  try {
    // 確保縮圖目錄存在
    const dir = path.dirname(thumbnailPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // ffmpeg 擷取第 1 秒的畫面，輸出 PNG（後續用 sharp 轉 WebP）
    const tempPath = thumbnailPath.replace(/\.\w+$/, '_temp.png');
    const cmd = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" -y "${tempPath}"`;
    await execAsync(cmd, { timeout: 30000, windowsHide: true });

    if (fs.existsSync(tempPath)) {
      // 用 sharp 轉成 WebP 並壓縮
      await sharp(tempPath)
        .webp({ quality: 75 })
        .toFile(thumbnailPath);

      // 刪除暫存檔
      fs.unlinkSync(tempPath);
      console.log(`[lurl] ✅ 影片縮圖產生成功 (WebP): ${thumbnailPath}`);
      return true;
    }
    return false;
  } catch (err) {
    console.log(`[lurl] ⚠️ 縮圖產生失敗: ${err.message}`);
    return false;
  }
}

// 圖片處理：生成 WebP 縮圖
async function processImage(sourcePath, id) {
  try {
    const thumbDir = THUMBNAILS_DIR;
    if (!fs.existsSync(thumbDir)) {
      fs.mkdirSync(thumbDir, { recursive: true });
    }

    const thumbFilename = `${id}.webp`;
    const thumbPath = path.join(thumbDir, thumbFilename);

    // 優先使用 workr
    if (workr) {
      try {
        const result = await workr.submitAndWait('webp', {
          inputPath: sourcePath,
          outputPath: thumbPath,
          width: 320,
          quality: 75
        });

        if (result.success) {
          console.log(`[lurl] ✅ 圖片縮圖產生成功 (workr): ${thumbFilename}`);
          return `thumbnails/${thumbFilename}`;
        } else {
          console.log(`[lurl] workr WebP 失敗，fallback 到本地: ${result.error}`);
        }
      } catch (e) {
        console.log(`[lurl] workr 不可用，使用本地 sharp: ${e.message}`);
      }
    }

    // Fallback: 使用本地 sharp
    await sharp(sourcePath)
      .resize(320, null, { withoutEnlargement: true })
      .webp({ quality: 75 })
      .toFile(thumbPath);

    console.log(`[lurl] ✅ 圖片縮圖產生成功: ${thumbFilename}`);
    return `thumbnails/${thumbFilename}`;
  } catch (err) {
    console.log(`[lurl] ⚠️ 圖片處理失敗: ${err.message}`);
    return null;
  }
}

function appendRecord(record) {
  lurlDb.insertRecord(record);

  // 廣播到 SSE 客戶端
  broadcastLog({
    time: record.capturedAt,
    type: record.backupStatus === 'completed' ? 'upload' : (record.backupStatus === 'failed' ? 'error' : 'view'),
    message: `${record.type === 'video' ? '影片' : '圖片'}: ${record.title || record.pageUrl}`
  });
}

function updateRecordFileUrl(id, newFileUrl) {
  updateRecord(id, { fileUrl: newFileUrl });
}

function updateRecordThumbnail(id, thumbnailPath) {
  updateRecord(id, { thumbnailPath });
  console.log(`[lurl] 記錄已更新縮圖: ${id}`);
}

function updateRecordBackupPath(id, backupPath) {
  updateRecord(id, { backupPath });
  console.log(`[lurl] 記錄已更新備份路徑: ${id} -> ${backupPath}`);
}

// 通用記錄更新函數
function updateRecord(id, updates) {
  lurlDb.updateRecord(id, updates);
  console.log(`[lurl] 記錄已更新: ${id}`, Object.keys(updates));
}

function readAllRecords() {
  return lurlDb.getAllRecords();
}

// ==================== 額度管理 ====================

function readAllQuotas() {
  return lurlDb.getAllQuotas();
}

function isVipVisitor(visitorId) {
  return VIP_WHITELIST.includes(visitorId);
}

function getVisitorQuota(visitorId) {
  let quota = lurlDb.getQuota(visitorId);
  if (!quota) {
    quota = {
      visitorId,
      usedCount: 0,
      freeQuota: FREE_QUOTA,
      bonusQuota: 0,
      status: 'active',
      note: '',
      createdAt: new Date().toISOString(),
      history: []
    };
  }
  if (isVipVisitor(visitorId)) {
    quota.status = 'vip';
  }
  return quota;
}

function useQuota(visitorId, pageUrl, urlId, backupUrl) {
  const historyEntry = {
    pageUrl,
    urlId,
    backupUrl,
    usedAt: new Date().toISOString()
  };

  let quota = lurlDb.getQuota(visitorId);
  if (!quota) {
    quota = {
      visitorId,
      usedCount: 1,
      freeQuota: FREE_QUOTA,
      bonusQuota: 0,
      status: 'active',
      note: '',
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      history: [historyEntry]
    };
  } else {
    quota.usedCount++;
    quota.lastUsed = new Date().toISOString();
    quota.history.push(historyEntry);
  }

  lurlDb.upsertQuota(quota);
  return getVisitorQuota(visitorId);
}

function updateQuota(visitorId, updates) {
  let quota = lurlDb.getQuota(visitorId);
  if (!quota) {
    quota = {
      visitorId,
      usedCount: 0,
      freeQuota: FREE_QUOTA,
      bonusQuota: 0,
      status: 'active',
      note: '',
      createdAt: new Date().toISOString(),
      history: [],
      ...updates
    };
  } else {
    quota = { ...quota, ...updates };
  }
  lurlDb.upsertQuota(quota);
  return getVisitorQuota(visitorId);
}

function deleteQuota(visitorId) {
  lurlDb.deleteQuota(visitorId);
}

// 檢查是否已修復過此 URL
function hasRecovered(visitorId, urlId) {
  const quota = getVisitorQuota(visitorId);
  return quota.history.find(h => h.urlId === urlId);
}

function getRemainingQuota(quota) {
  // VIP 或白名單用戶 = 無限額度 (用 -1 代表，因為 Infinity 在 JSON 會變 null)
  if (quota.status === 'vip' || isVipVisitor(quota.visitorId)) {
    return -1;
  }
  // 被封禁 = 0 額度
  if (quota.status === 'banned') {
    return 0;
  }
  return (quota.freeQuota + (quota.bonusQuota || 0)) - quota.usedCount;
}

// ==================== 序號兌換系統 ====================

function generateRedemptionCode() {
  // 格式: XXXX-XXXX-XXXX (12位英數字)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字元 I,O,0,1
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function readAllRedemptions() {
  ensureDirs();
  if (!fs.existsSync(REDEMPTIONS_FILE)) return [];
  const content = fs.readFileSync(REDEMPTIONS_FILE, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function writeAllRedemptions(redemptions) {
  fs.writeFileSync(REDEMPTIONS_FILE, redemptions.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function getRedemptionCode(code) {
  const redemptions = readAllRedemptions();
  return redemptions.find(r => r.code.toUpperCase() === code.toUpperCase());
}

function createRedemptionCodes(count, bonus, expiresAt = null, note = '') {
  const redemptions = readAllRedemptions();
  const newCodes = [];

  for (let i = 0; i < count; i++) {
    let code;
    do {
      code = generateRedemptionCode();
    } while (redemptions.find(r => r.code === code)); // 確保不重複

    const redemption = {
      code,
      bonus: parseInt(bonus) || 5,
      expiresAt: expiresAt || null,
      usedBy: null,
      usedAt: null,
      createdAt: new Date().toISOString(),
      note: note || ''
    };
    redemptions.push(redemption);
    newCodes.push(redemption);
  }

  writeAllRedemptions(redemptions);
  return newCodes;
}

function redeemCode(code, visitorId) {
  const redemptions = readAllRedemptions();
  const index = redemptions.findIndex(r => r.code.toUpperCase() === code.toUpperCase());

  if (index === -1) {
    return { ok: false, error: '無效的兌換碼' };
  }

  const redemption = redemptions[index];

  // 檢查是否已使用
  if (redemption.usedBy) {
    return { ok: false, error: '此兌換碼已被使用' };
  }

  // 檢查是否過期
  if (redemption.expiresAt && new Date(redemption.expiresAt) < new Date()) {
    return { ok: false, error: '此兌換碼已過期' };
  }

  // 套用額度
  const quota = getVisitorQuota(visitorId);
  const newBonus = (quota.bonusQuota || 0) + redemption.bonus;
  updateQuota(visitorId, { bonusQuota: newBonus });

  // 標記為已使用
  redemption.usedBy = visitorId;
  redemption.usedAt = new Date().toISOString();
  redemptions[index] = redemption;
  writeAllRedemptions(redemptions);

  return { ok: true, bonus: redemption.bonus, newTotal: newBonus };
}

function deleteRedemptionCode(code) {
  const redemptions = readAllRedemptions().filter(r => r.code.toUpperCase() !== code.toUpperCase());
  writeAllRedemptions(redemptions);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx));
  return Object.fromEntries(params);
}

// 從 URL 提取資源 ID（URL 最後一段，去掉 query string，轉小寫）
function extractUrlId(pageUrl) {
  return pageUrl.split('/').pop().split('?')[0].toLowerCase();
}

function corsHeaders(contentType = 'application/json') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Record-Id, X-Chunk-Index, X-Total-Chunks',
    'Content-Type': contentType
  };
}

// ==================== HTML 頁面 ====================

function adminPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: white; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 2em; color: #2196F3; }
    .stat-card p { color: #666; margin-top: 5px; }
    .records { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .record { display: flex; align-items: center; padding: 15px; border-bottom: 1px solid #eee; gap: 15px; }
    .record:hover { background: #f9f9f9; }
    .record-thumb { width: 80px; height: 60px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 24px; background: #f0f0f0; flex-shrink: 0; }
    .record-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .record-thumb.video { background: #e3f2fd; }
    .record-info { flex: 1; min-width: 0; }
    .record-title { font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .record-meta { font-size: 0.85em; color: #999; margin-top: 4px; }
    .record-actions { display: flex; gap: 10px; align-items: center; }
    .record-actions a { color: #2196F3; text-decoration: none; }
    .record-actions .delete-btn { color: #e53935; cursor: pointer; border: none; background: none; font-size: 0.9em; }
    .record-actions .delete-btn:hover { text-decoration: underline; }
    .empty { padding: 40px; text-align: center; color: #999; }
    /* Main Tabs */
    .main-tabs { display: flex; gap: 0; margin-bottom: 24px; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .main-tab { padding: 14px 24px; background: transparent; border: none; cursor: pointer; font-size: 0.95em; color: #666; display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    .main-tab:hover { background: #f5f5f5; color: #333; }
    .main-tab.active { background: #2196F3; color: white; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Record Filter Tabs */
    .filter-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .filter-tab { padding: 10px 20px; background: white; border: none; border-radius: 8px; cursor: pointer; }
    .filter-tab.active { background: #2196F3; color: white; }

    /* User Management */
    .user-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .user-stat { background: white; padding: 16px; border-radius: 8px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .user-stat .value { font-size: 1.8em; font-weight: bold; }
    .user-stat .value.green { color: #4caf50; }
    .user-stat .value.orange { color: #ff9800; }
    .user-stat .value.red { color: #f44336; }
    .user-stat .label { font-size: 0.85em; color: #666; margin-top: 4px; }
    .user-list { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .user-item { display: flex; align-items: center; padding: 14px 16px; border-bottom: 1px solid #eee; gap: 12px; cursor: pointer; transition: background 0.2s; }
    .user-item:hover { background: #f9f9f9; }
    .user-item:last-child { border-bottom: none; }
    .user-status-icon { font-size: 1.3em; width: 32px; text-align: center; }
    .user-info { flex: 1; min-width: 0; }
    .user-id { font-family: monospace; font-size: 0.85em; color: #666; }
    .user-note { font-size: 0.75em; color: #999; margin-top: 2px; }
    .user-quota { text-align: center; min-width: 80px; }
    .user-quota .value { font-weight: bold; font-size: 0.95em; }
    .user-quota .label { font-size: 0.7em; color: #888; }
    .user-device { text-align: center; min-width: 70px; font-size: 0.85em; color: #666; }
    .user-time { font-size: 0.8em; color: #999; min-width: 70px; text-align: right; }
    .user-search { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
    .user-search input { flex: 1; max-width: 280px; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 0.9em; }
    .user-search input:focus { outline: none; border-color: #2196F3; }

    /* Legacy tabs (for record filter) */
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { padding: 10px 20px; background: white; border: none; border-radius: 8px; cursor: pointer; }
    .tab.active { background: #2196F3; color: white; }

    /* Version Management */
    .version-panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 30px; }
    .version-panel h2 { font-size: 1.2em; margin-bottom: 15px; color: #333; display: flex; align-items: center; gap: 8px; }
    .version-form { display: grid; gap: 15px; }
    .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-group label { font-size: 0.85em; color: #666; font-weight: 500; }
    .form-group input, .form-group textarea { padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95em; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #2196F3; }
    .form-group textarea { min-height: 60px; resize: vertical; }
    .form-group.checkbox { flex-direction: row; align-items: center; gap: 8px; }
    .form-group.checkbox input { width: auto; }
    .form-actions { display: flex; gap: 10px; margin-top: 10px; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.95em; }
    .btn-primary { background: #2196F3; color: white; }
    .btn-primary:hover { background: #1976D2; }
    .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 0.9em; z-index: 1000; animation: slideIn 0.3s ease; }
    .toast.success { background: #4caf50; }
    .toast.error { background: #e53935; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* Maintenance List */
    .maintenance-list { display: flex; flex-direction: column; gap: 8px; }
    .maintenance-item {
      background: #f9f9f9;
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .maintenance-item:hover { background: #f0f0f0; }
    .maintenance-icon { font-size: 1.3em; width: 32px; text-align: center; flex-shrink: 0; }
    .maintenance-info { flex: 1; min-width: 0; }
    .maintenance-label { font-size: 0.9em; color: #333; font-weight: 500; }
    .maintenance-desc { font-size: 0.75em; color: #888; margin-top: 2px; }
    .maintenance-status {
      font-size: 0.8em;
      color: #666;
      min-width: 100px;
      text-align: center;
      padding: 4px 8px;
      background: #e8e8e8;
      border-radius: 4px;
    }
    .maintenance-status.processing { background: #fff3cd; color: #856404; }
    .maintenance-status.success { background: #d4edda; color: #155724; }
    .maintenance-status.error { background: #f8d7da; color: #721c24; }
    .btn-sm { padding: 8px 16px; font-size: 0.85em; white-space: nowrap; }

    /* Enhanced Maintenance UI */
    .maint-section { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 16px; margin-bottom: 16px; }
    .maint-section h3 { font-size: 1em; margin: 0 0 12px 0; color: #333; display: flex; align-items: center; gap: 8px; }
    .maint-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .maint-header h2 { margin: 0; font-size: 1.3em; }
    .auto-toggle { display: flex; align-items: center; gap: 8px; }
    .auto-toggle label { font-size: 0.9em; color: #666; }
    .toggle-switch { position: relative; width: 50px; height: 26px; }
    .toggle-switch input { opacity: 0; width: 0; height: 0; }
    .toggle-slider { position: absolute; cursor: pointer; inset: 0; background: #ccc; border-radius: 26px; transition: 0.3s; }
    .toggle-slider:before { position: absolute; content: ""; height: 20px; width: 20px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.3s; }
    .toggle-switch input:checked + .toggle-slider { background: #4caf50; }
    .toggle-switch input:checked + .toggle-slider:before { transform: translateX(24px); }

    .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
    .stat-box { background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center; cursor: pointer; transition: all 0.2s; }
    .stat-box:hover { background: #e3f2fd; transform: translateY(-2px); }
    .stat-box.active { background: #2196F3; color: white; }
    .stat-box .count { font-size: 1.8em; font-weight: bold; }
    .stat-box .label { font-size: 0.8em; color: #666; margin-top: 4px; }
    .stat-box.active .label { color: rgba(255,255,255,0.9); }

    .quick-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .quick-actions .btn { display: flex; align-items: center; gap: 6px; }

    .strategy-list { display: flex; flex-direction: column; gap: 8px; }
    .strategy-item { display: flex; align-items: center; gap: 12px; padding: 12px; background: #f9f9f9; border-radius: 8px; }
    .strategy-item:hover { background: #f0f0f0; }
    .strategy-check { width: 20px; }
    .strategy-icon { font-size: 1.3em; width: 32px; text-align: center; }
    .strategy-info { flex: 1; }
    .strategy-name { font-weight: 500; font-size: 0.95em; }
    .strategy-meta { font-size: 0.75em; color: #888; margin-top: 2px; }
    .strategy-count { min-width: 60px; text-align: center; padding: 4px 8px; background: #e3f2fd; color: #1976d2; border-radius: 4px; font-size: 0.85em; font-weight: 500; }
    .strategy-count.zero { background: #e8e8e8; color: #666; }

    .progress-section { display: none; }
    .progress-section.active { display: block; }
    .progress-bar-container { height: 24px; background: #e0e0e0; border-radius: 12px; overflow: hidden; margin-bottom: 8px; }
    .progress-bar { height: 100%; background: linear-gradient(90deg, #4caf50, #8bc34a); border-radius: 12px; transition: width 0.3s; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.85em; font-weight: 500; }
    .progress-info { display: flex; justify-content: space-between; font-size: 0.85em; color: #666; }
    .progress-recent { margin-top: 12px; }
    .progress-recent-title { font-size: 0.85em; color: #666; margin-bottom: 6px; }
    .progress-recent-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .progress-recent-item { padding: 4px 8px; background: #f0f0f0; border-radius: 4px; font-size: 0.8em; }
    .progress-recent-item.success { background: #d4edda; color: #155724; }
    .progress-recent-item.error { background: #f8d7da; color: #721c24; }

    .history-list { max-height: 200px; overflow-y: auto; }
    .history-item { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #eee; font-size: 0.85em; }
    .history-item:last-child { border-bottom: none; }
    .history-time { color: #888; min-width: 140px; }
    .history-strategy { font-weight: 500; min-width: 80px; }
    .history-result { flex: 1; }
    .history-result.success { color: #4caf50; }
    .history-result.error { color: #e53935; }
    .history-duration { color: #888; min-width: 60px; text-align: right; }
    .history-empty { color: #888; text-align: center; padding: 20px; }

    /* ===== 響應式設計 ===== */

    /* Tablet */
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(3, 1fr); }
      .quick-actions { flex-direction: column; }
      .main-tabs { flex-wrap: wrap; }
      .main-tab { flex: 1 1 auto; min-width: 80px; padding: 12px 10px; font-size: 0.85em; justify-content: center; }
      .user-stats { grid-template-columns: repeat(2, 1fr); }
      .record { flex-wrap: wrap; }
      .record-actions { width: 100%; justify-content: flex-end; margin-top: 8px; }
    }

    /* Mobile */
    @media (max-width: 480px) {
      .header { flex-direction: column; gap: 10px; padding: 12px; }
      .header nav { width: 100%; justify-content: center; gap: 12px; flex-wrap: wrap; }
      .header nav a { font-size: 0.85em; }
      .container { padding: 12px; }
      .stats { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .stat-card { padding: 14px; }
      .stat-card h3 { font-size: 1.5em; }
      .main-tabs { gap: 4px; padding: 4px; }
      .main-tab { padding: 10px 8px; font-size: 0.75em; min-width: 60px; }
      .main-tab span:first-child { display: block; }
      .user-stats { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .user-stat { padding: 12px 8px; }
      .user-stat .value { font-size: 1.4em; }
      .user-stat .label { font-size: 0.75em; }
      .user-search { flex-direction: column; }
      .user-search input { max-width: 100%; }
      .user-item { flex-wrap: wrap; padding: 12px; }
      .user-quota, .user-device { display: none; }
      .user-time { width: 100%; text-align: left; margin-top: 4px; font-size: 0.75em; }
      .record { padding: 12px; }
      .record-thumb { width: 60px; height: 45px; }
      .record-title { font-size: 0.9em; }
      .record-meta { font-size: 0.75em; }
      .history-item { flex-wrap: wrap; gap: 6px; }
      .history-time { min-width: auto; font-size: 0.75em; }
      .history-strategy { min-width: auto; }
      .history-duration { min-width: auto; }
      /* Modal 調整 */
      #userModal > div { width: 95%; padding: 16px; }
      #userModal h3 { font-size: 1.1em; }
      /* 維護面板 */
      .progress-recent { max-height: 150px; }
      .action-group { flex-direction: column; }
      .action-card { min-width: auto; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
      <h1>管理面板</h1>
    </div>
    <nav>
      <a href="/lurl/admin" class="active">管理面板</a>
      <a href="/lurl/browse">影片庫</a>
      <a href="/lurl/health">API 狀態</a>
    </nav>
  </div>
  <div class="container">
    <div class="stats" id="stats"></div>

    <!-- 主選項卡 -->
    <div class="main-tabs">
      <button class="main-tab active" data-tab="records">📋 記錄</button>
      <button class="main-tab" data-tab="users">👥 使用者</button>
      <button class="main-tab" data-tab="redemptions">🎁 兌換碼</button>
      <button class="main-tab" data-tab="hls">🎬 HLS</button>
      <button class="main-tab" data-tab="version">📦 版本</button>
      <button class="main-tab" data-tab="maintenance">🔧 維護</button>
    </div>

    <!-- 記錄 Tab -->
    <div class="tab-content active" id="tab-records">
      <div class="tabs">
        <button class="tab active" data-type="all">全部</button>
        <button class="tab" data-type="video">影片</button>
        <button class="tab" data-type="image">圖片</button>
      </div>
      <div class="records" id="records"></div>
    </div>

    <!-- 使用者 Tab -->
    <div class="tab-content" id="tab-users">
      <div class="user-stats">
        <div class="user-stat">
          <div class="value" id="userTotal">-</div>
          <div class="label">總用戶</div>
        </div>
        <div class="user-stat">
          <div class="value green" id="userActive">-</div>
          <div class="label">活躍</div>
        </div>
        <div class="user-stat">
          <div class="value orange" id="userVip">-</div>
          <div class="label">VIP</div>
        </div>
        <div class="user-stat">
          <div class="value red" id="userBanned">-</div>
          <div class="label">封禁</div>
        </div>
      </div>
      <!-- 序號搜尋 -->
      <div class="user-search">
        <input type="text" id="userSearchInput" placeholder="🔍 輸入序號搜尋（如 V_1ABC）" maxlength="20">
        <button class="btn btn-primary btn-sm" onclick="searchUserByCode()">搜尋</button>
        <button class="btn btn-sm" onclick="clearUserSearch()" style="background:#e0e0e0;">清除</button>
      </div>
      <div class="user-list" id="userList">
        <div class="empty">載入中...</div>
      </div>
    </div>

    <!-- 使用者編輯 Modal -->
    <div id="userModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center;">
      <div style="background:white; border-radius:12px; padding:24px; max-width:450px; width:90%; max-height:80vh; overflow-y:auto;">
        <h3 style="margin:0 0 20px 0;">👤 管理用戶</h3>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">用戶 ID</label>
          <div id="modalUserId" style="font-family:monospace; background:#f5f5f5; padding:8px; border-radius:4px; word-break:break-all; font-size:0.85em;"></div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:15px;">
          <div style="background:#f9f9f9; padding:12px; border-radius:8px;">
            <div style="font-size:0.75em; color:#888;">額度狀態</div>
            <div id="modalQuotaInfo" style="font-size:1.1em; font-weight:bold; margin-top:4px;">-</div>
          </div>
          <div style="background:#f9f9f9; padding:12px; border-radius:8px;">
            <div style="font-size:0.75em; color:#888;">最後上線</div>
            <div id="modalLastSeen" style="font-size:0.9em; margin-top:4px;">-</div>
          </div>
        </div>
        <div style="background:#f9f9f9; padding:12px; border-radius:8px; margin-bottom:15px;">
          <div style="font-size:0.75em; color:#888; margin-bottom:8px;">設備資訊</div>
          <div id="modalDeviceInfo" style="font-size:0.85em; display:grid; grid-template-columns:1fr 1fr; gap:6px;">-</div>
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">備註</label>
          <input type="text" id="modalNote" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;" placeholder="添加備註...">
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">配發額度</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(5)">+5</button>
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(10)">+10</button>
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(20)">+20</button>
            <button class="btn btn-primary btn-sm" onclick="addUserQuota(50)">+50</button>
          </div>
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">狀態操作</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
            <button class="btn btn-sm" style="background:#4caf50; color:white;" onclick="setUserStatus('active')">✅ 正常</button>
            <button class="btn btn-sm" style="background:#ff9800; color:white;" onclick="setUserStatus('vip')">⭐ VIP</button>
            <button class="btn btn-sm" style="background:#f44336; color:white;" onclick="setUserStatus('banned')">🚫 封禁</button>
          </div>
        </div>
        <div style="margin-bottom:15px;">
          <label style="font-size:0.85em; color:#666;">使用歷史 (最近 5 筆)</label>
          <div id="modalHistory" style="font-size:0.85em; background:#f9f9f9; padding:10px; border-radius:4px; max-height:120px; overflow-y:auto;"></div>
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button class="btn" style="background:#e0e0e0;" onclick="closeUserModal()">關閉</button>
          <button class="btn btn-primary" onclick="saveUserChanges()">儲存</button>
        </div>
      </div>
    </div>

    <!-- 兌換碼 Tab -->
    <div class="tab-content" id="tab-redemptions">
      <div class="user-stats" style="margin-bottom:20px;">
        <div class="user-stat">
          <div class="value" id="redemptionTotal">-</div>
          <div class="label">總數</div>
        </div>
        <div class="user-stat">
          <div class="value green" id="redemptionUnused">-</div>
          <div class="label">未使用</div>
        </div>
        <div class="user-stat">
          <div class="value orange" id="redemptionUsed">-</div>
          <div class="label">已使用</div>
        </div>
        <div class="user-stat">
          <div class="value red" id="redemptionExpired">-</div>
          <div class="label">已過期</div>
        </div>
      </div>

      <!-- 生成兌換碼 -->
      <div class="version-panel" style="margin-bottom:20px;">
        <h2>🎁 生成兌換碼</h2>
        <div class="version-form">
          <div class="form-row">
            <div class="form-group">
              <label>數量</label>
              <input type="number" id="genCount" value="10" min="1" max="100">
            </div>
            <div class="form-group">
              <label>每個額度</label>
              <input type="number" id="genBonus" value="5" min="1" max="100">
            </div>
            <div class="form-group">
              <label>有效期限（留空=無限期）</label>
              <input type="date" id="genExpiry">
            </div>
          </div>
          <div class="form-group">
            <label>備註</label>
            <input type="text" id="genNote" placeholder="例：新年活動、社群回饋">
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" onclick="generateCodes()">🎲 生成</button>
          </div>
        </div>
      </div>

      <!-- 兌換碼列表 -->
      <div class="version-panel">
        <h2>📋 兌換碼列表</h2>
        <div style="margin-bottom:12px; display:flex; gap:8px; align-items:center;">
          <select id="redemptionFilter" onchange="loadRedemptions()" style="padding:8px 12px; border:1px solid #ddd; border-radius:6px;">
            <option value="all">全部</option>
            <option value="unused">未使用</option>
            <option value="used">已使用</option>
            <option value="expired">已過期</option>
          </select>
          <button class="btn btn-sm" style="background:#e0e0e0;" onclick="copyUnusedCodes()">📋 複製未使用</button>
        </div>
        <div id="redemptionsList" style="max-height:400px; overflow-y:auto;">載入中...</div>
      </div>
    </div>

    <!-- HLS Tab -->
    <div class="tab-content" id="tab-hls">
      <div class="version-panel" style="margin-bottom:20px;">
        <h2>🎬 HLS 串流轉檔</h2>
        <p style="color:#666; margin-bottom:20px;">將影片轉換為多畫質 HLS 串流格式，支援自適應畫質切換，大幅改善播放體驗。</p>

        <!-- HLS 統計 -->
        <div class="user-stats" style="grid-template-columns: repeat(4, 1fr); margin-bottom:20px;">
          <div class="user-stat">
            <div class="value" id="hlsTotal">-</div>
            <div class="label">影片總數</div>
          </div>
          <div class="user-stat">
            <div class="value green" id="hlsReady">-</div>
            <div class="label">已轉檔</div>
          </div>
          <div class="user-stat">
            <div class="value orange" id="hlsPending">-</div>
            <div class="label">待轉檔</div>
          </div>
          <div class="user-stat">
            <div class="value" id="hlsQueue">-</div>
            <div class="label">佇列中</div>
          </div>
        </div>

        <!-- 操作按鈕 -->
        <div style="display:flex; gap:12px; margin-bottom:20px;">
          <button class="btn btn-primary" onclick="transcodeAllHLS()">🚀 全部轉檔</button>
          <button class="btn" style="background:#e0e0e0;" onclick="refreshHLSStats()">🔄 刷新狀態</button>
        </div>

        <!-- 轉檔進度 -->
        <div id="hlsProgress" style="display:none; background:#f5f5f5; padding:15px; border-radius:8px; margin-bottom:20px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
            <span id="hlsProgressTitle">轉檔中...</span>
            <span id="hlsProgressTime">00:00:00</span>
          </div>
          <div style="background:#ddd; height:8px; border-radius:4px; overflow:hidden;">
            <div id="hlsProgressBar" style="background:#4caf50; height:100%; width:0%; transition:width 0.3s;"></div>
          </div>
        </div>

        <!-- 未轉檔列表 -->
        <h3 style="margin-bottom:12px;">待轉檔影片</h3>
        <div class="records" id="hlsPendingList" style="max-height:400px; overflow-y:auto;">
          <div class="empty">載入中...</div>
        </div>
      </div>
    </div>

    <!-- 版本 Tab -->
    <div class="tab-content" id="tab-version">
      <div class="version-panel" style="margin-bottom:0;">
        <h2>📦 腳本版本管理</h2>
        <div class="version-form">
          <div class="form-row">
            <div class="form-group">
              <label>最新版本 (latestVersion)</label>
              <input type="text" id="latestVersion" placeholder="例: 4.8">
            </div>
            <div class="form-group">
              <label>最低版本 (minVersion) - 低於此版本強制更新</label>
              <input type="text" id="minVersion" placeholder="例: 4.0.0">
            </div>
          </div>
          <div class="form-group">
            <label>更新訊息 (message)</label>
            <input type="text" id="versionMessage" placeholder="例: 新增功能、修復問題等">
          </div>
          <div class="form-group">
            <label>公告 (announcement) - 可選</label>
            <textarea id="announcement" placeholder="額外公告訊息..."></textarea>
          </div>
          <div class="form-group">
            <label>更新連結 (updateUrl)</label>
            <input type="text" id="updateUrl" placeholder="GitHub raw URL">
          </div>
          <div class="form-group checkbox">
            <input type="checkbox" id="forceUpdate">
            <label for="forceUpdate">強制更新 (forceUpdate) - 所有舊版本必須更新</label>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" onclick="saveVersionConfig()">💾 儲存設定</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 維護 Tab -->
    <div class="tab-content" id="tab-maintenance">
      <!-- Header with Auto Toggle -->
      <div class="maint-header">
        <h2>🔧 維護管理</h2>
        <div class="auto-toggle">
          <label>自動排程</label>
          <label class="toggle-switch">
            <input type="checkbox" id="autoScheduleToggle" onchange="toggleAutoSchedule(this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <span id="nextRunTime" style="font-size:0.8em;color:#888;"></span>
        </div>
      </div>

      <!-- 待處理統計 -->
      <div class="maint-section">
        <h3>📊 待處理統計</h3>
        <div class="stats-grid" id="maintStats">
          <div class="stat-box" data-strategy="download">
            <div class="count" id="statDownload">-</div>
            <div class="label">下載</div>
          </div>
          <div class="stat-box" data-strategy="thumbnail">
            <div class="count" id="statThumbnail">-</div>
            <div class="label">縮圖</div>
          </div>
          <div class="stat-box" data-strategy="preview">
            <div class="count" id="statPreview">-</div>
            <div class="label">預覽</div>
          </div>
          <div class="stat-box" data-strategy="hls">
            <div class="count" id="statHLS">-</div>
            <div class="label">HLS</div>
          </div>
          <div class="stat-box" data-strategy="cleanup">
            <div class="count" id="statCleanup">-</div>
            <div class="label">清理</div>
          </div>
        </div>
      </div>

      <!-- 快速操作 -->
      <div class="maint-section">
        <h3>🚀 快速操作</h3>
        <div class="quick-actions">
          <button class="btn btn-primary" onclick="runAllMaintenance()" id="runAllBtn">▶ 執行全部維護</button>
          <button class="btn" style="background:#ff9800;color:white" onclick="syncStatus()">↻ 同步狀態</button>
          <button class="btn" style="background:#9c27b0;color:white" onclick="runMigrate()">📥 狀態遷移</button>
        </div>
      </div>

      <!-- 策略控制 -->
      <div class="maint-section">
        <h3>⚙️ 策略控制</h3>
        <div class="strategy-list" id="strategyList">
          <div class="strategy-item" data-strategy="download">
            <input type="checkbox" class="strategy-check" checked data-strategy="download">
            <div class="strategy-icon">📥</div>
            <div class="strategy-info">
              <div class="strategy-name">下載</div>
              <div class="strategy-meta">優先級: 1 | 批次: 5</div>
            </div>
            <div class="strategy-count" id="countDownload">0</div>
            <button class="btn btn-primary btn-sm" onclick="runStrategy('download')">▶</button>
          </div>
          <div class="strategy-item" data-strategy="thumbnail">
            <input type="checkbox" class="strategy-check" checked data-strategy="thumbnail">
            <div class="strategy-icon">🖼️</div>
            <div class="strategy-info">
              <div class="strategy-name">縮圖</div>
              <div class="strategy-meta">優先級: 2 | 批次: 20</div>
            </div>
            <div class="strategy-count" id="countThumbnail">0</div>
            <button class="btn btn-primary btn-sm" onclick="runStrategy('thumbnail')">▶</button>
          </div>
          <div class="strategy-item" data-strategy="preview">
            <input type="checkbox" class="strategy-check" checked data-strategy="preview">
            <div class="strategy-icon">🎞️</div>
            <div class="strategy-info">
              <div class="strategy-name">預覽</div>
              <div class="strategy-meta">優先級: 3 | 批次: 5</div>
            </div>
            <div class="strategy-count" id="countPreview">0</div>
            <button class="btn btn-primary btn-sm" onclick="runStrategy('preview')">▶</button>
          </div>
          <div class="strategy-item" data-strategy="hls">
            <input type="checkbox" class="strategy-check" checked data-strategy="hls">
            <div class="strategy-icon">🎬</div>
            <div class="strategy-info">
              <div class="strategy-name">HLS 轉檔</div>
              <div class="strategy-meta">優先級: 4 | 批次: 1</div>
            </div>
            <div class="strategy-count" id="countHLS">0</div>
            <button class="btn btn-primary btn-sm" onclick="runStrategy('hls')">▶</button>
          </div>
          <div class="strategy-item" data-strategy="cleanup">
            <input type="checkbox" class="strategy-check" checked data-strategy="cleanup">
            <div class="strategy-icon">🗑️</div>
            <div class="strategy-info">
              <div class="strategy-name">清理</div>
              <div class="strategy-meta">優先級: 5 | 批次: 10</div>
            </div>
            <div class="strategy-count" id="countCleanup">0</div>
            <button class="btn btn-primary btn-sm" onclick="runStrategy('cleanup')">▶</button>
          </div>
        </div>
      </div>

      <!-- 執行進度 -->
      <div class="maint-section progress-section" id="progressSection">
        <h3>📈 執行進度 <span id="progressLive" style="font-size:0.8em;color:#4caf50;margin-left:8px;">● 即時更新中</span></h3>
        <div class="progress-bar-container">
          <div class="progress-bar" id="progressBar" style="width:0%">0%</div>
        </div>
        <div class="progress-info">
          <span id="progressTask">等待中...</span>
          <span id="progressCount">0/0</span>
        </div>
        <div class="progress-recent">
          <div class="progress-recent-title">最近完成:</div>
          <div class="progress-recent-list" id="recentItems"></div>
        </div>
      </div>

      <!-- 執行歷史 -->
      <div class="maint-section">
        <h3>📜 執行歷史</h3>
        <div class="history-list" id="historyList">
          <div class="history-empty">載入中...</div>
        </div>
      </div>

      <!-- 舊版維護操作（保留向下相容） -->
      <div class="maint-section" style="margin-top:24px;">
        <h3>🔧 其他維護操作</h3>
        <div class="maintenance-list">
          <div class="maintenance-item">
            <div class="maintenance-icon">🔧</div>
            <div class="maintenance-info">
              <div class="maintenance-label">修復 Untitled</div>
              <div class="maintenance-desc">重新抓取缺少標題的記錄</div>
            </div>
            <div class="maintenance-status" id="untitledStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="fixUntitled()">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">🔄</div>
            <div class="maintenance-info">
              <div class="maintenance-label">重試下載 (Puppeteer)</div>
              <div class="maintenance-desc">用 Puppeteer 重新下載失敗的檔案</div>
            </div>
            <div class="maintenance-status" id="retryStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="retryFailed()" id="retryBtn">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">🗑️</div>
            <div class="maintenance-info">
              <div class="maintenance-label">清理重複</div>
              <div class="maintenance-desc">移除重複的 pageUrl/fileUrl 記錄</div>
            </div>
            <div class="maintenance-status" id="dupStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="cleanupDuplicates()" id="dupBtn">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">📁</div>
            <div class="maintenance-info">
              <div class="maintenance-label">修復路徑</div>
              <div class="maintenance-desc">修正指向同一檔案的記錄</div>
            </div>
            <div class="maintenance-status" id="repairStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="repairPaths()" id="repairBtn">執行</button>
          </div>
          <div class="maintenance-item">
            <div class="maintenance-icon">🎬</div>
            <div class="maintenance-info">
              <div class="maintenance-label">清理 HLS 原檔</div>
              <div class="maintenance-desc">刪除已轉 HLS 的原始影片，釋放空間</div>
            </div>
            <div class="maintenance-status" id="hlsCleanupStatus">就緒</div>
            <button class="btn btn-primary btn-sm" onclick="cleanupHlsOriginals()" id="hlsCleanupBtn">執行</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    let allRecords = [];
    let currentType = 'all';
    let allUsers = [];
    let currentUser = null;

    // ===== 主 Tab 切換 =====
    document.querySelectorAll('.main-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        switchMainTab(targetTab);
      });
    });

    function switchMainTab(tabName) {
      // 更新 tab 樣式
      document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
      document.querySelector(\`.main-tab[data-tab="\${tabName}"]\`).classList.add('active');

      // 顯示對應內容
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + tabName).classList.add('active');

      // 更新 URL hash
      history.replaceState(null, '', '#' + tabName);

      // 載入資料
      if (tabName === 'users') loadUsers();
      if (tabName === 'redemptions') loadRedemptions();
      if (tabName === 'hls') refreshHLSStats();
    }

    // 根據 URL hash 切換 tab
    function checkHashAndSwitch() {
      const hash = window.location.hash.replace('#', '') || 'records';
      if (['records', 'users', 'redemptions', 'hls', 'version', 'maintenance'].includes(hash)) {
        switchMainTab(hash);
      }
    }
    window.addEventListener('hashchange', checkHashAndSwitch);

    // ===== 使用者管理 =====
    async function loadUsers() {
      try {
        const res = await fetch('/lurl/api/users');
        const data = await res.json();
        if (data.ok) {
          allUsers = data.users;
          renderUserStats();
          renderUserList();
        }
      } catch (e) {
        document.getElementById('userList').innerHTML = '<div class="empty">載入失敗</div>';
      }
    }

    function renderUserStats() {
      const total = allUsers.length;
      const active = allUsers.filter(u => u.status === 'active').length;
      const vip = allUsers.filter(u => u.status === 'vip' || u.isVip).length;
      const banned = allUsers.filter(u => u.status === 'banned').length;

      document.getElementById('userTotal').textContent = total;
      document.getElementById('userActive').textContent = active;
      document.getElementById('userVip').textContent = vip;
      document.getElementById('userBanned').textContent = banned;
    }

    function renderUserList() {
      if (allUsers.length === 0) {
        document.getElementById('userList').innerHTML = '<div class="empty">尚無用戶</div>';
        return;
      }

      // 根據搜尋過濾（搜尋隨機部分或完整 visitorId）
      let filtered = allUsers;
      if (searchQuery) {
        filtered = allUsers.filter(u => {
          const parts = u.visitorId.split('_');
          const randomPart = (parts[2] || parts[1] || u.visitorId).toUpperCase();
          return randomPart.startsWith(searchQuery) || u.visitorId.toUpperCase().includes(searchQuery);
        });
      }

      if (filtered.length === 0) {
        document.getElementById('userList').innerHTML = '<div class="empty">找不到符合「' + searchQuery + '」的用戶</div>';
        return;
      }

      const html = filtered.map(u => {
        const statusIcon = u.status === 'banned' ? '🔴' : (u.status === 'vip' || u.isVip ? '⭐' : '🟢');
        const remaining = u.remaining === -1 ? '∞' : u.remaining;
        const remainingColor = u.remaining === -1 ? 'color:#ff9800' : (u.remaining <= 0 ? 'color:#f44336' : 'color:#4caf50');
        const lastSeen = u.device?.lastSeen ? timeAgo(u.device.lastSeen) : '-';
        const network = u.device?.network?.type?.toUpperCase() || '-';
        // 顯示序號（使用隨機部分前6位）避免時間戳碰撞
        const parts = u.visitorId.split('_');
        const shortCode = (parts[2] || parts[1] || u.visitorId).substring(0, 6).toUpperCase();

        return \`<div class="user-item" onclick="openUserModal('\${u.visitorId}')">
          <div class="user-status-icon">\${statusIcon}</div>
          <div class="user-info">
            <div class="user-id"><span style="background:#e3f2fd;padding:2px 6px;border-radius:4px;font-weight:bold;color:#1976d2;">\${shortCode}</span> \${u.visitorId.substring(6, 20)}...</div>
            <div class="user-note">\${u.note || '無備註'}</div>
          </div>
          <div class="user-quota">
            <div class="value" style="\${remainingColor}">\${u.usedCount}/\${u.total}</div>
            <div class="label">已用/總額</div>
          </div>
          <div class="user-device">\${network}</div>
          <div class="user-time">\${lastSeen}</div>
        </div>\`;
      }).join('');

      document.getElementById('userList').innerHTML = html;
    }

    // 序號搜尋
    let searchQuery = '';
    function searchUserByCode() {
      const input = document.getElementById('userSearchInput').value.trim().toUpperCase();
      if (!input) return;
      searchQuery = input;
      renderUserList();
    }

    function clearUserSearch() {
      searchQuery = '';
      document.getElementById('userSearchInput').value = '';
      renderUserList();
    }

    // Enter 搜尋
    document.getElementById('userSearchInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') searchUserByCode();
    });

    function openUserModal(visitorId) {
      currentUser = allUsers.find(u => u.visitorId === visitorId);
      if (!currentUser) return;

      const u = currentUser;
      document.getElementById('modalUserId').textContent = u.visitorId;

      // 額度資訊
      const remaining = u.remaining === -1 ? '∞' : u.remaining;
      const statusText = u.status === 'banned' ? '🔴封禁' : (u.status === 'vip' || u.isVip ? '⭐VIP' : '🟢正常');
      document.getElementById('modalQuotaInfo').innerHTML = \`\${statusText}<br><span style="font-size:0.8em;color:#666;">\${u.usedCount}/\${u.total} (剩:\${remaining})</span>\`;

      // 最後上線
      const lastSeen = u.device?.lastSeen ? new Date(u.device.lastSeen).toLocaleString() : (u.lastActive ? new Date(u.lastActive).toLocaleString() : '-');
      document.getElementById('modalLastSeen').textContent = lastSeen;

      // 設備資訊 (grid layout)
      const d = u.device || {};
      const deviceItems = [];

      // 網路
      if (d.network?.type) deviceItems.push({ label: '網路', value: d.network.type.toUpperCase() });
      if (d.network?.downlink) deviceItems.push({ label: '頻寬', value: d.network.downlink + ' Mbps' });
      if (d.network?.rtt) deviceItems.push({ label: '延遲', value: d.network.rtt + ' ms' });

      // 硬體
      if (d.hardware?.cores) deviceItems.push({ label: 'CPU', value: d.hardware.cores + ' 核心' });
      if (d.hardware?.memory) deviceItems.push({ label: '記憶體', value: d.hardware.memory + ' GB' });

      // 電池
      if (d.battery?.level != null) {
        const batteryPct = Math.round(d.battery.level * 100);
        const charging = d.battery.charging ? '⚡' : '';
        deviceItems.push({ label: '電量', value: batteryPct + '%' + charging });
      }

      // 測速結果
      if (d.speedTest?.mbps) {
        const testedAt = d.speedTest.testedAt ? new Date(d.speedTest.testedAt).toLocaleString() : '';
        deviceItems.push({ label: '實測速度', value: d.speedTest.mbps.toFixed(1) + ' Mbps' });
        if (testedAt) deviceItems.push({ label: '測速時間', value: testedAt });
      }

      if (deviceItems.length === 0) {
        document.getElementById('modalDeviceInfo').innerHTML = '<span style="color:#999;">無設備資訊</span>';
      } else {
        document.getElementById('modalDeviceInfo').innerHTML = deviceItems.map(item =>
          \`<div><span style="color:#888;">\${item.label}:</span> \${item.value}</div>\`
        ).join('');
      }

      document.getElementById('modalNote').value = u.note || '';

      // 歷史
      const history = (u.history || []).slice(-5).reverse();
      if (history.length === 0) {
        document.getElementById('modalHistory').innerHTML = '<div style="color:#999;">無使用記錄</div>';
      } else {
        document.getElementById('modalHistory').innerHTML = history.map(h => \`
          <div style="padding:4px 0; border-bottom:1px solid #eee;">
            <div style="color:#333; font-size:0.85em;">\${h.pageUrl ? h.pageUrl.substring(0, 40) + '...' : '未知'}</div>
            <div style="color:#888; font-size:0.75em;">\${new Date(h.usedAt).toLocaleString()}</div>
          </div>
        \`).join('');
      }

      document.getElementById('userModal').style.display = 'flex';
    }

    function closeUserModal() {
      document.getElementById('userModal').style.display = 'none';
      currentUser = null;
    }

    async function addUserQuota(amount) {
      if (!currentUser) return;
      try {
        const res = await fetch('/lurl/api/users/' + encodeURIComponent(currentUser.visitorId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addBonus: amount })
        });
        if ((await res.json()).ok) {
          showToast('已配發 +' + amount + ' 額度', 'success');
          await loadUsers();
          currentUser = allUsers.find(u => u.visitorId === currentUser.visitorId);
          if (currentUser) openUserModal(currentUser.visitorId);
        }
      } catch (e) {
        showToast('配發失敗', 'error');
      }
    }

    async function setUserStatus(status) {
      if (!currentUser) return;
      try {
        const res = await fetch('/lurl/api/users/' + encodeURIComponent(currentUser.visitorId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        if ((await res.json()).ok) {
          const statusText = status === 'banned' ? '已封禁' : (status === 'vip' ? '已設為 VIP' : '已恢復正常');
          showToast(statusText, 'success');
          await loadUsers();
          closeUserModal();
        }
      } catch (e) {
        showToast('操作失敗', 'error');
      }
    }

    async function saveUserChanges() {
      if (!currentUser) return;
      const note = document.getElementById('modalNote').value;
      try {
        const res = await fetch('/lurl/api/users/' + encodeURIComponent(currentUser.visitorId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note })
        });
        if ((await res.json()).ok) {
          showToast('已儲存', 'success');
          await loadUsers();
          closeUserModal();
        }
      } catch (e) {
        showToast('儲存失敗', 'error');
      }
    }

    // Modal 背景點擊關閉
    document.getElementById('userModal').addEventListener('click', function(e) {
      if (e.target === this) closeUserModal();
    });

    function timeAgo(timestamp) {
      const seconds = Math.floor((Date.now() - timestamp) / 1000);
      if (seconds < 60) return '剛剛';
      if (seconds < 3600) return Math.floor(seconds / 60) + '分鐘前';
      if (seconds < 86400) return Math.floor(seconds / 3600) + '小時前';
      return Math.floor(seconds / 86400) + '天前';
    }

    // ===== 兌換碼管理 =====
    let allRedemptions = [];

    async function loadRedemptions() {
      try {
        const res = await fetch('/lurl/api/redemptions');
        const data = await res.json();
        if (data.ok) {
          allRedemptions = data.redemptions;
          renderRedemptionStats(data.stats);
          renderRedemptionsList();
        }
      } catch (e) {
        document.getElementById('redemptionsList').innerHTML = '<div class="empty">載入失敗</div>';
      }
    }

    function renderRedemptionStats(stats) {
      document.getElementById('redemptionTotal').textContent = stats.total;
      document.getElementById('redemptionUnused').textContent = stats.unused;
      document.getElementById('redemptionUsed').textContent = stats.used;
      document.getElementById('redemptionExpired').textContent = stats.expired;
    }

    function renderRedemptionsList() {
      const filter = document.getElementById('redemptionFilter').value;
      let filtered = allRedemptions;

      if (filter === 'unused') {
        filtered = allRedemptions.filter(r => !r.usedBy && (!r.expiresAt || new Date(r.expiresAt) > new Date()));
      } else if (filter === 'used') {
        filtered = allRedemptions.filter(r => r.usedBy);
      } else if (filter === 'expired') {
        filtered = allRedemptions.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date() && !r.usedBy);
      }

      if (filtered.length === 0) {
        document.getElementById('redemptionsList').innerHTML = '<div class="empty">無兌換碼</div>';
        return;
      }

      // 表頭
      let html = \`<div class="user-item" style="cursor:default; background:#f5f5f5; font-weight:500; font-size:0.85em; color:#666;">
        <div style="min-width:140px;">兌換碼</div>
        <div style="min-width:50px; text-align:center;">額度</div>
        <div style="min-width:70px; text-align:center;">期限</div>
        <div style="min-width:55px; text-align:center;">狀態</div>
        <div style="min-width:100px; text-align:center;">兌換者</div>
        <div style="min-width:90px; text-align:center;">兌換日期</div>
        <div style="flex:1;">備註</div>
        <div style="min-width:50px;"></div>
      </div>\`;

      html += filtered.map(r => {
        const isUsed = !!r.usedBy;
        const isExpired = r.expiresAt && new Date(r.expiresAt) < new Date();
        const statusColor = isUsed ? '#ff9800' : (isExpired ? '#f44336' : '#4caf50');
        const statusText = isUsed ? '已使用' : (isExpired ? '已過期' : '可使用');
        const expiryText = r.expiresAt ? new Date(r.expiresAt).toLocaleDateString('zh-TW') : '永久';
        const usedByShort = r.usedBy ? r.usedBy.substring(0, 8).toUpperCase() : '-';
        const usedAtText = r.usedAt ? new Date(r.usedAt).toLocaleString('zh-TW') : '-';

        return \`<div class="user-item" style="cursor:default;">
          <div style="font-family:monospace; font-weight:bold; color:#1976d2; min-width:140px;">\${r.code}</div>
          <div style="min-width:50px; text-align:center;">+\${r.bonus}</div>
          <div style="min-width:70px; text-align:center; font-size:0.85em; color:#666;">\${expiryText}</div>
          <div style="min-width:55px; text-align:center; color:\${statusColor}; font-size:0.85em;">\${statusText}</div>
          <div style="min-width:100px; text-align:center;">
            \${r.usedBy
              ? \`<span style="background:#e3f2fd; padding:2px 6px; border-radius:4px; font-size:0.8em; font-family:monospace; cursor:pointer; color:#1976d2;" onclick="jumpToUser('\${r.usedBy}')" title="點擊查看用戶 \${r.usedBy}">\${usedByShort}</span>\`
              : '<span style="color:#999; font-size:0.8em;">-</span>'}
          </div>
          <div style="min-width:90px; text-align:center; font-size:0.75em; color:#888;">\${r.usedAt ? new Date(r.usedAt).toLocaleDateString('zh-TW') : '-'}</div>
          <div style="flex:1; font-size:0.8em; color:#999; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${r.note || '-'}</div>
          <div style="min-width:50px; text-align:right;">
            <button class="btn btn-sm" style="background:#e53935; color:white; padding:4px 8px;" onclick="deleteRedemption('\${r.code}')">刪除</button>
          </div>
        </div>\`;
      }).join('');

      document.getElementById('redemptionsList').innerHTML = html;
    }

    async function generateCodes() {
      const count = parseInt(document.getElementById('genCount').value) || 10;
      const bonus = parseInt(document.getElementById('genBonus').value) || 5;
      const expiresAt = document.getElementById('genExpiry').value || null;
      const note = document.getElementById('genNote').value || '';

      try {
        const res = await fetch('/lurl/api/redemptions/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count, bonus, expiresAt, note })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('已生成 ' + data.codes.length + ' 個兌換碼', 'success');
          loadRedemptions();
        } else {
          showToast(data.error || '生成失敗', 'error');
        }
      } catch (e) {
        showToast('生成失敗：' + e.message, 'error');
      }
    }

    async function deleteRedemption(code) {
      if (!confirm('確定刪除此兌換碼？')) return;
      try {
        await fetch('/lurl/api/redemptions/' + encodeURIComponent(code), { method: 'DELETE' });
        showToast('已刪除', 'success');
        loadRedemptions();
      } catch (e) {
        showToast('刪除失敗', 'error');
      }
    }

    function copyUnusedCodes() {
      const unused = allRedemptions.filter(r => !r.usedBy && (!r.expiresAt || new Date(r.expiresAt) > new Date()));
      if (unused.length === 0) {
        showToast('無可用兌換碼', 'error');
        return;
      }
      const codes = unused.map(r => r.code).join('\\n');
      navigator.clipboard.writeText(codes).then(() => {
        showToast('已複製 ' + unused.length + ' 個兌換碼', 'success');
      });
    }

    // 從兌換碼列表跳轉到用戶
    async function jumpToUser(visitorId) {
      // 切換到用戶 tab
      switchMainTab('users');
      // 等待用戶列表載入
      await loadUsers();
      // 搜尋該用戶（使用隨機部分）
      const parts = visitorId.split('_');
      const shortCode = (parts[2] || parts[1] || visitorId).substring(0, 6).toUpperCase();
      document.getElementById('userSearchInput').value = shortCode;
      searchQuery = shortCode;
      renderUserList();
      // 如果找到，直接開啟 modal
      const user = allUsers.find(u => u.visitorId === visitorId);
      if (user) {
        openUserModal(visitorId);
      }
    }

    // ==================== HLS 管理 ====================
    let hlsRecords = [];

    async function refreshHLSStats() {
      try {
        // 取得記錄
        const recordsRes = await fetch('/lurl/api/records');
        const recordsData = await recordsRes.json();
        const videos = recordsData.records.filter(r => r.type === 'video' && r.fileExists !== false);
        hlsRecords = videos;

        // 取得 HLS 佇列狀態
        const statusRes = await fetch('/lurl/api/hls/status');
        const status = await statusRes.json();

        const hlsReadyCount = videos.filter(r => r.hlsReady).length;
        const hlsPendingCount = videos.filter(r => !r.hlsReady).length;

        document.getElementById('hlsTotal').textContent = videos.length;
        document.getElementById('hlsReady').textContent = hlsReadyCount;
        document.getElementById('hlsPending').textContent = hlsPendingCount;
        document.getElementById('hlsQueue').textContent = status.queue;

        // 顯示進度
        if (status.processing) {
          document.getElementById('hlsProgress').style.display = 'block';
        } else {
          document.getElementById('hlsProgress').style.display = 'none';
        }

        // 渲染待轉檔列表
        renderHLSPendingList();
      } catch (e) {
        console.error('載入 HLS 狀態失敗:', e);
      }
    }

    function renderHLSPendingList() {
      const pending = hlsRecords.filter(r => !r.hlsReady);
      if (pending.length === 0) {
        document.getElementById('hlsPendingList').innerHTML = '<div class="empty">🎉 所有影片已轉檔完成！</div>';
        return;
      }

      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? '未命名' : t;
      document.getElementById('hlsPendingList').innerHTML = pending.slice(0, 50).map(r => \`
        <div class="record" data-id="\${r.id}">
          <div class="record-thumb video">🎬</div>
          <div class="record-info">
            <div class="record-title">\${getTitle(r.title)}</div>
            <div class="record-meta">\${new Date(r.capturedAt).toLocaleString()}</div>
          </div>
          <div class="record-actions">
            <button class="btn btn-sm btn-primary" onclick="transcodeOne('\${r.id}')">轉檔</button>
          </div>
        </div>
      \`).join('');
    }

    async function transcodeOne(recordId) {
      try {
        showToast('已加入轉檔佇列...', 'success');
        await fetch('/lurl/api/hls/transcode/' + recordId, { method: 'POST' });
        setTimeout(refreshHLSStats, 1000);
      } catch (e) {
        showToast('加入佇列失敗', 'error');
      }
    }

    async function transcodeAllHLS() {
      if (!confirm('確定要轉檔所有未處理的影片？這可能需要較長時間。')) return;
      try {
        const res = await fetch('/lurl/api/hls/transcode-all', { method: 'POST' });
        const data = await res.json();
        showToast('已加入 ' + data.queued + ' 個影片到轉檔佇列', 'success');
        document.getElementById('hlsProgress').style.display = 'block';
        setTimeout(refreshHLSStats, 2000);
      } catch (e) {
        showToast('批次轉檔失敗', 'error');
      }
    }

    // 監聽 HLS 進度 (SSE)
    function listenHLSProgress() {
      const eventSource = new EventSource('/lurl/api/logs');
      eventSource.onmessage = function(event) {
        try {
          const log = JSON.parse(event.data);
          if (log.type === 'hls_progress') {
            document.getElementById('hlsProgressTitle').textContent = '轉檔 ' + log.quality + '...';
            document.getElementById('hlsProgressTime').textContent = log.time || '';
          } else if (log.type === 'hls_complete') {
            showToast('轉檔完成: ' + (log.title || log.recordId), 'success');
            refreshHLSStats();
          } else if (log.type === 'hls_start') {
            document.getElementById('hlsProgress').style.display = 'block';
            document.getElementById('hlsProgressTitle').textContent = '開始轉檔: ' + (log.title || log.recordId);
          }
        } catch (e) {}
      };
    }

    // 設定維護狀態的 helper
    function setStatus(id, text, type = '') {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      el.className = 'maintenance-status' + (type ? ' ' + type : '');
    }

    async function loadStats() {
      const res = await fetch('/lurl/api/stats');
      const data = await res.json();
      document.getElementById('stats').innerHTML = \`
        <div class="stat-card"><h3>\${data.total}</h3><p>總記錄</p></div>
        <div class="stat-card"><h3>\${data.videos}</h3><p>影片</p></div>
        <div class="stat-card"><h3>\${data.images}</h3><p>圖片</p></div>
      \`;
    }

    async function loadRecords() {
      const res = await fetch('/lurl/api/records');
      const data = await res.json();
      allRecords = data.records;
      renderRecords();
    }

    function renderRecords() {
      const filtered = currentType === 'all' ? allRecords : allRecords.filter(r => r.type === currentType);
      if (filtered.length === 0) {
        document.getElementById('records').innerHTML = '<div class="empty">尚無記錄</div>';
        return;
      }
      const getTitle = (t) => (!t || t === 'untitle' || t === 'undefined') ? '未命名' : t;
      document.getElementById('records').innerHTML = filtered.map(r => \`
        <div class="record" data-id="\${r.id}">
          <div class="record-thumb \${r.type}">
            \${r.type === 'image'
              ? \`<img src="/lurl/files/\${r.backupPath}" onerror="this.outerHTML='🖼️'">\`
              : (r.fileExists ? '🎬' : '⏳')}
          </div>
          <div class="record-info">
            <div class="record-title">\${getTitle(r.title)}\${r.fileExists ? '' : ' <span style="color:#e53935;font-size:0.8em">(未備份)</span>'}</div>
            <div class="record-meta">\${new Date(r.capturedAt).toLocaleString()}</div>
          </div>
          <div class="record-actions">
            \${r.fileExists ? \`<a href="/lurl/files/\${r.backupPath}" target="_blank">查看</a>\` : ''}
            <a href="/lurl/view/\${r.id}">詳情</a>
            <a href="\${r.pageUrl}" target="_blank">原始</a>
            <button class="delete-btn" onclick="deleteRecord('\${r.id}')">刪除</button>
          </div>
        </div>
      \`).join('');
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        renderRecords();
      });
    });

    async function deleteRecord(id) {
      if (!confirm('確定要刪除這筆記錄？')) return;
      const res = await fetch('/lurl/api/records/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        loadStats();
        loadRecords();
      } else {
        alert('刪除失敗: ' + (data.error || '未知錯誤'));
      }
    }

    // Toast 訊息
    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    // 版本設定
    async function loadVersionConfig() {
      try {
        const res = await fetch('/lurl/api/version');
        const config = await res.json();
        document.getElementById('latestVersion').value = config.latestVersion || '';
        document.getElementById('minVersion').value = config.minVersion || '';
        document.getElementById('versionMessage').value = config.message || '';
        document.getElementById('announcement').value = config.announcement || '';
        document.getElementById('updateUrl').value = config.updateUrl || '';
        document.getElementById('forceUpdate').checked = config.forceUpdate || false;
      } catch (e) {
        console.error('載入版本設定失敗:', e);
      }
    }

    async function saveVersionConfig() {
      const config = {
        latestVersion: document.getElementById('latestVersion').value,
        minVersion: document.getElementById('minVersion').value,
        message: document.getElementById('versionMessage').value,
        announcement: document.getElementById('announcement').value,
        updateUrl: document.getElementById('updateUrl').value,
        forceUpdate: document.getElementById('forceUpdate').checked
      };
      try {
        const res = await fetch('/lurl/api/version', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.ok) {
          showToast('版本設定已儲存！');
        } else {
          showToast('儲存失敗: ' + (data.error || '未知錯誤'), 'error');
        }
      } catch (e) {
        showToast('儲存失敗: ' + e.message, 'error');
      }
    }

    async function fixUntitled() {
      setStatus('untitledStatus', '修復中...', 'processing');
      try {
        const res = await fetch('/lurl/api/fix-untitled', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.fixed > 0) {
            showToast('已修復 ' + data.fixed + ' 個 untitled 記錄！');
            setStatus('untitledStatus', '已修復 ' + data.fixed + ' 筆', 'success');
            loadRecords();
          } else {
            showToast(data.message || '沒有需要修復的記錄');
            setStatus('untitledStatus', '無需修復', 'success');
          }
        } else {
          showToast('修復失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('untitledStatus', '修復失敗', 'error');
        }
      } catch (e) {
        showToast('修復失敗: ' + e.message, 'error');
        setStatus('untitledStatus', '修復失敗', 'error');
      }
    }

    async function loadRetryStatus() {
      try {
        const res = await fetch('/lurl/api/retry-status');
        const data = await res.json();
        const btn = document.getElementById('retryBtn');
        if (data.ok) {
          if (!data.puppeteerAvailable) {
            setStatus('retryStatus', 'Puppeteer 未安裝', 'error');
            btn.disabled = true;
          } else if (data.failed === 0) {
            setStatus('retryStatus', '無失敗記錄', 'success');
            btn.disabled = true;
          } else {
            setStatus('retryStatus', '待重試 ' + data.failed + ' 個');
          }
        }
      } catch (e) {
        setStatus('retryStatus', '載入失敗', 'error');
      }
    }

    async function retryFailed() {
      const btn = document.getElementById('retryBtn');
      btn.disabled = true;
      setStatus('retryStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/retry-failed', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.total === 0) {
            showToast(data.message || '沒有需要重試的記錄');
            setStatus('retryStatus', '無需重試', 'success');
          } else {
            showToast('開始重試 ' + data.total + ' 個，請查看 console');
            setStatus('retryStatus', '處理中 ' + data.total + ' 個', 'processing');
          }
        } else {
          showToast('重試失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('retryStatus', '重試失敗', 'error');
          btn.disabled = false;
        }
      } catch (e) {
        showToast('重試失敗: ' + e.message, 'error');
        setStatus('retryStatus', '重試失敗', 'error');
        btn.disabled = false;
      }
    }

    async function generateThumbnails() {
      const btn = document.getElementById('thumbBtn');
      btn.disabled = true;
      setStatus('thumbStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/generate-thumbnails', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.total === 0) {
            showToast(data.message || '所有影片都已有縮圖');
            setStatus('thumbStatus', '無需產生', 'success');
          } else {
            showToast('開始產生 ' + data.total + ' 個縮圖');
            setStatus('thumbStatus', '處理中 ' + data.total + ' 個', 'processing');
          }
        } else {
          showToast('產生失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('thumbStatus', '產生失敗', 'error');
          btn.disabled = false;
        }
      } catch (e) {
        showToast('產生失敗: ' + e.message, 'error');
        setStatus('thumbStatus', '產生失敗', 'error');
        btn.disabled = false;
      }
    }

    async function repairPaths() {
      const btn = document.getElementById('repairBtn');
      btn.disabled = true;
      setStatus('repairStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/repair-paths', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast(data.message);
          setStatus('repairStatus', data.fixed > 0 ? '已修復 ' + data.fixed + ' 個' : '無需修復', 'success');
          if (data.fixed > 0) {
            loadStats();
            loadRecords();
            loadRetryStatus();
          }
        } else {
          showToast('修復失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('repairStatus', '修復失敗', 'error');
        }
        btn.disabled = false;
      } catch (e) {
        showToast('修復失敗: ' + e.message, 'error');
        setStatus('repairStatus', '修復失敗', 'error');
        btn.disabled = false;
      }
    }

    async function cleanupDuplicates() {
      const btn = document.getElementById('dupBtn');
      btn.disabled = true;
      setStatus('dupStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/cleanup-duplicates', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.removed === 0) {
            showToast(data.message || '沒有重複記錄');
            setStatus('dupStatus', '無重複', 'success');
          } else {
            showToast('已清理 ' + data.removed + ' 個重複記錄');
            setStatus('dupStatus', '已清理 ' + data.removed + ' 個', 'success');
            loadStats();
            loadRecords();
          }
        } else {
          showToast('清理失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('dupStatus', '清理失敗', 'error');
        }
        btn.disabled = false;
      } catch (e) {
        showToast('清理失敗: ' + e.message, 'error');
        setStatus('dupStatus', '清理失敗', 'error');
        btn.disabled = false;
      }
    }

    async function cleanupHlsOriginals() {
      const btn = document.getElementById('hlsCleanupBtn');
      btn.disabled = true;
      setStatus('hlsCleanupStatus', '處理中...', 'processing');
      try {
        const res = await fetch('/lurl/api/cleanup-hls-originals', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.deleted === 0) {
            showToast('沒有可清理的 HLS 原檔');
            setStatus('hlsCleanupStatus', '無需清理', 'success');
          } else {
            showToast('已清理 ' + data.deleted + ' 個檔案，釋放 ' + data.freedMB + ' MB');
            setStatus('hlsCleanupStatus', '釋放 ' + data.freedMB + ' MB', 'success');
          }
        } else {
          showToast('清理失敗: ' + (data.error || '未知錯誤'), 'error');
          setStatus('hlsCleanupStatus', '清理失敗', 'error');
        }
        btn.disabled = false;
      } catch (e) {
        showToast('清理失敗: ' + e.message, 'error');
        setStatus('hlsCleanupStatus', '清理失敗', 'error');
        btn.disabled = false;
      }
    }

    // ===== 維護排程管理 =====
    let maintPollInterval = null;
    let recentCompleted = [];

    // 載入維護狀態統計
    async function loadMaintenanceStats() {
      try {
        const res = await fetch('/lurl/api/maintenance/status-counts');
        const data = await res.json();
        if (data.ok) {
          // 更新統計卡片
          document.getElementById('statDownload').textContent = data.pending?.download || 0;
          document.getElementById('statThumbnail').textContent = data.pending?.thumbnail || 0;
          document.getElementById('statPreview').textContent = data.pending?.preview || 0;
          document.getElementById('statHLS').textContent = data.pending?.hls || 0;
          document.getElementById('statCleanup').textContent = data.pending?.cleanup || 0;

          // 更新策略列表計數
          document.getElementById('countDownload').textContent = data.pending?.download || 0;
          document.getElementById('countThumbnail').textContent = data.pending?.thumbnail || 0;
          document.getElementById('countPreview').textContent = data.pending?.preview || 0;
          document.getElementById('countHLS').textContent = data.pending?.hls || 0;
          document.getElementById('countCleanup').textContent = data.pending?.cleanup || 0;

          // 設定計數樣式
          ['Download', 'Thumbnail', 'Preview', 'HLS', 'Cleanup'].forEach(name => {
            const el = document.getElementById('count' + name);
            if (el) {
              el.classList.toggle('zero', el.textContent === '0');
            }
          });
        }
      } catch (e) {
        console.error('載入維護統計失敗:', e);
      }
    }

    // 載入維護系統狀態（自動排程、執行中等）
    async function loadMaintenanceStatus() {
      try {
        const res = await fetch('/lurl/api/maintenance/status');
        const data = await res.json();
        if (data.ok) {
          // 更新自動排程開關
          const toggle = document.getElementById('autoScheduleToggle');
          if (toggle) toggle.checked = data.autoRunning;

          // 更新下次執行時間
          const nextRunEl = document.getElementById('nextRunTime');
          if (nextRunEl && data.nextRun) {
            nextRunEl.textContent = '下次: ' + new Date(data.nextRun).toLocaleTimeString();
          } else if (nextRunEl) {
            nextRunEl.textContent = '';
          }

          // 如果正在執行，開始輪詢進度
          if (data.isRunning) {
            showProgress(true);
            startProgressPolling();
          }
        }
      } catch (e) {
        console.error('載入維護狀態失敗:', e);
      }
    }

    // 載入執行歷史
    async function loadMaintenanceHistory() {
      try {
        const res = await fetch('/lurl/api/maintenance/history?limit=10');
        const data = await res.json();
        const container = document.getElementById('historyList');
        if (!container) return;

        if (!data.ok || !data.history || data.history.length === 0) {
          container.innerHTML = '<div class="history-empty">尚無執行記錄</div>';
          return;
        }

        container.innerHTML = data.history.map(h => {
          const time = new Date(h.startTime).toLocaleString();
          const success = h.success >= 0 ? h.success : 0;
          const failed = h.failed >= 0 ? h.failed : 0;
          const isSuccess = failed === 0;
          const duration = h.duration ? (h.duration / 1000).toFixed(1) + 's' : '-';

          return \`<div class="history-item">
            <span class="history-time">\${time}</span>
            <span class="history-strategy">\${h.strategy || 'all'}</span>
            <span class="history-result \${isSuccess ? 'success' : 'error'}">\${isSuccess ? '成功' : '失敗'} \${success}/\${success + failed}</span>
            <span class="history-duration">\${duration}</span>
          </div>\`;
        }).join('');
      } catch (e) {
        console.error('載入維護歷史失敗:', e);
        const container = document.getElementById('historyList');
        if (container) container.innerHTML = '<div class="history-empty">載入失敗</div>';
      }
    }

    // 切換自動排程
    async function toggleAutoSchedule(enabled) {
      try {
        const endpoint = enabled ? '/lurl/api/maintenance/auto/start' : '/lurl/api/maintenance/auto/stop';
        const res = await fetch(endpoint, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast(enabled ? '自動排程已啟動' : '自動排程已停止');
          if (data.nextRun) {
            document.getElementById('nextRunTime').textContent = '下次: ' + new Date(data.nextRun).toLocaleTimeString();
          } else {
            document.getElementById('nextRunTime').textContent = '';
          }
        } else {
          showToast('操作失敗: ' + (data.error || '未知錯誤'), 'error');
          document.getElementById('autoScheduleToggle').checked = !enabled;
        }
      } catch (e) {
        showToast('操作失敗: ' + e.message, 'error');
        document.getElementById('autoScheduleToggle').checked = !enabled;
      }
    }

    // 執行全部維護
    async function runAllMaintenance() {
      const btn = document.getElementById('runAllBtn');
      btn.disabled = true;
      btn.textContent = '執行中...';

      try {
        const res = await fetch('/lurl/api/maintenance/run', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast('維護任務已開始執行');
          showProgress(true);
          startProgressPolling();
        } else {
          showToast('執行失敗: ' + (data.error || '未知錯誤'), 'error');
          btn.disabled = false;
          btn.textContent = '▶ 執行全部維護';
        }
      } catch (e) {
        showToast('執行失敗: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = '▶ 執行全部維護';
      }
    }

    // 執行單一策略
    async function runStrategy(strategy) {
      const btn = event.target;
      btn.disabled = true;

      try {
        const res = await fetch('/lurl/api/maintenance/run/' + strategy, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast('策略 ' + strategy + ' 已開始執行');
          showProgress(true);
          startProgressPolling();
        } else {
          showToast('執行失敗: ' + (data.error || '未知錯誤'), 'error');
          btn.disabled = false;
        }
      } catch (e) {
        showToast('執行失敗: ' + e.message, 'error');
        btn.disabled = false;
      }
    }

    // 同步狀態
    async function syncStatus() {
      try {
        showToast('開始同步狀態...');
        const res = await fetch('/lurl/api/maintenance/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: false })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('狀態同步完成，更新 ' + (data.updated || 0) + ' 筆');
          loadMaintenanceStats();
        } else {
          showToast('同步失敗: ' + (data.error || '未知錯誤'), 'error');
        }
      } catch (e) {
        showToast('同步失敗: ' + e.message, 'error');
      }
    }

    // 狀態遷移
    async function runMigrate() {
      if (!confirm('確定要執行狀態遷移？這會根據現有資料設定初始狀態。')) return;

      try {
        showToast('開始狀態遷移...');
        const res = await fetch('/lurl/api/maintenance/migrate', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast('狀態遷移完成，更新 ' + (data.updated || 0) + ' 筆');
          loadMaintenanceStats();
        } else {
          showToast('遷移失敗: ' + (data.error || '未知錯誤'), 'error');
        }
      } catch (e) {
        showToast('遷移失敗: ' + e.message, 'error');
      }
    }

    // 顯示/隱藏進度區塊
    function showProgress(show) {
      const section = document.getElementById('progressSection');
      if (section) {
        section.classList.toggle('active', show);
      }
    }

    // 開始輪詢進度
    function startProgressPolling() {
      if (maintPollInterval) return;

      maintPollInterval = setInterval(async () => {
        try {
          const res = await fetch('/lurl/api/maintenance/status');
          const data = await res.json();

          if (data.ok) {
            updateProgressUI(data);

            if (!data.isRunning) {
              stopProgressPolling();
              onMaintenanceComplete();
            }
          }
        } catch (e) {
          console.error('輪詢進度失敗:', e);
        }
      }, 1000);
    }

    // 停止輪詢
    function stopProgressPolling() {
      if (maintPollInterval) {
        clearInterval(maintPollInterval);
        maintPollInterval = null;
      }
    }

    // 更新進度 UI
    function updateProgressUI(data) {
      const progressBar = document.getElementById('progressBar');
      const progressTask = document.getElementById('progressTask');
      const progressCount = document.getElementById('progressCount');

      if (data.currentTask) {
        // currentTask 可能是字串（策略名稱）或物件
        if (typeof data.currentTask === 'string') {
          // 簡單顯示策略名稱
          progressTask.textContent = '正在執行: ' + data.currentTask;
          progressBar.style.width = '50%';
          progressBar.textContent = '執行中';
          progressCount.textContent = '';
        } else {
          // 物件格式，顯示詳細進度
          const total = data.currentTask.total || 1;
          const processed = data.currentTask.processed || 0;
          const percent = Math.round((processed / total) * 100);

          progressBar.style.width = percent + '%';
          progressBar.textContent = percent + '%';
          progressTask.textContent = '正在處理: ' + (data.currentTask.strategy || data.currentTask.name) + ' (' + (data.currentTask.current || '') + ')';
          progressCount.textContent = processed + '/' + total;

          // 更新最近完成項目
          if (data.currentTask.recentCompleted) {
            updateRecentItems(data.currentTask.recentCompleted);
          }
        }
      } else if (data.isRunning) {
        progressTask.textContent = '準備中...';
        progressBar.style.width = '10%';
        progressBar.textContent = '';
      }
    }

    // 更新最近完成項目
    function updateRecentItems(items) {
      const container = document.getElementById('recentItems');
      if (!container || !items) return;

      container.innerHTML = items.slice(-5).map(item => {
        const cls = item.success ? 'success' : 'error';
        const icon = item.success ? '✓' : '✗';
        const id = (item.id || '').substring(0, 6);
        return \`<span class="progress-recent-item \${cls}">\${id} \${icon}</span>\`;
      }).join('');
    }

    // 維護完成
    function onMaintenanceComplete() {
      showToast('維護任務完成');
      showProgress(false);

      // 重設按鈕狀態
      const runAllBtn = document.getElementById('runAllBtn');
      if (runAllBtn) {
        runAllBtn.disabled = false;
        runAllBtn.textContent = '▶ 執行全部維護';
      }

      // 重設策略按鈕
      document.querySelectorAll('.strategy-item button').forEach(btn => {
        btn.disabled = false;
      });

      // 重新載入資料
      loadMaintenanceStats();
      loadMaintenanceHistory();
    }

    // 維護 Tab 切換時載入資料
    function onMaintenanceTabLoad() {
      loadMaintenanceStats();
      loadMaintenanceStatus();
      loadMaintenanceHistory();
    }

    // 擴展原有的 switchMainTab 來處理維護 tab
    const originalSwitchMainTab = switchMainTab;
    switchMainTab = function(tabName) {
      originalSwitchMainTab(tabName);
      if (tabName === 'maintenance') {
        onMaintenanceTabLoad();
      }
    };

    // ===== 滾動位置記憶 =====
    const SCROLL_KEY = 'lurlAdminScroll';

    function saveScrollPosition() {
      const currentTab = location.hash.replace('#', '') || 'records';
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
        tab: currentTab,
        scrollY: window.scrollY
      }));
    }

    function restoreScrollPosition() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
        const currentTab = location.hash.replace('#', '') || 'records';
        // 只有在同一個 tab 才恢復滾動位置
        if (saved.tab === currentTab && saved.scrollY) {
          setTimeout(() => window.scrollTo(0, saved.scrollY), 50);
        }
      } catch (e) {}
    }

    // 離開頁面時記錄
    window.addEventListener('beforeunload', saveScrollPosition);
    // 點擊連結時也記錄（以防 beforeunload 不觸發）
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link && !link.href.includes('#')) saveScrollPosition();
    });

    // 初始化
    loadStats();
    loadRecords();
    loadVersionConfig();
    loadRetryStatus();
    checkHashAndSwitch();
    restoreScrollPosition();
    listenHLSProgress();

    // 如果啟動時在維護 tab，載入維護資料
    if (location.hash === '#maintenance') {
      onMaintenanceTabLoad();
    }
  </script>
</body>
</html>`;
}

// Service Worker 腳本 - HLS 緩存 + LRU 淘汰
function serviceWorkerScript() {
  return `
const CACHE_NAME = 'lurl-hls-v1';
const MAX_CACHE_SIZE = 300 * 1024 * 1024; // 300MB
const CACHE_URLS_KEY = 'lurl-cache-urls';

// 緩存策略 - 只緩存 HLS 片段，縮圖直接走網路（小且快）
const CACHE_RULES = {
  m3u8: { maxAge: 60 * 60 * 1000 }, // 1 小時
  segment: { maxAge: 24 * 60 * 60 * 1000 } // 24 小時
};

// 取得 URL 類型 - 只緩存 HLS 相關檔案
function getUrlType(url) {
  if (url.endsWith('.m3u8')) return 'm3u8';
  if (url.endsWith('.ts')) return 'segment';
  return null; // 縮圖、圖片不緩存
}

// LRU 緩存管理
let cacheUrls = [];

async function loadCacheUrls() {
  try {
    const stored = await caches.open(CACHE_NAME).then(c => c.match(CACHE_URLS_KEY));
    if (stored) {
      cacheUrls = await stored.json();
    }
  } catch (e) { cacheUrls = []; }
}

async function saveCacheUrls() {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(CACHE_URLS_KEY, new Response(JSON.stringify(cacheUrls)));
}

async function updateLRU(url, size) {
  // 移除舊的
  cacheUrls = cacheUrls.filter(item => item.url !== url);
  // 加到最前面
  cacheUrls.unshift({ url, size, time: Date.now() });
  // 計算總大小並淘汰
  let totalSize = 0;
  const toKeep = [];
  const toDelete = [];

  for (const item of cacheUrls) {
    if (totalSize + item.size <= MAX_CACHE_SIZE) {
      toKeep.push(item);
      totalSize += item.size;
    } else {
      toDelete.push(item.url);
    }
  }

  // 刪除超出的
  if (toDelete.length > 0) {
    const cache = await caches.open(CACHE_NAME);
    for (const url of toDelete) {
      await cache.delete(url);
    }
  }

  cacheUrls = toKeep;
  await saveCacheUrls();
}

// 安裝
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// 啟動
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      loadCacheUrls(),
      self.clients.claim()
    ])
  );
});

// 攔截請求
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const type = getUrlType(url);

  // 只處理可緩存的類型
  if (!type) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);

      if (cached) {
        // 更新 LRU（不等待）
        const size = parseInt(cached.headers.get('content-length') || '0');
        updateLRU(url, size);
        return cached;
      }

      // 網路請求
      try {
        const response = await fetch(event.request);

        if (response.ok) {
          // 複製 response 來緩存
          const responseToCache = response.clone();
          const size = parseInt(response.headers.get('content-length') || '0');

          // 單檔不超過 50MB 才緩存
          if (size < 50 * 1024 * 1024) {
            cache.put(event.request, responseToCache);
            updateLRU(url, size);
          }
        }

        return response;
      } catch (e) {
        // 網路失敗，嘗試返回緩存
        if (cached) return cached;
        throw e;
      }
    })()
  );
});

// 預載訊息處理
self.addEventListener('message', async (event) => {
  if (event.data.type === 'preload') {
    const urls = event.data.urls || [];
    const cache = await caches.open(CACHE_NAME);

    for (const url of urls) {
      try {
        const cached = await cache.match(url);
        if (!cached) {
          const response = await fetch(url);
          if (response.ok) {
            const size = parseInt(response.headers.get('content-length') || '0');
            if (size < 50 * 1024 * 1024) {
              await cache.put(url, response);
              await updateLRU(url, size);
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    event.source?.postMessage({ type: 'preload-done', count: urls.length });
  }
});
`;
}

// ==================== Landing Page ====================

function landingPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl - 影片備份服務</title>
  <style>
    :root {
      --bg-primary: #f8fafc; --bg-secondary: #ffffff; --bg-accent: #e8f4f8; --bg-section: #f0f9fc;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b; --text-subtle: #94a3b8;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --border: #e2e8f0; --border-light: #d1e9f0;
      --shadow: rgba(0,0,0,0.06); --shadow-md: rgba(0,0,0,0.08);
    }
    [data-theme="dark"] {
      --bg-primary: #0a0a0a; --bg-secondary: #111111; --bg-accent: #1a1a1a; --bg-section: #0f0f0f;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888; --text-subtle: #666666;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --border: #2a2a2a; --border-light: #333333;
      --shadow: rgba(0,0,0,0.5); --shadow-md: rgba(0,0,0,0.6);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; line-height: 1.6; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-secondary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px var(--shadow-md); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header .header-right { display: flex; align-items: center; gap: 12px; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; transition: color 0.2s; }
    .header nav a:hover { color: var(--accent); }
    .header .login-btn { background: var(--accent); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 0.9em; }
    .header .login-btn:hover { background: var(--accent-hover); }
    .theme-toggle { background: var(--bg-accent); border: none; width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .theme-toggle:hover { background: var(--border); }

    .hero { text-align: center; padding: 100px 20px 80px; background: linear-gradient(180deg, var(--bg-accent) 0%, var(--bg-primary) 100%); }
    .hero h2 { font-size: 2.2em; font-weight: 600; margin-bottom: 16px; color: var(--text-primary); }
    .hero .subtitle { font-size: 1.1em; color: var(--text-muted); margin-bottom: 40px; max-width: 500px; margin-left: auto; margin-right: auto; }
    .hero-cta { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn-primary { background: var(--accent); color: white; padding: 12px 24px; border-radius: 8px; font-size: 1em; font-weight: 500; text-decoration: none; transition: all 0.2s; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { background: var(--bg-secondary); color: var(--accent); padding: 12px 24px; border-radius: 8px; font-size: 1em; text-decoration: none; transition: all 0.2s; border: 1px solid var(--border-light); }
    .btn-secondary:hover { background: var(--bg-accent); }

    .section { padding: 60px 20px; max-width: 900px; margin: 0 auto; }
    .section-title { font-size: 1.3em; font-weight: 600; margin-bottom: 30px; color: var(--text-secondary); }
    .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
    .step { background: var(--bg-secondary); border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px var(--shadow); }
    .step-number { width: 36px; height: 36px; background: var(--bg-accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1em; font-weight: 600; margin-bottom: 16px; color: var(--accent); }
    .step h3 { font-size: 1em; font-weight: 500; margin-bottom: 8px; color: var(--text-secondary); }
    .step p { color: var(--text-muted); font-size: 0.9em; }

    .features { background: var(--bg-secondary); border-radius: 12px; padding: 30px; margin-top: 30px; box-shadow: 0 1px 3px var(--shadow); }
    .features h3 { font-size: 1.1em; font-weight: 500; margin-bottom: 20px; color: var(--text-secondary); }
    .features ul { list-style: none; color: var(--text-muted); }
    .features li { margin-bottom: 10px; padding-left: 20px; position: relative; font-size: 0.95em; }
    .features li::before { content: ''; position: absolute; left: 0; top: 8px; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }

    .pricing-section { padding: 60px 20px; background: var(--bg-section); }
    .pricing-section .section-title { text-align: center; margin-bottom: 40px; }
    .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; max-width: 900px; margin: 0 auto 30px; }
    .pricing-card { background: var(--bg-secondary); border-radius: 12px; padding: 24px; border: 1px solid var(--border); }
    .pricing-card.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .pricing-card h4 { font-size: 1em; font-weight: 500; margin-bottom: 8px; color: var(--text-secondary); }
    .pricing-card .price { font-size: 1.5em; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
    .pricing-card .price small { font-size: 0.5em; color: var(--text-subtle); }
    .pricing-card .desc { color: var(--text-muted); font-size: 0.85em; }
    .pricing-cta { display: block; text-align: center; color: var(--accent); text-decoration: none; font-size: 0.95em; margin-top: 20px; }
    .pricing-cta:hover { text-decoration: underline; }

    .footer { background: var(--bg-secondary); padding: 24px 20px; text-align: center; color: var(--text-subtle); font-size: 0.85em; border-top: 1px solid var(--border); }
    .footer-links { margin-bottom: 12px; }
    .footer-links a { color: var(--text-muted); text-decoration: none; margin: 0 12px; }
    .footer-links a:hover { color: var(--accent); }

    @media (max-width: 640px) {
      .hero h2 { font-size: 1.6em; }
      .hero-cta { flex-direction: column; align-items: center; }
      .btn-primary, .btn-secondary { width: 100%; max-width: 280px; text-align: center; }
      .header nav { display: none; }
    }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/" class="logo-title"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing">方案</a>
      <a href="/lurl/guide">教學</a>
    </nav>
    <div class="header-right">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
      <a href="/lurl/login" class="login-btn">登入</a>
    </div>
  </header>

  <section class="hero">
    <h2>那些消失的，我們都記得</h2>
    <p class="subtitle">自動備份 Dcard、PTT 上的圖片和影片，不再錯過任何內容</p>
    <div class="hero-cta">
      <a href="/lurl/download" class="btn-primary">安裝腳本</a>
      <a href="/lurl/browse" class="btn-secondary">瀏覽內容</a>
    </div>
  </section>

  <section class="section">
    <h3 class="section-title">如何使用</h3>
    <div class="steps">
      <div class="step">
        <div class="step-number">1</div>
        <h3>安裝腳本</h3>
        <p>安裝 Tampermonkey 擴充套件和我們的腳本</p>
      </div>
      <div class="step">
        <div class="step-number">2</div>
        <h3>正常瀏覽</h3>
        <p>照常逛 Dcard 或 PTT，腳本會自動運作</p>
      </div>
      <div class="step">
        <div class="step-number">3</div>
        <h3>自動備份</h3>
        <p>瀏覽過的媒體會自動備份到雲端</p>
      </div>
    </div>

    <div class="features">
      <h3>為什麼需要這個？</h3>
      <ul>
        <li>Dcard 圖片 7 天後過期，PTT 更快</li>
        <li>精彩內容錯過就沒了</li>
        <li>我們幫你存著，想看隨時看</li>
      </ul>
    </div>
  </section>

  <section class="pricing-section">
    <h3 class="section-title">方案</h3>
    <div class="pricing-grid">
      <div class="pricing-card">
        <h4>免費</h4>
        <div class="price">$0</div>
        <p class="desc">每月 3 點額度</p>
      </div>
      <div class="pricing-card">
        <h4>額度包</h4>
        <div class="price">$199<small>/月</small></div>
        <p class="desc">每月 20 點額度</p>
      </div>
      <div class="pricing-card">
        <h4>會員</h4>
        <div class="price">$599<small>/月</small></div>
        <p class="desc">24h 內完整存取</p>
      </div>
      <div class="pricing-card featured">
        <h4>進階會員</h4>
        <div class="price">$899<small>/月</small></div>
        <p class="desc">全資料庫存取</p>
      </div>
    </div>
    <a href="/lurl/pricing" class="pricing-cta">查看完整方案</a>
  </section>

  <footer class="footer">
    <div class="footer-links">
      <a href="/lurl/feedback">意見回饋</a>
      <a href="/lurl/guide">使用教學</a>
      <a href="/lurl/pricing">方案</a>
    </div>
    <div>© 2026 Lurl</div>
  </footer>
  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.querySelector('.theme-toggle').textContent = '☀️';
      }
    })();
  </script>
</body>
</html>`;
}

// ==================== Download Page ====================

function downloadPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>下載腳本 - Lurl</title>
  <style>
    :root {
      --bg-primary: #f8fafc; --bg-secondary: #ffffff; --bg-accent: #e8f4f8; --bg-section: #f0f9fc;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b; --text-subtle: #94a3b8;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --border: #e2e8f0; --border-light: #d1e9f0;
      --shadow: rgba(0,0,0,0.06); --shadow-md: rgba(0,0,0,0.08);
    }
    [data-theme="dark"] {
      --bg-primary: #0a0a0a; --bg-secondary: #111111; --bg-accent: #1a1a1a; --bg-section: #0f0f0f;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888; --text-subtle: #666666;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --border: #2a2a2a; --border-light: #333333;
      --shadow: rgba(0,0,0,0.5); --shadow-md: rgba(0,0,0,0.6);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; line-height: 1.6; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-secondary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px var(--shadow-md); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header .header-right { display: flex; align-items: center; gap: 12px; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; transition: color 0.2s; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .header .login-btn { background: var(--accent); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 0.9em; }
    .header .login-btn:hover { background: var(--accent-hover); }
    .theme-toggle { background: var(--bg-accent); border: none; width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .theme-toggle:hover { background: var(--border); }
    .container { max-width: 600px; margin: 0 auto; padding: 60px 20px; }
    .page-header { margin-bottom: 40px; }
    .page-header h2 { font-size: 1.5em; font-weight: 600; margin-bottom: 8px; color: var(--text-primary); }
    .page-header .version { color: var(--text-subtle); font-size: 0.9em; }
    .card { background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px var(--shadow); }
    .card.notice { border: 1px solid var(--border-light); background: var(--bg-section); }
    .card h3 { margin-bottom: 12px; font-size: 1em; font-weight: 500; color: var(--text-secondary); }
    .card p { color: var(--text-muted); font-size: 0.9em; margin-bottom: 12px; }
    .card a { color: var(--accent); text-decoration: none; }
    .card a:hover { text-decoration: underline; }
    .install-btn { display: block; width: 100%; padding: 14px; background: var(--accent); color: white; border: none; border-radius: 8px; font-size: 1em; font-weight: 500; cursor: pointer; text-decoration: none; text-align: center; transition: all 0.2s; }
    .install-btn:hover { background: var(--accent-hover); }
    .install-btn span { font-size: 0.85em; font-weight: 400; opacity: 0.8; display: block; margin-top: 4px; }
    .manual-link { text-align: center; color: var(--text-subtle); margin-top: 12px; font-size: 0.9em; }
    .support-list { list-style: none; }
    .support-list li { padding: 10px 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; font-size: 0.9em; color: var(--text-muted); }
    .support-list li:last-child { border-bottom: none; }
    .support-list .status { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; }
    .support-list .pending { background: var(--text-subtle); }
    .changelog { color: var(--text-muted); font-size: 0.9em; list-style: none; }
    .changelog li { margin-bottom: 8px; }
    .changelog strong { color: var(--text-secondary); }
    .footer { background: var(--bg-secondary); padding: 24px 20px; text-align: center; color: var(--text-subtle); font-size: 0.85em; margin-top: 60px; border-top: 1px solid var(--border); }
    .footer-links { margin-bottom: 12px; }
    .footer-links a { color: var(--text-muted); text-decoration: none; margin: 0 12px; }
    .footer-links a:hover { color: var(--accent); }
    @media (max-width: 640px) { .header nav { display: none; } }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/" class="logo-title"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing">方案</a>
      <a href="/lurl/guide" class="active">教學</a>
    </nav>
    <div class="header-right">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
      <a href="/lurl/login" class="login-btn">登入</a>
    </div>
  </header>

  <main class="container">
    <div class="page-header">
      <h2>下載腳本</h2>
      <p class="version">v1.2.0 | 2026-01-22</p>
    </div>

    <div class="card notice">
      <h3>需要先安裝 Tampermonkey</h3>
      <p>這是讓腳本運作的瀏覽器擴充套件</p>
      <p>
        <a href="https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo" target="_blank">Chrome</a> ·
        <a href="https://addons.mozilla.org/firefox/addon/tampermonkey/" target="_blank">Firefox</a> ·
        <a href="https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd" target="_blank">Edge</a>
      </p>
    </div>

    <div class="card">
      <a href="https://greasyfork.org/scripts/your-script" target="_blank" class="install-btn">
        安裝腳本
        <span>GreasyFork</span>
      </a>
      <p class="manual-link">或 <a href="#">下載 .user.js 檔案</a></p>
    </div>

    <div class="card">
      <h3>支援網站</h3>
      <ul class="support-list">
        <li><span class="status"></span> Dcard (MyPTT)</li>
        <li><span class="status"></span> Lurl</li>
        <li><span class="status pending"></span> 更多開發中</li>
      </ul>
    </div>

    <div class="card">
      <h3>更新日誌</h3>
      <ul class="changelog">
        <li><strong>v1.2.0</strong> - 會員登入功能</li>
        <li><strong>v1.1.0</strong> - HLS 串流備份</li>
        <li><strong>v1.0.0</strong> - 首次發布</li>
      </ul>
    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="/lurl/feedback">意見回饋</a>
      <a href="/lurl/guide">使用教學</a>
      <a href="/lurl/pricing">方案</a>
    </div>
    <div>© 2026 Lurl</div>
  </footer>
  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.querySelector('.theme-toggle').textContent = '☀️';
      }
    })();
  </script>
</body>
</html>`;
}

// ==================== Pricing Page ====================

function pricingPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>方案 - Lurl</title>
  <style>
    :root {
      --bg-primary: #f8fafc; --bg-secondary: #ffffff; --bg-accent: #e8f4f8; --bg-section: #f0f9fc;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b; --text-subtle: #94a3b8;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --border: #e2e8f0; --border-light: #d1e9f0;
      --shadow: rgba(0,0,0,0.06); --shadow-md: rgba(0,0,0,0.08); --btn-bg: #f1f5f9; --btn-bg-hover: #e2e8f0;
    }
    [data-theme="dark"] {
      --bg-primary: #0a0a0a; --bg-secondary: #111111; --bg-accent: #1a1a1a; --bg-section: #0f0f0f;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888; --text-subtle: #666666;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --border: #2a2a2a; --border-light: #333333;
      --shadow: rgba(0,0,0,0.5); --shadow-md: rgba(0,0,0,0.6); --btn-bg: #2a2a2a; --btn-bg-hover: #3a3a3a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; line-height: 1.6; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-secondary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px var(--shadow-md); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header .header-right { display: flex; align-items: center; gap: 12px; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; transition: color 0.2s; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .header .login-btn { background: var(--accent); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 0.9em; }
    .header .login-btn:hover { background: var(--accent-hover); }
    .theme-toggle { background: var(--bg-accent); border: none; width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .theme-toggle:hover { background: var(--border); }
    .container { max-width: 900px; margin: 0 auto; padding: 60px 20px; }
    .page-header { margin-bottom: 40px; }
    .page-header h2 { font-size: 1.5em; font-weight: 600; margin-bottom: 8px; color: var(--text-primary); }
    .page-header p { color: var(--text-muted); font-size: 0.9em; }
    .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 40px; }
    .plan { background: var(--bg-secondary); border-radius: 12px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 1px 3px var(--shadow); }
    .plan.featured { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .plan-name { font-size: 1em; font-weight: 500; margin-bottom: 8px; color: var(--text-secondary); }
    .plan-price { font-size: 1.8em; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
    .plan-price small { font-size: 0.5em; color: var(--text-subtle); }
    .plan-quota { color: var(--text-muted); font-size: 0.85em; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    .plan-features { list-style: none; margin-bottom: 20px; font-size: 0.9em; }
    .plan-features li { padding: 6px 0; color: var(--text-muted); padding-left: 16px; position: relative; }
    .plan-features li::before { content: ''; position: absolute; left: 0; top: 12px; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
    .plan-btn { display: block; width: 100%; padding: 10px; background: var(--btn-bg); color: var(--text-muted); border: none; border-radius: 8px; font-size: 0.9em; cursor: pointer; text-decoration: none; text-align: center; transition: all 0.2s; }
    .plan-btn:hover { background: var(--btn-bg-hover); color: var(--text-secondary); }
    .plan.featured .plan-btn { background: var(--accent); color: white; }
    .plan.featured .plan-btn:hover { background: var(--accent-hover); }
    .enterprise { background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 40px; border: 1px solid var(--border); box-shadow: 0 1px 3px var(--shadow); }
    .enterprise h3 { font-size: 1.1em; font-weight: 500; margin-bottom: 8px; color: var(--text-secondary); }
    .enterprise .price { color: var(--text-primary); font-size: 1.3em; font-weight: 600; margin-bottom: 16px; }
    .enterprise ul { list-style: none; color: var(--text-muted); margin-bottom: 16px; font-size: 0.9em; }
    .enterprise li { padding: 6px 0; padding-left: 16px; position: relative; }
    .enterprise li::before { content: ''; position: absolute; left: 0; top: 12px; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
    .enterprise .target { color: var(--text-subtle); font-size: 0.85em; margin-bottom: 16px; }
    .enterprise .contact-btn { display: inline-block; padding: 10px 20px; background: var(--btn-bg); color: var(--text-muted); border-radius: 8px; text-decoration: none; font-size: 0.9em; }
    .enterprise .contact-btn:hover { background: var(--btn-bg-hover); color: var(--text-secondary); }
    .faq { background: var(--bg-secondary); border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px var(--shadow); }
    .faq h3 { font-size: 1.1em; font-weight: 500; margin-bottom: 20px; color: var(--text-secondary); }
    .faq-item { margin-bottom: 16px; }
    .faq-item:last-child { margin-bottom: 0; }
    .faq-q { font-weight: 500; margin-bottom: 4px; font-size: 0.95em; color: var(--text-secondary); }
    .faq-a { color: var(--text-muted); font-size: 0.9em; }
    .footer { background: var(--bg-secondary); padding: 24px 20px; text-align: center; color: var(--text-subtle); font-size: 0.85em; margin-top: 60px; border-top: 1px solid var(--border); }
    .footer-links { margin-bottom: 12px; }
    .footer-links a { color: var(--text-muted); text-decoration: none; margin: 0 12px; }
    .footer-links a:hover { color: var(--accent); }
    @media (max-width: 640px) { .header nav { display: none; } .plan-price { font-size: 1.5em; } }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/" class="logo-title"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing" class="active">方案</a>
      <a href="/lurl/guide">教學</a>
    </nav>
    <div class="header-right">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
      <a href="/lurl/login" class="login-btn">登入</a>
    </div>
  </header>

  <main class="container">
    <div class="page-header">
      <h2>方案</h2>
      <p>選擇適合的方案，或先用免費版試試</p>
    </div>

    <div class="pricing-grid">
      <div class="plan">
        <div class="plan-name">免費</div>
        <div class="plan-price">$0</div>
        <div class="plan-quota">3 點/月</div>
        <ul class="plan-features">
          <li>預覽內容</li>
          <li>腳本備份</li>
          <li>額度恢復過期資源</li>
        </ul>
        <a href="/lurl/download" class="plan-btn">開始使用</a>
      </div>

      <div class="plan">
        <div class="plan-name">額度包</div>
        <div class="plan-price">$199<small>/月</small></div>
        <div class="plan-quota">20 點/月</div>
        <ul class="plan-features">
          <li>預覽內容</li>
          <li>更多額度</li>
          <li>不需註冊</li>
        </ul>
        <a href="#" class="plan-btn">訂閱</a>
      </div>

      <div class="plan">
        <div class="plan-name">會員</div>
        <div class="plan-price">$599<small>/月</small></div>
        <div class="plan-quota">30 點/月</div>
        <ul class="plan-features">
          <li>24h 內完整存取</li>
          <li>觀看歷史</li>
          <li>下載記錄</li>
        </ul>
        <a href="#" class="plan-btn">訂閱</a>
      </div>

      <div class="plan featured">
        <div class="plan-name">進階會員</div>
        <div class="plan-price">$899<small>/月</small></div>
        <div class="plan-quota">無限</div>
        <ul class="plan-features">
          <li>全資料庫存取</li>
          <li>收藏/相簿</li>
          <li>隱藏內容</li>
          <li>標籤訂閱</li>
        </ul>
        <a href="#" class="plan-btn">訂閱</a>
      </div>
    </div>

    <div class="enterprise">
      <h3>自架方案</h3>
      <div class="price">$6,999 一次性</div>
      <ul>
        <li>完整源碼</li>
        <li>私有資料庫</li>
        <li>部署協助 + 1 個月技術支援</li>
      </ul>
      <p class="target">適合工作室、重度使用者</p>
      <a href="/lurl/feedback" class="contact-btn">聯繫購買</a>
    </div>

    <div class="faq">
      <h3>常見問題</h3>
      <div class="faq-item">
        <div class="faq-q">額度是什麼？</div>
        <div class="faq-a">用來恢復過期資源。當原始連結失效時，可用額度從備份存取。</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">會員和額度包的差別？</div>
        <div class="faq-a">會員可直接看 24 小時內的新內容，不消耗額度。額度包只能恢復過期資源。</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">可以退費嗎？</div>
        <div class="faq-a">訂閱後 7 天內未使用可全額退費。</div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="/lurl/feedback">意見回饋</a>
      <a href="/lurl/guide">使用教學</a>
    </div>
    <div>© 2026 Lurl</div>
  </footer>
  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.querySelector('.theme-toggle').textContent = '☀️';
      }
    })();
  </script>
</body>
</html>`;
}

// ==================== Guide Page ====================

function guidePage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>使用教學 - Lurl</title>
  <style>
    :root {
      --bg-primary: #f8fafc; --bg-secondary: #ffffff; --bg-accent: #e8f4f8; --bg-section: #f0f9fc;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b; --text-subtle: #94a3b8;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --border: #e2e8f0; --border-light: #d1e9f0;
      --shadow: rgba(0,0,0,0.06); --shadow-md: rgba(0,0,0,0.08); --btn-bg: #f1f5f9; --btn-bg-hover: #e2e8f0;
    }
    [data-theme="dark"] {
      --bg-primary: #0a0a0a; --bg-secondary: #111111; --bg-accent: #1a1a1a; --bg-section: #0f0f0f;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888; --text-subtle: #666666;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --border: #2a2a2a; --border-light: #333333;
      --shadow: rgba(0,0,0,0.5); --shadow-md: rgba(0,0,0,0.6); --btn-bg: #2a2a2a; --btn-bg-hover: #3a3a3a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; line-height: 1.6; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-secondary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px var(--shadow-md); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header .header-right { display: flex; align-items: center; gap: 12px; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; transition: color 0.2s; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .header .login-btn { background: var(--accent); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 0.9em; }
    .header .login-btn:hover { background: var(--accent-hover); }
    .theme-toggle { background: var(--bg-accent); border: none; width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .theme-toggle:hover { background: var(--border); }
    .container { max-width: 600px; margin: 0 auto; padding: 60px 20px; }
    .page-header { margin-bottom: 40px; }
    .page-header h2 { font-size: 1.5em; font-weight: 600; color: var(--text-primary); }
    .step-section { background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px var(--shadow); }
    .step-section h3 { font-size: 1em; font-weight: 500; margin-bottom: 12px; color: var(--text-secondary); }
    .step-section p { color: var(--text-muted); font-size: 0.9em; margin-bottom: 12px; }
    .step-section a { color: var(--accent); text-decoration: none; }
    .step-section a:hover { text-decoration: underline; }
    .browser-links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .browser-links a { padding: 8px 12px; background: var(--btn-bg); border-radius: 6px; color: var(--text-muted); text-decoration: none; font-size: 0.85em; }
    .browser-links a:hover { background: var(--btn-bg-hover); color: var(--text-secondary); }
    .features { background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px var(--shadow); }
    .features h3 { font-size: 1em; font-weight: 500; margin-bottom: 16px; color: var(--text-secondary); }
    .features ul { list-style: none; color: var(--text-muted); font-size: 0.9em; }
    .features li { padding: 6px 0; padding-left: 16px; position: relative; }
    .features li::before { content: ''; position: absolute; left: 0; top: 12px; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
    .trouble { background: var(--bg-secondary); border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px var(--shadow); }
    .trouble h3 { font-size: 1em; font-weight: 500; margin-bottom: 16px; color: var(--text-secondary); }
    .trouble-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .trouble-item:last-child { border-bottom: none; }
    .trouble-q { color: var(--text-secondary); font-size: 0.9em; margin-bottom: 4px; }
    .trouble-a { color: var(--text-muted); font-size: 0.85em; }
    .trouble-a a { color: var(--accent); text-decoration: none; }
    .trouble-a a:hover { text-decoration: underline; }
    .footer { background: var(--bg-secondary); padding: 24px 20px; text-align: center; color: var(--text-subtle); font-size: 0.85em; margin-top: 60px; border-top: 1px solid var(--border); }
    .footer-links { margin-bottom: 12px; }
    .footer-links a { color: var(--text-muted); text-decoration: none; margin: 0 12px; }
    .footer-links a:hover { color: var(--accent); }
    @media (max-width: 640px) { .header nav { display: none; } }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/" class="logo-title"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing">方案</a>
      <a href="/lurl/guide" class="active">教學</a>
    </nav>
    <div class="header-right">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
      <a href="/lurl/login" class="login-btn">登入</a>
    </div>
  </header>

  <main class="container">
    <div class="page-header">
      <h2>使用教學</h2>
    </div>

    <section class="step-section">
      <h3>1. 安裝 Tampermonkey</h3>
      <p>瀏覽器擴充套件，讓腳本能運作</p>
      <div class="browser-links">
        <a href="https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo" target="_blank">Chrome</a>
        <a href="https://addons.mozilla.org/firefox/addon/tampermonkey/" target="_blank">Firefox</a>
        <a href="https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd" target="_blank">Edge</a>
      </div>
    </section>

    <section class="step-section">
      <h3>2. 安裝 Lurl 腳本</h3>
      <p><a href="https://greasyfork.org/scripts/your-script" target="_blank">從 GreasyFork 安裝</a></p>
      <p>點擊連結後按下安裝按鈕即可</p>
    </section>

    <section class="step-section">
      <h3>3. 開始使用</h3>
      <p>正常瀏覽 Dcard 或 PTT，腳本會自動備份圖片和影片</p>
      <p>備份完成後會在右下角顯示通知</p>
    </section>

    <div class="features">
      <h3>進階功能</h3>
      <ul>
        <li>手動備份：點擊腳本按鈕強制備份當前頁面</li>
        <li>查看額度：腳本面板顯示剩餘額度</li>
        <li>會員登入：在腳本面板登入解鎖更多功能</li>
      </ul>
    </div>

    <div class="trouble">
      <h3>常見問題</h3>
      <div class="trouble-item">
        <div class="trouble-q">腳本沒反應</div>
        <div class="trouble-a">重新整理頁面試試</div>
      </div>
      <div class="trouble-item">
        <div class="trouble-q">備份失敗</div>
        <div class="trouble-a">可能原始連結已失效</div>
      </div>
      <div class="trouble-item">
        <div class="trouble-q">其他問題</div>
        <div class="trouble-a"><a href="/lurl/feedback">回報問題</a></div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="/lurl/feedback">意見回饋</a>
      <a href="/lurl/pricing">方案</a>
    </div>
    <div>© 2026 Lurl</div>
  </footer>
  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.querySelector('.theme-toggle').textContent = '☀️';
      }
    })();
  </script>
</body>
</html>`;
}

// ==================== Feedback Page ====================

function feedbackPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>意見回饋 - Lurl</title>
  <style>
    :root {
      --bg-primary: #f8fafc; --bg-secondary: #ffffff; --bg-accent: #e8f4f8; --bg-section: #f0f9fc;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b; --text-subtle: #94a3b8;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --border: #e2e8f0; --border-light: #d1e9f0;
      --shadow: rgba(0,0,0,0.06); --shadow-md: rgba(0,0,0,0.08); --btn-disabled: #cbd5e1;
    }
    [data-theme="dark"] {
      --bg-primary: #0a0a0a; --bg-secondary: #111111; --bg-accent: #1a1a1a; --bg-section: #0f0f0f;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888; --text-subtle: #666666;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --border: #2a2a2a; --border-light: #333333;
      --shadow: rgba(0,0,0,0.5); --shadow-md: rgba(0,0,0,0.6); --btn-disabled: #3a3a3a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; line-height: 1.6; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-secondary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px var(--shadow-md); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header .header-right { display: flex; align-items: center; gap: 12px; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; transition: color 0.2s; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .header .login-btn { background: var(--accent); color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-size: 0.9em; }
    .header .login-btn:hover { background: var(--accent-hover); }
    .theme-toggle { background: var(--bg-accent); border: none; width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 1.1em; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .theme-toggle:hover { background: var(--border); }
    .container { max-width: 500px; margin: 0 auto; padding: 60px 20px; }
    .page-header { margin-bottom: 30px; }
    .page-header h2 { font-size: 1.5em; font-weight: 600; margin-bottom: 8px; color: var(--text-primary); }
    .page-header p { color: var(--text-muted); font-size: 0.9em; }
    .form-card { background: var(--bg-secondary); border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px var(--shadow); }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 8px; font-size: 0.9em; color: var(--text-secondary); }
    .form-group select, .form-group input, .form-group textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 0.9em;
      font-family: inherit;
    }
    .form-group select:focus, .form-group input:focus, .form-group textarea:focus { border-color: var(--accent); outline: none; background: var(--bg-secondary); }
    .form-group textarea { min-height: 120px; resize: vertical; }
    .form-group .hint { color: var(--text-subtle); font-size: 0.8em; margin-top: 4px; }
    .submit-btn {
      width: 100%;
      padding: 12px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 0.95em;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .submit-btn:hover { background: var(--accent-hover); }
    .submit-btn:disabled { background: var(--btn-disabled); color: var(--text-subtle); cursor: not-allowed; }
    .other-channels { background: var(--bg-secondary); border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px var(--shadow); }
    .other-channels h3 { font-size: 1em; font-weight: 500; margin-bottom: 12px; color: var(--text-secondary); }
    .other-channels ul { list-style: none; color: var(--text-muted); font-size: 0.9em; }
    .other-channels li { padding: 6px 0; padding-left: 16px; position: relative; }
    .other-channels li::before { content: ''; position: absolute; left: 0; top: 12px; width: 6px; height: 6px; background: var(--accent); border-radius: 50%; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: var(--accent); color: white; padding: 12px 20px; border-radius: 8px; font-size: 0.9em; opacity: 0; transform: translateY(20px); transition: all 0.3s; z-index: 1000; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: #ef4444; }
    .footer { background: var(--bg-secondary); padding: 24px 20px; text-align: center; color: var(--text-subtle); font-size: 0.85em; margin-top: 60px; border-top: 1px solid var(--border); }
    .footer-links { margin-bottom: 12px; }
    .footer-links a { color: var(--text-muted); text-decoration: none; margin: 0 12px; }
    .footer-links a:hover { color: var(--accent); }
    @media (max-width: 640px) { .header nav { display: none; } }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/" class="logo-title"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing">方案</a>
      <a href="/lurl/guide">教學</a>
    </nav>
    <div class="header-right">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
      <a href="/lurl/login" class="login-btn">登入</a>
    </div>
  </header>

  <main class="container">
    <div class="page-header">
      <h2>意見回饋</h2>
      <p>Bug、建議、問題回報</p>
    </div>

    <form class="form-card" id="feedbackForm">
      <div class="form-group">
        <label for="type">類型</label>
        <select id="type" name="type" required>
          <option value="">選擇類型</option>
          <option value="bug">Bug 回報</option>
          <option value="feature">功能建議</option>
          <option value="payment">付費問題</option>
          <option value="other">其他</option>
        </select>
      </div>

      <div class="form-group">
        <label for="message">內容</label>
        <textarea id="message" name="message" placeholder="描述你遇到的問題或建議" required></textarea>
      </div>

      <div class="form-group">
        <label for="contact">聯絡方式（選填）</label>
        <input type="text" id="contact" name="contact" placeholder="Email">
        <p class="hint">留下聯絡方式方便回覆</p>
      </div>

      <button type="submit" class="submit-btn">送出</button>
    </form>

    <div class="other-channels">
      <h3>其他管道</h3>
      <ul>
        <li>GreasyFork 腳本頁留言</li>
      </ul>
    </div>
  </main>

  <div class="toast" id="toast"></div>

  <footer class="footer">
    <div class="footer-links">
      <a href="/lurl/guide">使用教學</a>
      <a href="/lurl/pricing">方案</a>
    </div>
    <div>© 2026 Lurl</div>
  </footer>

  <script>
    const form = document.getElementById('feedbackForm');
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => toast.className = 'toast', 3000);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.submit-btn');
      btn.disabled = true;
      btn.textContent = '送出中...';

      try {
        const data = {
          type: form.type.value,
          message: form.message.value,
          contact: form.contact.value,
          timestamp: new Date().toISOString()
        };

        const res = await fetch('/lurl/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (res.ok) {
          showToast('感謝回饋');
          form.reset();
        } else {
          throw new Error('送出失敗');
        }
      } catch (err) {
        showToast('送出失敗', true);
      } finally {
        btn.disabled = false;
        btn.textContent = '送出';
      }
    });

    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.querySelector('.theme-toggle').textContent = '☀️';
      }
    })();
  </script>
</body>
</html>`;
}

// ==================== Member Login Page ====================

function memberLoginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>會員登入 - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; display: flex; flex-direction: column; }
    .header { background: #1a1a2e; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo { height: 36px; width: auto; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
    .auth-card { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 400px; width: 100%; }
    .auth-card h2 { text-align: center; margin-bottom: 30px; font-size: 1.8em; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; margin-bottom: 8px; color: #aaa; font-size: 0.9em; }
    .form-group input {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #333;
      border-radius: 8px;
      background: #0f0f0f;
      color: white;
      font-size: 1em;
    }
    .form-group input:focus { border-color: #3b82f6; outline: none; }
    .submit-btn {
      width: 100%;
      padding: 14px;
      background: #4ade80;
      color: #000;
      border: none;
      border-radius: 8px;
      font-size: 1.1em;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
    }
    .submit-btn:hover { background: #22c55e; }
    .submit-btn:disabled { background: #333; color: #888; cursor: not-allowed; }
    .auth-links { text-align: center; margin-top: 24px; color: #888; font-size: 0.9em; }
    .auth-links a { color: #3b82f6; text-decoration: none; }
    .auth-links a:hover { text-decoration: underline; }
    .error-msg { background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.9em; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #4ade80; color: #000; padding: 16px 24px; border-radius: 8px; font-weight: 500; opacity: 0; transform: translateY(20px); transition: all 0.3s; z-index: 1000; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: #ef4444; color: white; }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing">方案</a>
    </nav>
  </header>

  <main class="main">
    <div class="auth-card">
      <h2>🔐 會員登入</h2>
      ${error ? `<div class="error-msg">${error}</div>` : ''}
      <form id="loginForm">
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required placeholder="your@email.com">
        </div>
        <div class="form-group">
          <label for="password">密碼</label>
          <input type="password" id="password" name="password" required placeholder="••••••••">
        </div>
        <button type="submit" class="submit-btn">登入</button>
      </form>
      <div class="auth-links">
        還沒有帳號？<a href="/lurl/member/register">立即註冊</a>
      </div>
    </div>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    const form = document.getElementById('loginForm');
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => toast.className = 'toast', 3000);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.submit-btn');
      btn.disabled = true;
      btn.textContent = '登入中...';

      try {
        const res = await fetch('/lurl/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: form.email.value,
            password: form.password.value
          })
        });

        const data = await res.json();
        if (data.ok) {
          showToast('登入成功！');
          setTimeout(() => window.location.href = '/lurl/browse', 1000);
        } else {
          showToast(data.error || '登入失敗', true);
        }
      } catch (err) {
        showToast('網路錯誤，請稍後再試', true);
      } finally {
        btn.disabled = false;
        btn.textContent = '登入';
      }
    });
  </script>
</body>
</html>`;
}

// ==================== Member Register Page ====================

function memberRegisterPage(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>會員註冊 - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; display: flex; flex-direction: column; }
    .header { background: #1a1a2e; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo { height: 36px; width: auto; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
    .auth-card { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 400px; width: 100%; }
    .auth-card h2 { text-align: center; margin-bottom: 30px; font-size: 1.8em; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; margin-bottom: 8px; color: #aaa; font-size: 0.9em; }
    .form-group input {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #333;
      border-radius: 8px;
      background: #0f0f0f;
      color: white;
      font-size: 1em;
    }
    .form-group input:focus { border-color: #3b82f6; outline: none; }
    .form-group .hint { color: #666; font-size: 0.8em; margin-top: 4px; }
    .submit-btn {
      width: 100%;
      padding: 14px;
      background: #4ade80;
      color: #000;
      border: none;
      border-radius: 8px;
      font-size: 1.1em;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
    }
    .submit-btn:hover { background: #22c55e; }
    .submit-btn:disabled { background: #333; color: #888; cursor: not-allowed; }
    .auth-links { text-align: center; margin-top: 24px; color: #888; font-size: 0.9em; }
    .auth-links a { color: #3b82f6; text-decoration: none; }
    .auth-links a:hover { text-decoration: underline; }
    .error-msg { background: rgba(239,68,68,0.1); border: 1px solid #ef4444; color: #ef4444; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.9em; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: #4ade80; color: #000; padding: 16px 24px; border-radius: 8px; font-weight: 500; opacity: 0; transform: translateY(20px); transition: all 0.3s; z-index: 1000; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: #ef4444; color: white; }
    .benefits { background: #252525; border-radius: 8px; padding: 16px; margin-bottom: 24px; font-size: 0.9em; }
    .benefits h4 { color: #4ade80; margin-bottom: 8px; }
    .benefits ul { list-style: none; color: #aaa; }
    .benefits li { padding: 4px 0; }
    .benefits li::before { content: '✓'; color: #4ade80; margin-right: 8px; }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/pricing">方案</a>
    </nav>
  </header>

  <main class="main">
    <div class="auth-card">
      <h2>✨ 加入會員</h2>
      <div class="benefits">
        <h4>免費會員福利</h4>
        <ul>
          <li>每月 3 點額度</li>
          <li>使用腳本備份內容</li>
          <li>瀏覽所有預覽</li>
        </ul>
      </div>
      ${error ? `<div class="error-msg">${error}</div>` : ''}
      <form id="registerForm">
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required placeholder="your@email.com">
        </div>
        <div class="form-group">
          <label for="nickname">暱稱（選填）</label>
          <input type="text" id="nickname" name="nickname" placeholder="你想怎麼被稱呼">
        </div>
        <div class="form-group">
          <label for="password">密碼</label>
          <input type="password" id="password" name="password" required placeholder="至少 6 個字元" minlength="6">
          <p class="hint">密碼至少需要 6 個字元</p>
        </div>
        <button type="submit" class="submit-btn">註冊</button>
      </form>
      <div class="auth-links">
        已有帳號？<a href="/lurl/login">登入</a>
      </div>
    </div>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    const form = document.getElementById('registerForm');
    const toast = document.getElementById('toast');

    function showToast(message, isError = false) {
      toast.textContent = message;
      toast.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(() => toast.className = 'toast', 3000);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.submit-btn');
      btn.disabled = true;
      btn.textContent = '註冊中...';

      try {
        const res = await fetch('/lurl/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: form.email.value,
            password: form.password.value,
            nickname: form.nickname.value
          })
        });

        const data = await res.json();
        if (data.ok) {
          showToast('註冊成功！');
          setTimeout(() => window.location.href = '/lurl/browse', 1000);
        } else {
          showToast(data.error || '註冊失敗', true);
        }
      } catch (err) {
        showToast('網路錯誤，請稍後再試', true);
      } finally {
        btn.disabled = false;
        btn.textContent = '註冊';
      }
    });
  </script>
</body>
</html>`;
}

// ==================== Member Quota Page ====================

function memberQuotaPage(user) {
  const tierNames = { free: '免費仔', basic: '會員', premium: '老司機' };
  const tierQuotas = { free: 3, basic: 30, premium: -1 };
  const tierName = tierNames[user.tier] || '免費仔';
  const monthlyQuota = tierQuotas[user.tier] || 3;
  const isUnlimited = user.tier === 'premium';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>我的額度 - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo { height: 36px; width: auto; }
    .header nav { display: flex; gap: 20px; align-items: center; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .header nav a.active { color: white; }
    .header .user-info { display: flex; align-items: center; gap: 12px; }
    .header .user-info .nickname { color: #4ade80; font-weight: 500; }
    .header .logout-btn { color: #888; font-size: 0.85em; cursor: pointer; }
    .header .logout-btn:hover { color: #ef4444; }
    .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
    .page-header { margin-bottom: 40px; }
    .page-header h2 { font-size: 1.8em; margin-bottom: 8px; }
    .page-header p { color: #888; }
    .quota-card { background: linear-gradient(135deg, #1a2e1a 0%, #1a1a1a 100%); border: 2px solid #4ade80; border-radius: 16px; padding: 40px; text-align: center; margin-bottom: 30px; }
    .quota-card .tier-badge { display: inline-block; background: #4ade80; color: #000; padding: 6px 16px; border-radius: 20px; font-weight: 600; margin-bottom: 20px; }
    .quota-card .quota-display { font-size: 4em; font-weight: 700; color: #4ade80; margin-bottom: 10px; }
    .quota-card .quota-label { color: #888; font-size: 1.1em; }
    .quota-card .unlimited { font-size: 2em; color: #4ade80; }
    .info-card { background: #1a1a1a; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .info-card h3 { margin-bottom: 16px; font-size: 1.2em; }
    .info-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #333; }
    .info-row:last-child { border-bottom: none; }
    .info-row .label { color: #888; }
    .info-row .value { font-weight: 500; }
    .upgrade-section { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 12px; padding: 30px; text-align: center; }
    .upgrade-section h3 { margin-bottom: 12px; }
    .upgrade-section p { color: #888; margin-bottom: 20px; }
    .upgrade-btn { display: inline-block; background: #3b82f6; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500; }
    .upgrade-btn:hover { background: #2563eb; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #888; text-decoration: none; }
    .back-link:hover { color: white; }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/member/history">歷史</a>
      <a href="/lurl/member/quota" class="active">額度</a>
      <a href="/lurl/member/profile">個人</a>
      <div class="user-info">
        <span class="nickname">${user.nickname || user.email.split('@')[0]}</span>
        <span class="logout-btn" onclick="logout()">登出</span>
      </div>
    </nav>
  </header>

  <main class="container">
    <a href="/lurl/browse" class="back-link">← 返回瀏覽</a>

    <div class="page-header">
      <h2>💰 我的額度</h2>
      <p>查看你的會員狀態和剩餘額度</p>
    </div>

    <div class="quota-card">
      <div class="tier-badge">${tierName}</div>
      ${isUnlimited
        ? `<div class="unlimited">∞ 無限</div>
           <div class="quota-label">全資料庫完整存取</div>`
        : `<div class="quota-display">${user.quotaBalance}</div>
           <div class="quota-label">剩餘額度（每月 ${monthlyQuota} 點）</div>`
      }
    </div>

    <div class="info-card">
      <h3>📋 帳號資訊</h3>
      <div class="info-row">
        <span class="label">Email</span>
        <span class="value">${user.email}</span>
      </div>
      <div class="info-row">
        <span class="label">暱稱</span>
        <span class="value">${user.nickname || '-'}</span>
      </div>
      <div class="info-row">
        <span class="label">會員等級</span>
        <span class="value">${tierName}</span>
      </div>
      <div class="info-row">
        <span class="label">加入時間</span>
        <span class="value">${new Date(user.createdAt).toLocaleDateString('zh-TW')}</span>
      </div>
      ${user.tierExpiry ? `
      <div class="info-row">
        <span class="label">會員到期</span>
        <span class="value">${new Date(user.tierExpiry).toLocaleDateString('zh-TW')}</span>
      </div>
      ` : ''}
    </div>

    ${user.tier !== 'premium' ? `
    <div class="upgrade-section">
      <h3>🚀 升級會員</h3>
      <p>升級後可享有更多額度和完整存取權限</p>
      <a href="/lurl/pricing" class="upgrade-btn">查看方案</a>
    </div>
    ` : ''}
  </main>

  <script>
    async function logout() {
      await fetch('/lurl/api/auth/logout', { method: 'POST' });
      window.location.href = '/lurl/';
    }
  </script>
</body>
</html>`;
}

// ==================== Member History Page ====================

function memberHistoryPage(user) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>觀看歷史 - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo { height: 36px; width: auto; }
    .header nav { display: flex; gap: 20px; align-items: center; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .header nav a.active { color: white; }
    .header .user-info { display: flex; align-items: center; gap: 12px; }
    .header .user-info .nickname { color: #4ade80; font-weight: 500; }
    .header .logout-btn { color: #888; font-size: 0.85em; cursor: pointer; }
    .header .logout-btn:hover { color: #ef4444; }
    .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; flex-wrap: wrap; gap: 20px; }
    .page-header h2 { font-size: 1.8em; }
    .page-header p { color: #888; margin-top: 5px; }
    .clear-btn { background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
    .clear-btn:hover { background: #ef4444; color: white; }
    .history-list { display: flex; flex-direction: column; gap: 12px; }
    .history-item { display: flex; gap: 16px; background: #1a1a1a; border-radius: 12px; padding: 16px; transition: background 0.2s; }
    .history-item:hover { background: #222; }
    .history-thumb { width: 160px; height: 90px; border-radius: 8px; object-fit: cover; background: #333; flex-shrink: 0; }
    .history-info { flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
    .history-title { font-weight: 500; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .history-title a { color: white; text-decoration: none; }
    .history-title a:hover { color: #4ade80; }
    .history-meta { display: flex; gap: 16px; color: #888; font-size: 0.85em; }
    .history-actions { display: flex; gap: 8px; }
    .history-actions button { background: transparent; border: 1px solid #444; color: #888; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8em; }
    .history-actions button:hover { border-color: #666; color: white; }
    .history-actions button.delete:hover { border-color: #ef4444; color: #ef4444; }
    .empty-state { text-align: center; padding: 60px 20px; color: #666; }
    .empty-state h3 { font-size: 1.5em; margin-bottom: 10px; color: #888; }
    .empty-state a { color: #4ade80; text-decoration: none; }
    .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 30px; }
    .pagination button { background: #1a1a1a; border: none; color: white; padding: 10px 16px; border-radius: 6px; cursor: pointer; }
    .pagination button:hover { background: #333; }
    .pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
    .loading { text-align: center; padding: 40px; color: #888; }
    @media (max-width: 600px) {
      .history-item { flex-direction: column; }
      .history-thumb { width: 100%; height: auto; aspect-ratio: 16/9; }
    }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/member/history" class="active">歷史</a>
      <a href="/lurl/member/quota">額度</a>
      <a href="/lurl/member/profile">個人</a>
      <div class="user-info">
        <span class="nickname">${user.nickname || user.email.split('@')[0]}</span>
        <span class="logout-btn" onclick="logout()">登出</span>
      </div>
    </nav>
  </header>

  <main class="container">
    <div class="page-header">
      <div>
        <h2>📺 觀看歷史</h2>
        <p id="historyCount">載入中...</p>
      </div>
      <button class="clear-btn" onclick="clearAllHistory()">清除全部</button>
    </div>

    <div id="historyList" class="history-list">
      <div class="loading">載入中...</div>
    </div>

    <div class="pagination" id="pagination" style="display:none;">
      <button id="prevBtn" onclick="loadPage(currentPage - 1)">上一頁</button>
      <span id="pageInfo" style="padding: 10px 16px; color: #888;"></span>
      <button id="nextBtn" onclick="loadPage(currentPage + 1)">下一頁</button>
    </div>
  </main>

  <script>
    let currentPage = 1;
    const pageSize = 20;
    let totalCount = 0;

    async function loadHistory(page = 1) {
      currentPage = page;
      const offset = (page - 1) * pageSize;

      try {
        const res = await fetch('/lurl/api/member/history?limit=' + pageSize + '&offset=' + offset);
        const data = await res.json();

        if (!data.ok) {
          document.getElementById('historyList').innerHTML = '<div class="empty-state"><h3>載入失敗</h3><p>' + (data.error || '請稍後再試') + '</p></div>';
          return;
        }

        totalCount = data.total;
        document.getElementById('historyCount').textContent = '共 ' + totalCount + ' 筆記錄';

        if (data.history.length === 0) {
          document.getElementById('historyList').innerHTML = '<div class="empty-state"><h3>還沒有觀看記錄</h3><p>去 <a href="/lurl/browse">瀏覽</a> 看看吧</p></div>';
          document.getElementById('pagination').style.display = 'none';
          return;
        }

        const html = data.history.map(item => {
          const date = new Date(item.watchedAt).toLocaleString('zh-TW');
          const thumb = item.thumbnailPath ? '/lurl/files/' + item.thumbnailPath : '/lurl/files/placeholder.png';
          return '<div class="history-item" data-id="' + item.recordId + '">' +
            '<img src="' + thumb + '" alt="" class="history-thumb" onerror="this.src=\\'/lurl/files/placeholder.png\\'">' +
            '<div class="history-info">' +
              '<div class="history-title"><a href="/lurl/view/' + item.recordId + '">' + (item.title || '無標題') + '</a></div>' +
              '<div class="history-meta">' +
                '<span>📅 ' + date + '</span>' +
                '<span>🎬 ' + (item.type || 'video') + '</span>' +
              '</div>' +
              '<div class="history-actions">' +
                '<button onclick="window.location.href=\\'/lurl/view/' + item.recordId + '\\'">觀看</button>' +
                '<button class="delete" onclick="deleteItem(\\'' + item.recordId + '\\')">移除</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        document.getElementById('historyList').innerHTML = html;

        // Update pagination
        const totalPages = Math.ceil(totalCount / pageSize);
        if (totalPages > 1) {
          document.getElementById('pagination').style.display = 'flex';
          document.getElementById('pageInfo').textContent = page + ' / ' + totalPages;
          document.getElementById('prevBtn').disabled = page <= 1;
          document.getElementById('nextBtn').disabled = page >= totalPages;
        } else {
          document.getElementById('pagination').style.display = 'none';
        }
      } catch (err) {
        console.error(err);
        document.getElementById('historyList').innerHTML = '<div class="empty-state"><h3>載入失敗</h3><p>請稍後再試</p></div>';
      }
    }

    function loadPage(page) {
      loadHistory(page);
    }

    async function deleteItem(recordId) {
      if (!confirm('確定要移除這筆記錄？')) return;

      try {
        const res = await fetch('/lurl/api/member/history/' + recordId, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          loadHistory(currentPage);
        } else {
          alert('移除失敗: ' + (data.error || '未知錯誤'));
        }
      } catch (err) {
        alert('移除失敗');
      }
    }

    async function clearAllHistory() {
      if (!confirm('確定要清除全部觀看記錄？此操作無法復原。')) return;

      try {
        const res = await fetch('/lurl/api/member/history', { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          loadHistory(1);
        } else {
          alert('清除失敗: ' + (data.error || '未知錯誤'));
        }
      } catch (err) {
        alert('清除失敗');
      }
    }

    async function logout() {
      await fetch('/lurl/api/auth/logout', { method: 'POST' });
      window.location.href = '/lurl/';
    }

    loadHistory(1);
  </script>
</body>
</html>`;
}

// ==================== Member Profile Page ====================

function memberProfilePage(user) {
  const tierNames = { free: '免費仔', basic: '會員', premium: '老司機' };
  const tierName = tierNames[user.tier] || '免費仔';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>個人資料 - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo { height: 36px; width: auto; }
    .header nav { display: flex; gap: 20px; align-items: center; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .header nav a.active { color: white; }
    .header .user-info { display: flex; align-items: center; gap: 12px; }
    .header .user-info .nickname { color: #4ade80; font-weight: 500; }
    .header .logout-btn { color: #888; font-size: 0.85em; cursor: pointer; }
    .header .logout-btn:hover { color: #ef4444; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    .page-header { margin-bottom: 30px; }
    .page-header h2 { font-size: 1.8em; margin-bottom: 8px; }
    .page-header p { color: #888; }
    .profile-card { background: #1a1a1a; border-radius: 16px; padding: 30px; margin-bottom: 20px; }
    .avatar-section { display: flex; align-items: center; gap: 20px; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #333; }
    .avatar { width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #4ade80, #22c55e); display: flex; align-items: center; justify-content: center; font-size: 2em; font-weight: 600; }
    .avatar-info h3 { margin-bottom: 5px; }
    .avatar-info .tier { display: inline-block; background: #4ade80; color: #000; padding: 3px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 600; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; color: #888; margin-bottom: 8px; font-size: 0.9em; }
    .form-group input { width: 100%; background: #0f0f0f; border: 1px solid #333; border-radius: 8px; padding: 12px 16px; color: white; font-size: 1em; }
    .form-group input:focus { outline: none; border-color: #4ade80; }
    .form-group input:disabled { opacity: 0.6; cursor: not-allowed; }
    .form-group .hint { color: #666; font-size: 0.8em; margin-top: 6px; }
    .save-btn { width: 100%; background: #4ade80; color: #000; border: none; padding: 14px; border-radius: 8px; font-size: 1em; font-weight: 600; cursor: pointer; margin-top: 10px; }
    .save-btn:hover { background: #22c55e; }
    .save-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .message { padding: 12px; border-radius: 8px; margin-bottom: 20px; display: none; }
    .message.success { display: block; background: #1a2e1a; border: 1px solid #4ade80; color: #4ade80; }
    .message.error { display: block; background: #2e1a1a; border: 1px solid #ef4444; color: #ef4444; }
    .danger-zone { background: #1a1a1a; border: 1px solid #ef4444; border-radius: 12px; padding: 24px; margin-top: 30px; }
    .danger-zone h3 { color: #ef4444; margin-bottom: 12px; }
    .danger-zone p { color: #888; margin-bottom: 16px; font-size: 0.9em; }
    .danger-btn { background: transparent; border: 1px solid #ef4444; color: #ef4444; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
    .danger-btn:hover { background: #ef4444; color: white; }
  </style>
</head>
<body>
  <header class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <nav>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/member/history">歷史</a>
      <a href="/lurl/member/quota">額度</a>
      <a href="/lurl/member/profile" class="active">個人</a>
      <div class="user-info">
        <span class="nickname">${user.nickname || user.email.split('@')[0]}</span>
        <span class="logout-btn" onclick="logout()">登出</span>
      </div>
    </nav>
  </header>

  <main class="container">
    <div class="page-header">
      <h2>👤 個人資料</h2>
      <p>管理你的帳號設定</p>
    </div>

    <div id="message" class="message"></div>

    <div class="profile-card">
      <div class="avatar-section">
        <div class="avatar">${(user.nickname || user.email)[0].toUpperCase()}</div>
        <div class="avatar-info">
          <h3>${user.nickname || user.email.split('@')[0]}</h3>
          <span class="tier">${tierName}</span>
        </div>
      </div>

      <form id="profileForm" onsubmit="saveProfile(event)">
        <div class="form-group">
          <label>Email</label>
          <input type="email" value="${user.email}" disabled>
          <div class="hint">Email 無法變更</div>
        </div>

        <div class="form-group">
          <label>暱稱</label>
          <input type="text" id="nickname" value="${user.nickname || ''}" placeholder="設定一個暱稱" maxlength="20">
        </div>

        <div class="form-group">
          <label>加入時間</label>
          <input type="text" value="${new Date(user.createdAt).toLocaleDateString('zh-TW')}" disabled>
        </div>

        <button type="submit" class="save-btn" id="saveBtn">儲存變更</button>
      </form>
    </div>

    <div class="profile-card">
      <h3 style="margin-bottom: 20px;">🔐 變更密碼</h3>
      <form id="passwordForm" onsubmit="changePassword(event)">
        <div class="form-group">
          <label>目前密碼</label>
          <input type="password" id="currentPassword" placeholder="輸入目前密碼" required>
        </div>
        <div class="form-group">
          <label>新密碼</label>
          <input type="password" id="newPassword" placeholder="輸入新密碼（至少 6 字元）" minlength="6" required>
        </div>
        <div class="form-group">
          <label>確認新密碼</label>
          <input type="password" id="confirmPassword" placeholder="再次輸入新密碼" required>
        </div>
        <button type="submit" class="save-btn" id="pwdBtn">變更密碼</button>
      </form>
    </div>

    <div class="danger-zone">
      <h3>⚠️ 危險區域</h3>
      <p>刪除帳號後，所有資料將永久消失，包括觀看歷史、收藏等。此操作無法復原。</p>
      <button class="danger-btn" onclick="deleteAccount()">刪除帳號</button>
    </div>
  </main>

  <script>
    function showMessage(type, text) {
      const el = document.getElementById('message');
      el.className = 'message ' + type;
      el.textContent = text;
      setTimeout(() => { el.className = 'message'; }, 5000);
    }

    async function saveProfile(e) {
      e.preventDefault();
      const btn = document.getElementById('saveBtn');
      btn.disabled = true;
      btn.textContent = '儲存中...';

      try {
        const res = await fetch('/lurl/api/member/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname: document.getElementById('nickname').value })
        });
        const data = await res.json();
        if (data.ok) {
          showMessage('success', '資料已更新');
        } else {
          showMessage('error', data.error || '更新失敗');
        }
      } catch (err) {
        showMessage('error', '網路錯誤');
      }

      btn.disabled = false;
      btn.textContent = '儲存變更';
    }

    async function changePassword(e) {
      e.preventDefault();
      const newPwd = document.getElementById('newPassword').value;
      const confirmPwd = document.getElementById('confirmPassword').value;

      if (newPwd !== confirmPwd) {
        showMessage('error', '兩次輸入的密碼不一致');
        return;
      }

      const btn = document.getElementById('pwdBtn');
      btn.disabled = true;
      btn.textContent = '變更中...';

      try {
        const res = await fetch('/lurl/api/member/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentPassword: document.getElementById('currentPassword').value,
            newPassword: newPwd
          })
        });
        const data = await res.json();
        if (data.ok) {
          showMessage('success', '密碼已更新');
          document.getElementById('passwordForm').reset();
        } else {
          showMessage('error', data.error || '密碼變更失敗');
        }
      } catch (err) {
        showMessage('error', '網路錯誤');
      }

      btn.disabled = false;
      btn.textContent = '變更密碼';
    }

    async function deleteAccount() {
      const confirm1 = confirm('確定要刪除帳號嗎？此操作無法復原！');
      if (!confirm1) return;
      const confirm2 = prompt('請輸入 "DELETE" 確認刪除：');
      if (confirm2 !== 'DELETE') {
        alert('取消刪除');
        return;
      }

      try {
        const res = await fetch('/lurl/api/member/account', { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          alert('帳號已刪除');
          window.location.href = '/lurl/';
        } else {
          alert('刪除失敗: ' + (data.error || '未知錯誤'));
        }
      } catch (err) {
        alert('刪除失敗');
      }
    }

    async function logout() {
      await fetch('/lurl/api/auth/logout', { method: 'POST' });
      window.location.href = '/lurl/';
    }
  </script>
</body>
</html>`;
}

// ==================== Member Collections Page ====================

function memberCollectionsPage(user) {
  const canUseCollections = user.tier === 'premium' || user.tier === 'admin';
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>我的收藏 - Lurl</title>
  <style>
    :root {
      --bg-body: #f8fafc; --bg-header: #ffffff; --bg-card: #ffffff; --bg-input: #f1f5f9;
      --bg-button: #e2e8f0; --bg-button-hover: #cbd5e1;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --accent-green: #4ade80;
      --border: #e2e8f0; --shadow: rgba(0,0,0,0.08);
    }
    [data-theme="dark"] {
      --bg-body: #0a0a0a; --bg-header: #111111; --bg-card: #161616; --bg-input: #1a1a1a;
      --bg-button: #2a2a2a; --bg-button-hover: #3a3a3a;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --accent-green: #4ade80;
      --border: #2a2a2a; --shadow: rgba(0,0,0,0.5);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-body); color: var(--text-primary); min-height: 100vh; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-header); padding: 15px 20px; display: flex; align-items: center; box-shadow: 0 1px 3px var(--shadow); }
    .header .logo { height: 36px; width: auto; }
    .header-actions { display: flex; gap: 8px; margin-left: auto; margin-right: 20px; }
    .header-actions button { background: var(--bg-button); border: none; padding: 8px 12px; border-radius: 8px; font-size: 1.2em; cursor: pointer; transition: all 0.2s; }
    .header-actions button:hover { background: var(--bg-button-hover); }
    .header nav { display: flex; gap: 20px; align-items: center; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; flex-wrap: wrap; gap: 20px; }
    .page-header h2 { font-size: 1.8em; }
    .page-header p { color: var(--text-muted); margin-top: 5px; }
    .create-btn { background: var(--accent-green); color: #000; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; }
    .create-btn:hover { background: #22c55e; }
    .collections-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
    .collection-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; cursor: pointer; }
    .collection-card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px var(--shadow); }
    .collection-cover { height: 160px; background: linear-gradient(135deg, var(--bg-button), var(--bg-card)); display: flex; align-items: center; justify-content: center; }
    .collection-cover .icon { font-size: 3em; opacity: 0.3; }
    .collection-info { padding: 16px; }
    .collection-info h3 { margin-bottom: 8px; font-size: 1.1em; color: var(--text-primary); }
    .collection-info .meta { display: flex; justify-content: space-between; color: var(--text-muted); font-size: 0.85em; }
    .collection-actions { display: flex; gap: 8px; margin-top: 12px; }
    .collection-actions button { flex: 1; background: transparent; border: 1px solid var(--border); color: var(--text-muted); padding: 8px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
    .collection-actions button:hover { border-color: var(--accent); color: var(--text-primary); }
    .collection-actions button.delete:hover { border-color: #ef4444; color: #ef4444; }
    .empty-state { text-align: center; padding: 80px 20px; color: var(--text-muted); }
    .empty-state h3 { font-size: 1.5em; margin-bottom: 12px; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; align-items: center; justify-content: center; }
    .modal.active { display: flex; }
    .modal-content { background: var(--bg-card); border-radius: 16px; padding: 30px; max-width: 400px; width: 90%; }
    .modal-content h3 { margin-bottom: 20px; color: var(--text-primary); }
    .modal-content input { width: 100%; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 12px; color: var(--text-primary); margin-bottom: 16px; }
    .modal-content input:focus { outline: none; border-color: var(--accent-green); }
    .modal-content .checkbox-group { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; color: var(--text-muted); }
    .modal-content .checkbox-group input { width: auto; margin: 0; }
    .modal-actions { display: flex; gap: 12px; }
    .modal-actions button { flex: 1; padding: 12px; border-radius: 8px; cursor: pointer; font-weight: 500; }
    .modal-actions .cancel { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .modal-actions .confirm { background: var(--accent-green); border: none; color: #000; }
    .loading { text-align: center; padding: 40px; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <div class="header-actions">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
    </div>
    <nav>
      <a href="/lurl/">首頁</a>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/member/collections" class="active">⭐ 收藏</a>
      <a href="/lurl/admin">管理</a>
    </nav>
  </div>

  <main class="container">
    <div class="page-header">
      <div>
        <h2>⭐ 我的收藏 ${user.tier !== 'premium' && user.tier !== 'admin' ? '<span class="premium-badge">老司機專屬</span>' : ''}</h2>
        <p id="collectionCount">載入中...</p>
      </div>
      <button class="create-btn" onclick="showCreateModal()">+ 新增收藏夾</button>
    </div>

    ${user.tier !== 'premium' && user.tier !== 'admin' ? `
    <div style="background: linear-gradient(135deg, #1a1a2e, #16213e); border-radius: 12px; padding: 24px; margin-bottom: 30px; text-align: center;">
      <h3 style="margin-bottom: 12px;">🔒 收藏功能為老司機專屬</h3>
      <p style="color: #888; margin-bottom: 16px;">升級到老司機會員即可解鎖收藏功能，永久保存你喜歡的內容</p>
      <a href="/lurl/pricing" style="display: inline-block; background: #f59e0b; color: #000; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">查看方案</a>
    </div>
    ` : ''}

    <div id="collectionsGrid" class="collections-grid">
      <div class="loading">載入中...</div>
    </div>
  </main>

  <!-- Create/Edit Modal -->
  <div id="modal" class="modal" onclick="if(event.target === this) closeModal()">
    <div class="modal-content">
      <h3 id="modalTitle">新增收藏夾</h3>
      <input type="text" id="collectionName" placeholder="收藏夾名稱" maxlength="30">
      <div class="checkbox-group">
        <input type="checkbox" id="isPrivate" checked>
        <label for="isPrivate">設為私人（只有自己看得到）</label>
      </div>
      <div class="modal-actions">
        <button class="cancel" onclick="closeModal()">取消</button>
        <button class="confirm" id="modalConfirm" onclick="saveCollection()">建立</button>
      </div>
    </div>
  </div>

  <script>
    const isPremium = ${user.tier === 'premium' || user.tier === 'admin'};
    let collections = [];
    let editingId = null;

    async function loadCollections() {
      if (!isPremium) {
        document.getElementById('collectionsGrid').innerHTML = '';
        document.getElementById('collectionCount').textContent = '升級解鎖收藏功能';
        return;
      }

      try {
        const res = await fetch('/lurl/api/collections', { credentials: 'include' });
        const data = await res.json();

        if (!data.ok) {
          document.getElementById('collectionsGrid').innerHTML = '<div class="empty-state"><h3>載入失敗: ' + (data.error || '未知錯誤') + '</h3></div>';
          return;
        }

        collections = data.collections;
        document.getElementById('collectionCount').textContent = '共 ' + collections.length + ' 個收藏夾';

        if (collections.length === 0) {
          document.getElementById('collectionsGrid').innerHTML = '<div class="empty-state" style="grid-column: 1/-1;"><h3>還沒有收藏夾</h3><p>建立一個收藏夾來保存你喜歡的內容</p></div>';
          return;
        }

        const html = collections.map(c => {
          const date = new Date(c.createdAt).toLocaleDateString('zh-TW');
          return '<div class="collection-card" onclick="viewCollection(\\'' + c.id + '\\')">' +
            '<div class="collection-cover"><span class="icon">📁</span></div>' +
            '<div class="collection-info">' +
              '<h3>' + c.name + (c.isPrivate ? ' <span class="private-badge">🔒</span>' : '') + '</h3>' +
              '<div class="meta">' +
                '<span>' + (c.itemCount || 0) + ' 個項目</span>' +
                '<span>' + date + '</span>' +
              '</div>' +
              '<div class="collection-actions" onclick="event.stopPropagation()">' +
                '<button onclick="editCollection(\\'' + c.id + '\\', \\'' + c.name.replace(/'/g, "\\\\'") + '\\', ' + c.isPrivate + ')">編輯</button>' +
                '<button class="delete" onclick="deleteCollection(\\'' + c.id + '\\')">刪除</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        document.getElementById('collectionsGrid').innerHTML = html;
      } catch (err) {
        console.error(err);
        document.getElementById('collectionsGrid').innerHTML = '<div class="empty-state"><h3>載入失敗</h3></div>';
      }
    }

    function viewCollection(id) {
      window.location.href = '/lurl/member/collections/' + id;
    }

    function showCreateModal() {
      if (!isPremium) {
        alert('收藏功能為老司機專屬，請先升級');
        return;
      }
      editingId = null;
      document.getElementById('modalTitle').textContent = '新增收藏夾';
      document.getElementById('collectionName').value = '';
      document.getElementById('isPrivate').checked = true;
      document.getElementById('modalConfirm').textContent = '建立';
      document.getElementById('modal').classList.add('active');
    }

    function editCollection(id, name, isPrivate) {
      editingId = id;
      document.getElementById('modalTitle').textContent = '編輯收藏夾';
      document.getElementById('collectionName').value = name;
      document.getElementById('isPrivate').checked = isPrivate;
      document.getElementById('modalConfirm').textContent = '儲存';
      document.getElementById('modal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('active');
      editingId = null;
    }

    async function saveCollection() {
      const name = document.getElementById('collectionName').value.trim();
      const isPrivate = document.getElementById('isPrivate').checked;

      if (!name) {
        alert('請輸入收藏夾名稱');
        return;
      }

      try {
        const url = editingId ? '/lurl/api/collections/' + editingId : '/lurl/api/collections';
        const method = editingId ? 'PUT' : 'POST';

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, isPrivate })
        });

        const data = await res.json();
        if (data.ok) {
          closeModal();
          loadCollections();
        } else {
          alert(data.error || '操作失敗');
        }
      } catch (err) {
        alert('操作失敗');
      }
    }

    async function deleteCollection(id) {
      if (!confirm('確定要刪除這個收藏夾？收藏的內容不會被刪除。')) return;

      try {
        const res = await fetch('/lurl/api/collections/' + id, { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.ok) {
          loadCollections();
        } else {
          alert(data.error || '刪除失敗');
        }
      } catch (err) {
        alert('刪除失敗');
      }
    }

    async function logout() {
      await fetch('/lurl/api/auth/logout', { method: 'POST' });
      window.location.href = '/lurl/';
    }

    // 主題切換
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('.theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    })();

    loadCollections();
  </script>
</body>
</html>`;
}

// ==================== Collection Detail Page ====================

function collectionDetailPage(user, collection) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${collection.name} - 我的收藏 - Lurl</title>
  <style>
    :root {
      --bg-body: #f8fafc; --bg-header: #ffffff; --bg-card: #ffffff; --bg-input: #f1f5f9;
      --bg-button: #e2e8f0; --bg-button-hover: #cbd5e1;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --accent-green: #4ade80;
      --border: #e2e8f0; --shadow: rgba(0,0,0,0.08);
    }
    [data-theme="dark"] {
      --bg-body: #0a0a0a; --bg-header: #111111; --bg-card: #161616; --bg-input: #1a1a1a;
      --bg-button: #2a2a2a; --bg-button-hover: #3a3a3a;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --accent-green: #4ade80;
      --border: #2a2a2a; --shadow: rgba(0,0,0,0.5);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-body); color: var(--text-primary); min-height: 100vh; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-header); padding: 15px 20px; display: flex; align-items: center; box-shadow: 0 1px 3px var(--shadow); }
    .header .logo { height: 36px; width: auto; }
    .header-actions { display: flex; gap: 8px; margin-left: auto; margin-right: 20px; }
    .header-actions button { background: var(--bg-button); border: none; padding: 8px 12px; border-radius: 8px; font-size: 1.2em; cursor: pointer; transition: all 0.2s; }
    .header-actions button:hover { background: var(--bg-button-hover); }
    .header nav { display: flex; gap: 20px; align-items: center; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
    .back-link { display: inline-block; margin-bottom: 20px; color: var(--text-muted); text-decoration: none; }
    .back-link:hover { color: var(--accent); }
    .page-header { margin-bottom: 30px; }
    .page-header h2 { font-size: 1.8em; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .page-header .private-badge { color: var(--text-muted); font-size: 0.5em; }
    .page-header p { color: var(--text-muted); margin-top: 8px; }
    .items-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
    .item-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; }
    .item-card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px var(--shadow); }
    .item-card a { text-decoration: none; color: inherit; }
    .item-thumb { width: 100%; aspect-ratio: 16/9; object-fit: cover; background: var(--bg-button); }
    .item-info { padding: 12px; }
    .item-info h4 { font-size: 0.95em; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-primary); }
    .item-info .meta { display: flex; justify-content: space-between; color: var(--text-muted); font-size: 0.8em; }
    .item-remove { background: transparent; border: 1px solid var(--border); color: var(--text-muted); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8em; margin-top: 8px; width: 100%; }
    .item-remove:hover { border-color: #ef4444; color: #ef4444; }
    .empty-state { text-align: center; padding: 80px 20px; color: var(--text-muted); grid-column: 1/-1; }
    .empty-state h3 { font-size: 1.5em; margin-bottom: 12px; }
    .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 30px; }
    .pagination button { background: var(--bg-card); border: 1px solid var(--border); color: var(--text-primary); padding: 10px 16px; border-radius: 6px; cursor: pointer; }
    .pagination button:hover { background: var(--bg-button-hover); }
    .pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
    .loading { text-align: center; padding: 40px; color: var(--text-muted); grid-column: 1/-1; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/lurl/"><img src="/lurl/files/LOGO.png" alt="Lurl" class="logo"></a>
    <div class="header-actions">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
    </div>
    <nav>
      <a href="/lurl/">首頁</a>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/member/collections" class="active">⭐ 收藏</a>
      <a href="/lurl/admin">管理</a>
    </nav>
  </div>

  <main class="container">
    <a href="/lurl/member/collections" class="back-link">← 返回收藏列表</a>

    <div class="page-header">
      <h2>📁 ${collection.name} ${collection.isPrivate ? '<span class="private-badge">🔒 私人</span>' : ''}</h2>
      <p id="itemCount">載入中...</p>
    </div>

    <div id="itemsGrid" class="items-grid">
      <div class="loading">載入中...</div>
    </div>

    <div class="pagination" id="pagination" style="display:none;">
      <button id="prevBtn" onclick="loadPage(currentPage - 1)">上一頁</button>
      <span id="pageInfo" style="padding: 10px 16px; color: var(--text-muted);"></span>
      <button id="nextBtn" onclick="loadPage(currentPage + 1)">下一頁</button>
    </div>
  </main>

  <script>
    const collectionId = '${collection.id}';
    let currentPage = 1;
    const pageSize = 20;
    let totalCount = 0;

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('lurl-theme', next);
      document.querySelector('.theme-toggle').textContent = next === 'dark' ? '☀️' : '🌙';
    }

    async function loadItems(page = 1) {
      currentPage = page;
      const offset = (page - 1) * pageSize;

      try {
        const res = await fetch('/lurl/api/collections/' + collectionId + '/items?limit=' + pageSize + '&offset=' + offset, { credentials: 'include' });
        const data = await res.json();

        if (!data.ok) {
          document.getElementById('itemsGrid').innerHTML = '<div class="empty-state"><h3>載入失敗: ' + (data.error || '未知錯誤') + '</h3></div>';
          return;
        }

        totalCount = data.total;
        document.getElementById('itemCount').textContent = '共 ' + totalCount + ' 個項目';

        if (data.items.length === 0) {
          document.getElementById('itemsGrid').innerHTML = '<div class="empty-state"><h3>收藏夾是空的</h3><p>瀏覽內容時點擊收藏按鈕來加入</p></div>';
          document.getElementById('pagination').style.display = 'none';
          return;
        }

        const html = data.items.map(item => {
          const date = new Date(item.addedAt).toLocaleDateString('zh-TW');
          const thumb = item.thumbnailPath ? '/lurl/files/' + item.thumbnailPath : '/lurl/files/placeholder.png';
          return '<div class="item-card">' +
            '<a href="/lurl/view/' + item.recordId + '">' +
              '<img src="' + thumb + '" alt="" class="item-thumb" onerror="this.src=\\'/lurl/files/placeholder.png\\'">' +
              '<div class="item-info">' +
                '<h4>' + (item.title || '無標題') + '</h4>' +
                '<div class="meta">' +
                  '<span>' + (item.type || 'video') + '</span>' +
                  '<span>' + date + '</span>' +
                '</div>' +
              '</div>' +
            '</a>' +
            '<div style="padding: 0 12px 12px;">' +
              '<button class="item-remove" onclick="removeItem(\\'' + item.recordId + '\\')">移除</button>' +
            '</div>' +
          '</div>';
        }).join('');

        document.getElementById('itemsGrid').innerHTML = html;

        // Update pagination
        const totalPages = Math.ceil(totalCount / pageSize);
        if (totalPages > 1) {
          document.getElementById('pagination').style.display = 'flex';
          document.getElementById('pageInfo').textContent = page + ' / ' + totalPages;
          document.getElementById('prevBtn').disabled = page <= 1;
          document.getElementById('nextBtn').disabled = page >= totalPages;
        } else {
          document.getElementById('pagination').style.display = 'none';
        }
      } catch (err) {
        console.error(err);
        document.getElementById('itemsGrid').innerHTML = '<div class="empty-state"><h3>載入失敗</h3></div>';
      }
    }

    function loadPage(page) {
      loadItems(page);
    }

    async function removeItem(recordId) {
      if (!confirm('確定要從收藏夾移除？')) return;

      try {
        const res = await fetch('/lurl/api/collections/' + collectionId + '/items/' + recordId, { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.ok) {
          loadItems(currentPage);
        } else {
          alert(data.error || '移除失敗');
        }
      } catch (err) {
        alert('移除失敗');
      }
    }

    // Initialize theme
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('.theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    })();

    loadItems(1);
  </script>
</body>
</html>`;
}

function browsePage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl 影片庫</title>
  <style>
    :root {
      --bg-body: #f8fafc; --bg-header: #ffffff; --bg-card: #ffffff; --bg-input: #f1f5f9;
      --bg-button: #e2e8f0; --bg-button-hover: #cbd5e1; --bg-panel: #f0f9fc;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --accent-pink: #ec4899;
      --border: #e2e8f0; --shadow: rgba(0,0,0,0.08);
      --card-thumb-bg: linear-gradient(135deg, #c7e5f0 0%, #e8f4f8 100%);
      --card-thumb-pending: linear-gradient(135deg, #fef3c7 0%, #fef9e7 100%);
      --card-thumb-image: linear-gradient(135deg, #e8d5f0 0%, #f3e8f8 100%);
    }
    [data-theme="dark"] {
      --bg-body: #0a0a0a; --bg-header: #111111; --bg-card: #161616; --bg-input: #1a1a1a;
      --bg-button: #2a2a2a; --bg-button-hover: #3a3a3a; --bg-panel: #0f0f0f;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --accent-pink: #ec4899;
      --border: #2a2a2a; --shadow: rgba(0,0,0,0.5);
      --card-thumb-bg: linear-gradient(135deg, #1a2a3a 0%, #0a0a0a 100%);
      --card-thumb-pending: linear-gradient(135deg, #2a2010 0%, #161616 100%);
      --card-thumb-image: linear-gradient(135deg, #201a2a 0%, #161616 100%);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-body); color: var(--text-primary); min-height: 100vh; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-header); color: var(--text-primary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; box-shadow: 0 1px 3px var(--shadow); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: var(--accent); }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

    /* Search Bar */
    .search-bar { margin-bottom: 20px; }
    .search-bar input {
      width: 100%;
      max-width: 500px;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 1em;
      outline: none;
    }
    .search-bar input::placeholder { color: var(--text-muted); }
    .search-bar input:focus { box-shadow: 0 0 0 2px var(--accent); border-color: var(--accent); }

    /* Filter Bar */
    .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .tabs { display: flex; gap: 10px; }
    .tab { padding: 8px 16px; background: var(--bg-button); border: none; border-radius: 20px; color: var(--text-secondary); cursor: pointer; transition: all 0.2s; }
    .tab:hover { background: var(--bg-button-hover); }
    .tab.active { background: var(--accent); color: #fff; }
    .result-count { margin-left: auto; color: var(--text-muted); font-size: 1.1em; font-weight: 500; }

    /* Pagination */
    .pagination { display: flex; justify-content: center; align-items: center; gap: 8px; margin-top: 30px; flex-wrap: wrap; }
    .pagination button { min-width: 40px; height: 40px; border: none; border-radius: 8px; background: var(--bg-button); color: var(--text-muted); cursor: pointer; font-size: 14px; transition: all 0.2s; }
    .pagination button:hover:not(:disabled) { background: var(--bg-button-hover); color: var(--text-primary); }
    .pagination button.active { background: var(--accent); color: #fff; }
    .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination button.nav-btn { padding: 0 12px; }
    .pagination button .nav-text { display: inline; }
    .pagination button .nav-icon { display: none; }
    .pagination .page-info { color: var(--text-muted); font-size: 14px; margin: 0 10px; }

    /* Grid */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
    .card { background: var(--bg-card); border-radius: 12px; overflow: hidden; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; border: 1px solid var(--border); }
    .card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px var(--shadow); }

    /* Thumbnail - No video preload! */
    .card-thumb {
      aspect-ratio: 16/9;
      background: var(--card-thumb-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
      position: relative;
      overflow: hidden;
    }
    .card-thumb .play-icon {
      width: 60px;
      height: 60px;
      background: rgba(255,255,255,0.15);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
      transition: all 0.2s;
      z-index: 2;
    }
    .card:hover .card-thumb .play-icon { background: rgba(91,180,212,0.8); transform: scale(1.1); }
    .card-thumb .play-icon::after {
      content: '';
      width: 0;
      height: 0;
      border-left: 18px solid white;
      border-top: 11px solid transparent;
      border-bottom: 11px solid transparent;
      margin-left: 4px;
    }
    .card-thumb.pending { background: var(--card-thumb-pending); }
    .card-thumb.image { background: var(--card-thumb-image); }
    .card-thumb img {
      width: 100%; height: 100%; object-fit: cover;
      filter: blur(20px); opacity: 0;
      transition: filter 0.4s ease-out, opacity 0.4s ease-out;
      position: absolute; top: 0; left: 0;
    }
    .card-thumb img.loaded { filter: blur(4px); opacity: 1; }
    .card:hover .card-thumb img.loaded { filter: blur(2px); }

    /* Card Info */
    .card-info { padding: 12px; }
    .card-title { font-size: 0.95em; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 8px; color: var(--text-primary); }
    .card-meta { display: flex; justify-content: space-between; align-items: center; }
    .card-date { font-size: 0.8em; color: var(--text-muted); }
    .card-id {
      font-size: 0.75em;
      color: var(--accent);
      background: rgba(91,180,212,0.1);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .card-id:hover { background: rgba(91,180,212,0.3); }
    .card-status { font-size: 0.75em; color: #f59e0b; margin-top: 4px; }

    .empty { text-align: center; padding: 60px; color: var(--text-muted); }

    /* Skeleton Loading */
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .skeleton {
      background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-button) 50%, var(--bg-card) 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
    }
    .skeleton-card { background: var(--bg-card); border-radius: 12px; overflow: hidden; }
    .skeleton-thumb { aspect-ratio: 16/9; }
    .skeleton-info { padding: 12px; }
    .skeleton-title { height: 20px; border-radius: 4px; margin-bottom: 12px; width: 80%; }
    .skeleton-meta { height: 14px; border-radius: 4px; width: 50%; }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--bg-button-hover);
      color: var(--text-primary);
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; }

    /* Header Actions */
    .header-actions { display: flex; gap: 8px; margin-left: auto; margin-right: 20px; }
    .header-actions button {
      background: var(--bg-button);
      border: none;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 1.2em;
      cursor: pointer;
      transition: all 0.2s;
    }
    .header-actions button:hover { background: var(--bg-button-hover); }
    .mute-btn.muted { background: #c62828; }
    .theme-toggle { font-size: 1.1em !important; }

    /* Redeem Panel */
    .redeem-panel {
      display: none;
      background: var(--bg-panel);
      padding: 20px;
      border-bottom: 1px solid var(--border);
    }
    .redeem-panel.show { display: block; }
    .redeem-content { max-width: 400px; margin: 0 auto; text-align: center; }
    .redeem-content h3 { color: var(--text-primary); margin-bottom: 8px; }
    .redeem-desc { color: var(--text-muted); font-size: 0.9em; margin-bottom: 16px; }
    .redeem-input-group { display: flex; gap: 8px; }
    .redeem-input-group input {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid var(--border);
      border-radius: 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 1.1em;
      font-family: monospace;
      letter-spacing: 2px;
      text-transform: uppercase;
      text-align: center;
    }
    .redeem-input-group input:focus { border-color: #4ade80; outline: none; }
    .redeem-input-group button {
      padding: 12px 24px;
      background: #4ade80;
      color: #000;
      border: none;
      border-radius: 8px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
    }
    .redeem-input-group button:hover { background: #22c55e; }
    .redeem-status { margin-top: 12px; font-size: 0.9em; min-height: 20px; }
    .redeem-status.success { color: #4ade80; }
    .redeem-status.error { color: #f87171; }

    /* Card Actions (Rating & Block) */
    .card-actions { display: flex; gap: 6px; margin-top: 8px; }
    .card-actions button {
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: var(--bg-button);
      color: var(--text-muted);
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .card-actions button:hover { background: var(--bg-button-hover); color: var(--text-primary); }
    .card-actions .btn-like.active { background: #4caf50; color: white; }
    .card-actions .btn-dislike.active { background: #f44336; color: white; }
    .card-actions .btn-block:hover { background: #c62828; color: white; }
    .card.blocked { opacity: 0.5; }
    .card.blocked .card-thumb { filter: grayscale(1); }

    /* Favorite button */
    .btn-favorite {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 15;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: rgba(0,0,0,0.5);
      color: #ccc;
      font-size: 18px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    }
    .btn-favorite:hover { background: rgba(0,0,0,0.7); color: #ffc107; transform: scale(1.1); }
    .btn-favorite.active { background: rgba(255,193,7,0.9); color: #000; }
    .btn-favorite.active:hover { background: #ffc107; }

    /* Card Tags */
    .card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .card-tags .tag {
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.75em;
      cursor: pointer;
      background: var(--bg-button);
      color: var(--text-muted);
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .card-tags .tag:hover { background: var(--bg-button-hover); color: var(--text-secondary); border-color: var(--border); }
    .card-tags .tag.active { background: var(--accent-pink); color: white; border-color: var(--accent-pink); }

    .tag-group { display: inline-flex; align-items: center; position: relative; }
    .card-tags { position: relative; z-index: 1; }
    .tag-popover {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      z-index: 9999;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      min-width: 120px;
      box-shadow: 0 4px 12px var(--shadow);
    }
    .tag-popover .tag.sub {
      font-size: 0.75em;
      padding: 4px 8px;
      background: var(--bg-button);
    }
    .tag-popover .tag.sub.active { background: #be185d; border-color: #be185d; }

    /* Tag filter bar */
    .tag-filter {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--bg-card);
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .tag-filter .filter-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .tag-filter .filter-tag {
      padding: 6px 12px;
      border-radius: 16px;
      font-size: 0.85em;
      cursor: pointer;
      background: var(--bg-button);
      color: var(--text-muted);
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .tag-filter .filter-tag:hover { background: var(--bg-button-hover); color: var(--text-secondary); }
    .tag-filter .filter-tag.active { background: var(--accent-pink); color: white; border-color: var(--accent-pink); }
    .tag-filter .filter-popover {
      position: absolute;
      top: 100%;
      left: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      z-index: 100;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 140px;
      box-shadow: 0 4px 12px var(--shadow);
    }
    .tag-filter .filter-sub {
      padding: 6px 12px;
      font-size: 0.8em;
      background: var(--bg-button);
      border: 1px solid var(--border);
      border-radius: 16px;
      cursor: pointer;
      color: var(--text-muted);
    }
    .tag-filter .filter-sub:hover { background: var(--bg-button-hover); }
    .tag-filter .filter-sub.active { background: #be185d; border-color: #be185d; color: white; }
    .tag-filter .clear-filter {
      padding: 6px 12px;
      background: var(--bg-button);
      color: var(--text-muted);
      border: none;
      border-radius: 16px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .tag-filter .clear-filter:hover { background: var(--bg-button-hover); color: var(--text-primary); }

    /* ===== RWD 響應式設計 ===== */

    /* Tablet (768px - 1023px) */
    @media (max-width: 1023px) {
      .container { padding: 16px; }
      .grid { grid-template-columns: repeat(3, 1fr); gap: 16px; }
      .card-thumb .play-icon { width: 50px; height: 50px; }
      .card-thumb .play-icon::after { border-left-width: 14px; border-top-width: 9px; border-bottom-width: 9px; }
    }

    /* Mobile Landscape (480px - 767px) */
    @media (max-width: 767px) {
      .header { padding: 12px 16px; }
      .header .logo { height: 28px; }
      .header h1 { font-size: 1.1em; }
      .header nav { gap: 12px; }
      .header nav a { font-size: 0.85em; }

      .container { padding: 12px; }
      .search-bar input { padding: 10px 14px; font-size: 16px; max-width: 100%; }

      .filter-bar { flex-direction: column; align-items: stretch; gap: 12px; }
      .tabs { overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
      .tabs::-webkit-scrollbar { display: none; }
      .tab { padding: 6px 12px; font-size: 0.9em; white-space: nowrap; flex-shrink: 0; }
      .result-count { margin-left: 0; text-align: center; }

      .grid { grid-template-columns: 1fr; gap: 12px; }
      .card { border-radius: 10px; }
      .card-info { padding: 10px; }
      .card-title { font-size: 0.85em; -webkit-line-clamp: 2; }
      .card-date { font-size: 0.75em; }
      .card-id { font-size: 0.7em; padding: 2px 6px; }
      .card-actions { flex-wrap: wrap; }
      .card-actions button { padding: 3px 6px; font-size: 0.8em; }

      .pagination { gap: 6px; margin-top: 24px; }
      .pagination button { min-width: 36px; height: 36px; font-size: 13px; }
      .pagination .page-info { font-size: 12px; margin: 0 6px; }

      .toast { bottom: 12px; right: 12px; left: 12px; text-align: center; }
    }

    /* Mobile Portrait (< 480px) */
    @media (max-width: 479px) {
      .header { padding: 10px 12px; }
      .header .logo { height: 24px; }
      .header h1 { font-size: 1em; }
      .header nav a { font-size: 0.8em; }

      .container { padding: 10px; }
      .search-bar { margin-bottom: 12px; }
      .filter-bar { margin-bottom: 12px; }

      .grid { gap: 10px; }
      .card { border-radius: 8px; }
      .card-thumb { font-size: 36px; }
      .card-thumb .play-icon { width: 44px; height: 44px; }
      .card-thumb .play-icon::after { border-left-width: 12px; border-top-width: 7px; border-bottom-width: 7px; margin-left: 3px; }
      .card-info { padding: 8px; }
      .card-title { font-size: 0.8em; margin-bottom: 6px; }
      .card-meta { flex-direction: column; align-items: flex-start; gap: 4px; }
      .card-actions button { min-height: 32px; }

      .pagination button .nav-text { display: none; }
      .pagination button .nav-icon { display: inline; }
      .pagination button.nav-btn { min-width: 36px; padding: 0; }
    }
  </style>
</head>
<body>
  <div class="header">
    <a href="/lurl/" class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
    </a>
    <div class="header-actions">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
      <button id="muteToggle" class="mute-btn" onclick="toggleGlobalMute()" title="靜音模式">🔊</button>
      <button class="redeem-btn" onclick="toggleRedeemPanel()" title="兌換序號">🎁</button>
    </div>
    <nav>
      <a href="/lurl/">首頁</a>
      <a href="/lurl/browse" class="active">瀏覽</a>
      <a href="/lurl/member/collections">⭐ 收藏</a>
      <a href="/lurl/admin">管理</a>
    </nav>
  </div>
  <!-- 序號兌換面板 -->
  <div class="redeem-panel" id="redeemPanel">
    <div class="redeem-content">
      <h3>🎁 兌換額度</h3>
      <p class="redeem-desc">輸入序號獲得額外備份額度</p>
      <div class="redeem-input-group">
        <input type="text" id="redeemCode" placeholder="XXXX-XXXX-XXXX" maxlength="14" autocomplete="off">
        <button onclick="submitRedeem()">兌換</button>
      </div>
      <div id="redeemStatus" class="redeem-status"></div>
    </div>
  </div>
  <div class="container">
    <div class="search-bar">
      <input type="text" id="search" placeholder="Search by title, ID, or URL (e.g. n41Xm, mkhev)..." autocomplete="off">
    </div>
    <div class="filter-bar">
      <div class="tabs">
        <button class="tab active" data-type="all">全部</button>
        <button class="tab" data-type="video">影片</button>
        <button class="tab" data-type="image">圖片</button>
        <button class="tab" data-type="pending" style="background:#f59e0b;color:#000;">未下載</button>
        <button class="tab" data-type="blocked" style="background:#666;">🚫 已封鎖</button>
      </div>
      <div class="result-count" id="resultCount"></div>
    </div>
    <div class="tag-filter" id="tagFilter"></div>
    <div class="grid" id="grid">
      <!-- 骨架屏 -->
      ${Array(8).fill(0).map(() => `
        <div class="skeleton-card">
          <div class="skeleton-thumb skeleton"></div>
          <div class="skeleton-info">
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-meta skeleton"></div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="pagination" id="pagination"></div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    let allRecords = [];
    let currentType = localStorage.getItem('lurl_browse_tab') || 'all';
    let searchQuery = '';
    let isLoading = false;
    let selectedFilterTags = [];  // 篩選用的標籤
    let expandedFilterTag = null; // 展開的篩選主標籤
    let favoritesMap = {};        // 收藏狀態 { recordId: true/false }

    // ===== 滾動位置記憶 =====
    const SCROLL_KEY = 'lurl_browse_scroll';

    function saveScrollPosition() {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
        scrollY: window.scrollY,
        page: currentPage,
        type: currentType
      }));
    }

    function restoreScrollPosition() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}');
        // 只有在同一個 tab 和頁碼才恢復滾動位置
        if (saved.type === currentType && saved.page === currentPage && saved.scrollY) {
          setTimeout(() => window.scrollTo(0, saved.scrollY), 100);
        }
      } catch (e) {}
    }

    function navigateToView(recordId) {
      saveScrollPosition();
      window.location.href = '/lurl/view/' + recordId;
    }

    // ===== 訪客 ID =====
    function getVisitorId() {
      let id = localStorage.getItem('lurl_visitor_id');
      if (!id) {
        id = 'V_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('lurl_visitor_id', id);
      }
      return id;
    }

    // ===== 主題切換 =====
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }

    function initTheme() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('.theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    }

    // ===== 靜音模式 =====
    let globalMuted = localStorage.getItem('lurl_muted') === 'true';

    function initMuteState() {
      const btn = document.getElementById('muteToggle');
      if (globalMuted) {
        btn.textContent = '🔇';
        btn.classList.add('muted');
      }
    }

    function toggleGlobalMute() {
      globalMuted = !globalMuted;
      localStorage.setItem('lurl_muted', globalMuted);
      const btn = document.getElementById('muteToggle');
      btn.textContent = globalMuted ? '🔇' : '🔊';
      btn.classList.toggle('muted', globalMuted);
      showToast(globalMuted ? '已開啟靜音模式' : '已關閉靜音模式');
    }

    // ===== 序號兌換 =====
    function toggleRedeemPanel() {
      const panel = document.getElementById('redeemPanel');
      panel.classList.toggle('show');
      if (panel.classList.contains('show')) {
        document.getElementById('redeemCode').focus();
      }
    }

    // 自動格式化輸入的序號
    document.addEventListener('DOMContentLoaded', () => {
      const input = document.getElementById('redeemCode');
      if (input) {
        input.addEventListener('input', (e) => {
          let value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
          if (value.length > 4) value = value.slice(0, 4) + '-' + value.slice(4);
          if (value.length > 9) value = value.slice(0, 9) + '-' + value.slice(9);
          e.target.value = value.slice(0, 14);
        });
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') submitRedeem();
        });
      }
      initTheme();
      initMuteState();
    });

    async function submitRedeem() {
      const input = document.getElementById('redeemCode');
      const status = document.getElementById('redeemStatus');
      const code = input.value.trim();

      if (!code) {
        status.textContent = '請輸入兌換碼';
        status.className = 'redeem-status error';
        return;
      }

      status.textContent = '兌換中...';
      status.className = 'redeem-status';

      try {
        const res = await fetch('/lurl/api/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, visitorId: getVisitorId() })
        });
        const data = await res.json();

        if (data.ok) {
          status.textContent = '✅ 兌換成功！獲得 +' + data.bonus + ' 額度';
          status.className = 'redeem-status success';
          input.value = '';
          showToast('🎉 成功獲得 ' + data.bonus + ' 額度！');
        } else {
          status.textContent = '❌ ' + data.error;
          status.className = 'redeem-status error';
        }
      } catch (err) {
        status.textContent = '❌ 兌換失敗：' + err.message;
        status.className = 'redeem-status error';
      }
    }

    // 恢復上次的 tab 狀態
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.type === currentType);
    });

    function showSkeleton() {
      document.getElementById('grid').innerHTML = Array(8).fill(0).map(() => \`
        <div class="skeleton-card">
          <div class="skeleton-thumb skeleton"></div>
          <div class="skeleton-info">
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-meta skeleton"></div>
          </div>
        </div>
      \`).join('');
    }

    let currentPage = 1;
    let totalRecords = 0;
    let totalPages = 1;
    const perPage = 24;
    const TAG_TREE = {
      '奶子': ['穿衣', '裸體', '大奶', '露點'],
      '屁股': [],
      '鮑魚': [],
      '全身': [],
      '姿勢': ['女上', '傳教士', '背後'],
      '口交': []
    };
    const MAIN_TAGS = Object.keys(TAG_TREE);

    // 檢查記錄是否有某主分類的標籤（包含子標籤）
    function hasMainTag(tags, mainTag) {
      return tags.some(t => t === mainTag || t.startsWith(mainTag + ':'));
    }

    async function toggleTag(recordId, tag) {
      const record = allRecords.find(r => r.id === recordId);
      if (!record) return;

      const currentTags = record.tags || [];
      const newTags = currentTags.includes(tag)
        ? currentTags.filter(t => t !== tag)
        : [...currentTags, tag];

      try {
        const res = await fetch(\`/lurl/api/records/\${recordId}/tags\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: newTags })
        });
        const data = await res.json();
        if (data.ok) {
          record.tags = data.tags;
          renderGrid();
        }
      } catch (e) {
        showToast('標籤更新失敗');
      }
    }

    // 展開的標籤選擇器狀態
    let expandedTagSelector = null;

    // 使用事件委派處理 tag 點擊（Browse 頁面）
    document.addEventListener('click', (e) => {
      // 處理 tag 點擊
      const tagEl = e.target.closest('.card-tags .tag');
      if (tagEl) {
        e.preventDefault();
        e.stopPropagation();

        const action = tagEl.dataset.action;
        const recordId = tagEl.dataset.record;
        const tag = tagEl.dataset.tag;

        if (action === 'popover' && recordId && tag) {
          // 點母標籤：同時切換母標籤 + 展開子選項
          toggleTag(recordId, tag);
          const key = recordId + ':' + tag;
          expandedTagSelector = (expandedTagSelector === key) ? null : key;
          // toggleTag 會呼叫 renderGrid，所以不用再呼叫
        } else if (action === 'toggle' && recordId && tag) {
          toggleTag(recordId, tag);
        }
        return;
      }

      // 點擊外部關閉 popover
      if (expandedTagSelector && !e.target.closest('.tag-group')) {
        expandedTagSelector = null;
        renderGrid();
      }
    });

    function renderTagSelector(record) {
      const tags = record.tags || [];
      return MAIN_TAGS.map(mainTag => {
        const isActive = hasMainTag(tags, mainTag);  // 該分類是否有任何標籤被選
        const subTags = TAG_TREE[mainTag];
        const hasSubTags = subTags.length > 0;
        const isExpanded = expandedTagSelector === record.id + ':' + mainTag;

        let html = \`<span class="tag-group" data-group="\${record.id}:\${mainTag}">\`;

        if (hasSubTags) {
          // 有子標籤：點擊切換母標籤 + 展開子選項
          html += \`<span class="tag \${isActive ? 'active' : ''}" data-action="popover" data-record="\${record.id}" data-tag="\${mainTag}">\${mainTag} ▾</span>\`;

          if (isExpanded) {
            html += \`<div class="tag-popover">\`;
            // 只顯示子標籤
            html += subTags.map(sub => {
              const fullTag = mainTag + ':' + sub;
              const isSubActive = tags.includes(fullTag);
              return \`<span class="tag sub \${isSubActive ? 'active' : ''}" data-action="toggle" data-record="\${record.id}" data-tag="\${fullTag}">\${sub}</span>\`;
            }).join('');
            html += \`</div>\`;
          }
        } else {
          // 沒有子標籤：直接切換
          html += \`<span class="tag \${isActive ? 'active' : ''}" data-action="toggle" data-record="\${record.id}" data-tag="\${mainTag}">\${mainTag}</span>\`;
        }

        html += \`</span>\`;
        return html;
      }).join('');
    }

    // === 標籤篩選功能 ===
    function renderTagFilter() {
      let html = '';

      MAIN_TAGS.forEach(mainTag => {
        const subTags = TAG_TREE[mainTag];
        const hasSubTags = subTags.length > 0;
        const isExpanded = expandedFilterTag === mainTag;
        const isMainActive = selectedFilterTags.includes(mainTag);
        const hasActiveSubTags = selectedFilterTags.some(t => t.startsWith(mainTag + ':'));

        html += \`<span class="filter-group" style="position:relative;">\`;

        if (hasSubTags) {
          html += \`<span class="filter-tag \${isMainActive || hasActiveSubTags ? 'active' : ''}" data-action="popover" data-tag="\${mainTag}">\${mainTag} ▾</span>\`;

          if (isExpanded) {
            html += \`<div class="filter-popover">\`;
            html += \`<span class="filter-sub \${isMainActive ? 'active' : ''}" data-action="toggle" data-tag="\${mainTag}">全部</span>\`;
            html += subTags.map(sub => {
              const fullTag = mainTag + ':' + sub;
              const isSubActive = selectedFilterTags.includes(fullTag);
              return \`<span class="filter-sub \${isSubActive ? 'active' : ''}" data-action="toggle" data-tag="\${fullTag}">\${sub}</span>\`;
            }).join('');
            html += \`</div>\`;
          }
        } else {
          html += \`<span class="filter-tag \${isMainActive ? 'active' : ''}" data-action="toggle" data-tag="\${mainTag}">\${mainTag}</span>\`;
        }

        html += \`</span>\`;
      });

      if (selectedFilterTags.length > 0) {
        html += \`<button class="clear-filter" data-action="clear">✕ 清除</button>\`;
      }

      document.getElementById('tagFilter').innerHTML = html;
    }

    // 篩選事件委派
    document.getElementById('tagFilter').addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      e.stopPropagation();
      const action = target.dataset.action;
      const tag = target.dataset.tag;

      if (action === 'popover' && tag) {
        expandedFilterTag = (expandedFilterTag === tag) ? null : tag;
        renderTagFilter();
      } else if (action === 'toggle' && tag) {
        toggleFilterTag(tag);
      } else if (action === 'clear') {
        clearFilterTags();
      }
    });

    // 點擊外部關閉篩選 popover
    document.addEventListener('click', (e) => {
      if (expandedFilterTag && !e.target.closest('.filter-group') && !e.target.closest('#tagFilter')) {
        expandedFilterTag = null;
        renderTagFilter();
      }
    });

    function toggleFilterTag(tag) {
      if (selectedFilterTags.includes(tag)) {
        selectedFilterTags = selectedFilterTags.filter(t => t !== tag);
        // 如果取消主標籤，也取消該主分類下的所有子標籤
        if (!tag.includes(':')) {
          selectedFilterTags = selectedFilterTags.filter(t => !t.startsWith(tag + ':'));
        }
      } else {
        selectedFilterTags.push(tag);
      }
      currentPage = 1;
      renderTagFilter();
      loadRecords();
    }

    function clearFilterTags() {
      selectedFilterTags = [];
      expandedFilterTag = null;
      currentPage = 1;
      renderTagFilter();
      loadRecords();
    }

    let shouldRestoreScroll = true;  // 初次載入時嘗試恢復滾動位置

    async function loadRecords() {
      if (isLoading) return;
      showSkeleton();
      isLoading = true;

      const params = new URLSearchParams({
        page: currentPage,
        limit: perPage,
        ...(currentType !== 'all' && { type: currentType }),
        ...(searchQuery && { q: searchQuery }),
        ...(selectedFilterTags.length > 0 && { tags: selectedFilterTags.join(',') })
      });

      const res = await fetch('/lurl/api/records?' + params);
      const data = await res.json();
      isLoading = false;

      allRecords = data.records;
      totalRecords = data.total;
      totalPages = Math.ceil(totalRecords / perPage) || 1;

      renderGrid();
      renderPagination();
      loadFavorites();  // 載入收藏狀態

      if (shouldRestoreScroll) {
        shouldRestoreScroll = false;
        restoreScrollPosition();
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }

    function goToPage(page) {
      if (page < 1 || page > totalPages || page === currentPage) return;
      currentPage = page;
      // 更新 URL
      const url = new URL(window.location);
      url.searchParams.set('page', page);
      history.pushState({}, '', url);
      loadRecords();
    }

    function renderPagination() {
      if (totalPages <= 1) {
        document.getElementById('pagination').innerHTML = '';
        return;
      }

      let html = '';
      html += \`<button class="nav-btn" onclick="goToPage(\${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}><span class="nav-icon">‹</span><span class="nav-text">上一頁</span></button>\`;

      // 顯示頁碼邏輯
      const maxVisible = 5;
      let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
      let endPage = Math.min(totalPages, startPage + maxVisible - 1);
      if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
      }

      if (startPage > 1) {
        html += \`<button onclick="goToPage(1)">1</button>\`;
        if (startPage > 2) html += \`<span class="page-info">...</span>\`;
      }

      for (let i = startPage; i <= endPage; i++) {
        html += \`<button onclick="goToPage(\${i})" class="\${i === currentPage ? 'active' : ''}">\${i}</button>\`;
      }

      if (endPage < totalPages) {
        if (endPage < totalPages - 1) html += \`<span class="page-info">...</span>\`;
        html += \`<button onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
      }

      html += \`<button class="nav-btn" onclick="goToPage(\${currentPage + 1})" \${currentPage === totalPages ? 'disabled' : ''}><span class="nav-text">下一頁</span><span class="nav-icon">›</span></button>\`;
      html += \`<span class="page-info">\${currentPage} / \${totalPages}</span>\`;

      document.getElementById('pagination').innerHTML = html;
    }

    function renderGrid() {
      document.getElementById('resultCount').textContent = totalRecords + ' items';

      if (allRecords.length === 0) {
        document.getElementById('grid').innerHTML = '<div class="empty">' +
          (searchQuery ? 'No results for "' + searchQuery + '"' : 'No content yet') + '</div>';
        return;
      }

      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? 'Untitled' : t;

      const html = allRecords.map(r => \`
        <div class="card \${r.blocked ? 'blocked' : ''}" data-record-id="\${r.id}" data-hls-ready="\${r.hlsReady || false}" data-preview-ready="\${r.previewReady || false}" data-preview-path="\${r.previewPath || ''}" data-type="\${r.type}" onclick="navigateToView('\${r.id}')">
          <div class="card-thumb \${r.type === 'image' ? 'image' : ''} \${!r.fileExists ? 'pending' : ''}">
            \${r.fileExists
              ? (r.type === 'image'
                ? \`<img src="/lurl/files/\${r.thumbnailPath || r.backupPath}" alt="\${getTitle(r.title)}" onload="this.classList.add('loaded')" onerror="this.style.display='none'">\`
                : (r.thumbnailExists && r.thumbnailPath
                  ? \`<img src="/lurl/files/\${r.thumbnailPath}" alt="\${getTitle(r.title)}" onload="this.classList.add('loaded')" onerror="this.parentElement.innerHTML='<div class=play-icon></div>'"><div class="play-icon" style="position:absolute;"></div>\`
                  : '<div class="play-icon"></div>'))
              : '<span style="font-size:24px;color:#666">Pending</span>'}
            <button class="btn-favorite \${favoritesMap[r.id] ? 'active' : ''}" onclick="event.stopPropagation();toggleFavorite('\${r.id}')" title="收藏">\${favoritesMap[r.id] ? '⭐' : '☆'}</button>
          </div>
          <div class="card-info">
            <div class="card-title">\${getTitle(r.title)}</div>
            <div class="card-meta">
              <span class="card-date">\${new Date(r.capturedAt).toLocaleDateString()}</span>
              <span class="card-id" onclick="event.stopPropagation();copyId('\${r.id}')" title="Click to copy">#\${r.id}</span>
            </div>
            \${!r.fileExists ? '<div class="card-status">Backup pending</div>' : ''}
            <div class="card-actions">
              <button class="btn-like \${r.myVote === 'like' ? 'active' : ''}" onclick="event.stopPropagation();vote('\${r.id}', 'like')" title="讚">👍 \${r.likeCount || 0}</button>
              <button class="btn-dislike \${r.myVote === 'dislike' ? 'active' : ''}" onclick="event.stopPropagation();vote('\${r.id}', 'dislike')" title="倒讚">👎 \${r.dislikeCount || 0}</button>
              <button class="btn-block" onclick="event.stopPropagation();block('\${r.id}', \${!r.blocked})" title="\${r.blocked ? '解除封鎖' : '封鎖'}">\${r.blocked ? '✅' : '🚫'}</button>
            </div>
            <div class="card-tags" onclick="event.stopPropagation()">
              \${renderTagSelector(r)}
            </div>
          </div>
        </div>
      \`).join('');

      document.getElementById('grid').innerHTML = html;
    }

    function copyId(id) {
      navigator.clipboard.writeText(id);
      showToast('Copied: ' + id);
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    async function vote(id, voteType) {
      const record = allRecords.find(r => r.id === id);
      if (!record) return;

      try {
        const res = await fetch(\`/lurl/api/records/\${id}/vote\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote: voteType })
        });
        const data = await res.json();
        if (data.ok) {
          // 更新本地記錄
          record.likeCount = data.likeCount;
          record.dislikeCount = data.dislikeCount;
          record.myVote = data.myVote;
          renderGrid();
          if (data.myVote === 'like') showToast('👍 已按讚');
          else if (data.myVote === 'dislike') showToast('👎 已倒讚');
          else showToast('已取消投票');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    async function block(id, doBlock) {
      const action = doBlock ? '封鎖此內容？檔案將被刪除。' : '解除封鎖？';
      if (!confirm(action)) return;

      try {
        const res = await fetch(\`/lurl/api/records/\${id}/block\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ block: doBlock })
        });
        const data = await res.json();
        if (data.ok) {
          if (doBlock) {
            // 封鎖後從列表移除（除非在已封鎖 tab）
            if (currentType !== 'blocked') {
              allRecords = allRecords.filter(r => r.id !== id);
              totalRecords--;
            } else {
              const record = allRecords.find(r => r.id === id);
              if (record) record.blocked = true;
            }
          } else {
            // 解除封鎖後從已封鎖列表移除
            if (currentType === 'blocked') {
              allRecords = allRecords.filter(r => r.id !== id);
              totalRecords--;
            }
          }
          renderGrid();
          showToast(doBlock ? '🚫 已封鎖' : '✅ 已解除封鎖');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    // 快速收藏切換
    async function toggleFavorite(id) {
      try {
        const res = await fetch('/lurl/api/collections/quick-add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recordId: id })
        });
        const data = await res.json();
        if (data.ok) {
          favoritesMap[id] = data.isFavorite;
          renderGrid();
          showToast(data.isFavorite ? '⭐ 已收藏' : '已取消收藏');
        } else if (data.error === '收藏功能為老司機專屬') {
          showToast('🔒 收藏功能為老司機專屬');
        } else if (data.error === '未登入') {
          showToast('請先登入');
        } else {
          showToast(data.error || '操作失敗');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    // 載入收藏狀態
    async function loadFavorites() {
      if (allRecords.length === 0) return;
      try {
        const recordIds = allRecords.map(r => r.id).join(',');
        const res = await fetch('/lurl/api/collections/status?recordIds=' + encodeURIComponent(recordIds));
        const data = await res.json();
        if (data.ok) {
          favoritesMap = data.favorites || {};
          renderGrid();
        }
      } catch (e) {
        console.warn('載入收藏狀態失敗');
      }
    }

    // Tab click
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        localStorage.setItem('lurl_browse_tab', currentType);
        currentPage = 1; // 重置頁碼
        loadRecords();
      });
    });

    // Search input with debounce
    let searchTimeout;
    document.getElementById('search').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = e.target.value.trim();
        currentPage = 1; // 重置頁碼
        loadRecords();
      }, 300);
    });

    // URL params
    const urlParams = new URLSearchParams(window.location.search);
    const qParam = urlParams.get('q');
    const pageParam = urlParams.get('page');
    if (qParam) {
      document.getElementById('search').value = qParam;
      searchQuery = qParam;
    }
    if (pageParam) {
      currentPage = parseInt(pageParam) || 1;
    }

    // 瀏覽器上一頁/下一頁
    window.addEventListener('popstate', () => {
      const params = new URLSearchParams(window.location.search);
      currentPage = parseInt(params.get('page')) || 1;
      loadRecords();
    });

    renderTagFilter();
    loadRecords();

    // ==================== Service Worker + 預載 ====================

    // 註冊 Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/lurl/sw.js', { scope: '/lurl/' })
        .then(reg => console.log('[SW] 已註冊', reg.scope))
        .catch(err => console.warn('[SW] 註冊失敗', err));
    }

    // 預載管理器（含 Hover 動態預覽）
    const Preloader = {
      preloading: new Set(),
      observer: null,
      hoverVideo: null,
      hoverCard: null,

      // 初始化
      init() {
        this.setupIntersectionObserver();
        this.setupHoverPreview();
      },

      // 視窗內預載：進入視窗時預載預覽片段
      setupIntersectionObserver() {
        this.observer = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const card = entry.target;
              const recordId = card.dataset.recordId;
              const previewReady = card.dataset.previewReady === 'true';
              const previewPath = card.dataset.previewPath;
              const hlsReady = card.dataset.hlsReady === 'true';
              const type = card.dataset.type;

              if (type !== 'video' || !recordId || this.preloading.has(recordId)) return;

              // 優先預載預覽片段（更小，秒開）
              if (previewReady && previewPath) {
                this.preloadPreview(recordId, previewPath);
              } else if (hlsReady) {
                this.preloadHLS(recordId);
              }
            }
          });
        }, { rootMargin: '200px' }); // 提前 200px 開始預載
      },

      // 預載預覽片段 (~200KB)
      preloadPreview(recordId, previewPath) {
        this.preloading.add(recordId);
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = \`/lurl/files/\${previewPath}\`;
        link.as = 'video';
        document.head.appendChild(link);
      },

      // 預載 HLS（如果沒有預覽片段）
      async preloadHLS(recordId) {
        this.preloading.add(recordId);
        const urls = [
          \`/lurl/hls/\${recordId}/master.m3u8\`,
          \`/lurl/hls/\${recordId}/480p/playlist.m3u8\`
        ];
        try {
          const res = await fetch(\`/lurl/hls/\${recordId}/480p/playlist.m3u8\`);
          if (res.ok) {
            const text = await res.text();
            const segments = text.split('\\n').filter(line => line.endsWith('.ts'));
            if (segments[0]) {
              urls.push(\`/lurl/hls/\${recordId}/480p/\${segments[0]}\`);
            }
          }
        } catch (e) { /* ignore */ }
        this.sendPreloadMessage(urls);
      },

      // Hover 動態預覽：滑鼠移入時播放預覽片段
      setupHoverPreview() {
        let hoverTimer = null;
        const grid = document.getElementById('grid');
        if (!grid) return;

        grid.addEventListener('mouseenter', (e) => {
          const card = e.target.closest('.card');
          if (!card || card === this.hoverCard) return;

          // 清除之前的 hover
          this.clearHoverVideo();

          const previewReady = card.dataset.previewReady === 'true';
          const previewPath = card.dataset.previewPath;
          const type = card.dataset.type;

          if (type !== 'video' || !previewReady || !previewPath) return;

          this.hoverCard = card;

          // 延遲 300ms 開始播放（避免快速滑過）
          hoverTimer = setTimeout(() => {
            this.playHoverVideo(card, previewPath);
          }, 300);
        }, true);

        grid.addEventListener('mouseleave', (e) => {
          const card = e.target.closest('.card');
          if (card === this.hoverCard) {
            if (hoverTimer) {
              clearTimeout(hoverTimer);
              hoverTimer = null;
            }
            this.clearHoverVideo();
          }
        }, true);
      },

      // 播放 Hover 預覽
      playHoverVideo(card, previewPath) {
        const thumbContainer = card.querySelector('.card-thumb');
        if (!thumbContainer) return;

        // 建立 video 元素
        this.hoverVideo = document.createElement('video');
        this.hoverVideo.src = \`/lurl/files/\${previewPath}\`;
        this.hoverVideo.muted = true;
        this.hoverVideo.loop = true;
        this.hoverVideo.playsInline = true;
        this.hoverVideo.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:10;';

        // 隱藏原本的內容
        const img = thumbContainer.querySelector('img');
        const playIcon = thumbContainer.querySelector('.play-icon');
        if (img) img.style.opacity = '0';
        if (playIcon) playIcon.style.opacity = '0';

        thumbContainer.appendChild(this.hoverVideo);
        this.hoverVideo.play().catch(() => {});
      },

      // 清除 Hover 預覽
      clearHoverVideo() {
        if (this.hoverVideo) {
          this.hoverVideo.pause();
          this.hoverVideo.remove();
          this.hoverVideo = null;
        }
        if (this.hoverCard) {
          const thumbContainer = this.hoverCard.querySelector('.card-thumb');
          if (thumbContainer) {
            const img = thumbContainer.querySelector('img');
            const playIcon = thumbContainer.querySelector('.play-icon');
            if (img) img.style.opacity = '';
            if (playIcon) playIcon.style.opacity = '';
          }
          this.hoverCard = null;
        }
      },

      // 發送預載訊息給 Service Worker
      sendPreloadMessage(urls) {
        if (navigator.serviceWorker?.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'preload',
            urls: urls
          });
        }
      },

      // 觀察卡片
      observeCards() {
        document.querySelectorAll('.card[data-record-id]').forEach(card => {
          this.observer?.observe(card);
        });
      }
    };

    // 初始化預載器
    Preloader.init();

    // 在 renderGrid 後觀察卡片
    const originalRenderGrid = renderGrid;
    renderGrid = function() {
      originalRenderGrid.apply(this, arguments);
      setTimeout(() => Preloader.observeCards(), 50);
    };
  </script>
  <div data-adman-id="TO_BE_CREATED" style="max-width:728px;margin:20px auto;"></div>
  <script src="https://adman.isnowfriend.com/embed/adman.js" data-base-url="https://adman.isnowfriend.com"></script>
</body>
</html>`;
}

function viewPage(record, fileExists, user = null) {
  const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? '未命名' : t;
  const title = getTitle(record.title);
  const isVideo = record.type === 'video';
  const canFavorite = user && (user.tier === 'premium' || user.tier === 'admin');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
  <title>${title} - Lurl</title>
  <style>
    :root {
      --bg-body: #f8fafc; --bg-header: #ffffff; --bg-card: #ffffff; --bg-input: #f1f5f9;
      --bg-button: #e2e8f0; --bg-button-hover: #cbd5e1; --bg-media: #1a1a1a;
      --text-primary: #1f2937; --text-secondary: #374151; --text-muted: #64748b;
      --accent: #5BB4D4; --accent-hover: #4AABCC; --accent-pink: #ec4899;
      --border: #e2e8f0; --shadow: rgba(0,0,0,0.08);
    }
    [data-theme="dark"] {
      --bg-body: #0a0a0a; --bg-header: #111111; --bg-card: #161616; --bg-input: #1a1a1a;
      --bg-button: #2a2a2a; --bg-button-hover: #3a3a3a; --bg-media: #000;
      --text-primary: #f0f0f0; --text-secondary: #d0d0d0; --text-muted: #888888;
      --accent: #5BB4D4; --accent-hover: #7EC8E3; --accent-pink: #ec4899;
      --border: #2a2a2a; --shadow: rgba(0,0,0,0.5);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg-body); color: var(--text-primary); min-height: 100vh; transition: background 0.3s, color 0.3s; }
    .header { background: var(--bg-header); color: var(--text-primary); padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px var(--shadow); }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header-actions { display: flex; gap: 8px; margin-left: auto; margin-right: 20px; }
    .header-actions button { background: var(--bg-button); border: none; padding: 8px 12px; border-radius: 8px; font-size: 1.2em; cursor: pointer; transition: all 0.2s; }
    .header-actions button:hover { background: var(--bg-button-hover); }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: var(--text-muted); text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: var(--accent); }
    .theme-toggle { font-size: 1.1em !important; }
    .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
    .media-container { background: #000; border-radius: 12px; overflow: hidden; margin-bottom: 20px; position: relative; min-height: 200px; }
    .media-container video { width: 100%; max-height: 70vh; object-fit: contain; display: block; aspect-ratio: 16/9; background: #000; }
    .media-container img { width: 100%; max-height: 70vh; object-fit: contain; display: block; opacity: 0; transition: opacity 0.3s; }
    .media-container img.loaded { opacity: 1; }
    /* Image Skeleton */
    .img-skeleton {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .img-skeleton.hidden { display: none; }
    .img-skeleton::after {
      content: '';
      width: 60px;
      height: 60px;
      border: 3px solid #333;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    /* Plyr Dark Theme */
    .plyr { --plyr-color-main: #3b82f6; }
    .plyr--video { border-radius: 12px; }
    .plyr__controls { background: linear-gradient(transparent, rgba(0,0,0,0.8)); }
    .plyr__control:hover { background: #3b82f6; }
    .media-missing { color: var(--text-muted); text-align: center; padding: 40px; }
    .media-missing p { margin-bottom: 15px; }
    .info { background: var(--bg-card); border-radius: 12px; padding: 20px; border: 1px solid var(--border); }
    .info h2 { font-size: 1.3em; margin-bottom: 15px; line-height: 1.4; color: var(--text-primary); }
    .info-row { display: flex; gap: 10px; margin-bottom: 10px; color: var(--text-secondary); font-size: 0.9em; }
    .info-row span { color: var(--text-muted); }
    .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
    .btn { padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 0.95em; border: none; cursor: pointer; }
    .btn-primary { background: var(--accent); color: white; }
    .btn-secondary { background: var(--bg-button); color: var(--text-secondary); }
    .btn-warning { background: #f59e0b; color: white; }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .back-link { display: inline-block; margin-bottom: 20px; color: var(--text-muted); text-decoration: none; }
    .back-link:hover { color: var(--accent); }
    .status { margin-top: 10px; font-size: 0.9em; }
    .status.success { color: #4ade80; }
    .status.error { color: #f87171; }

    /* Tags */
    .tags-section { display: flex; align-items: center; gap: 10px; margin: 15px 0; flex-wrap: wrap; }
    .tags-label { color: var(--text-muted); font-size: 0.9em; }
    .tags { display: flex; flex-wrap: wrap; gap: 8px; }
    .tag {
      padding: 6px 14px;
      border-radius: 16px;
      font-size: 0.85em;
      cursor: pointer;
      background: var(--bg-button);
      color: var(--text-muted);
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .tag:hover { background: var(--bg-button-hover); color: var(--text-secondary); border-color: var(--border); }
    .tag.active { background: var(--accent-pink); color: white; border-color: var(--accent-pink); }
    .tag-group { display: inline-flex; align-items: center; position: relative; }
    .tag-popover {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      z-index: 9999;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 140px;
      box-shadow: 0 4px 12px var(--shadow);
    }
    .tag-popover .tag.sub {
      font-size: 0.8em;
      padding: 6px 12px;
      background: var(--bg-button);
    }
    .tag-popover .tag.sub.active { background: var(--accent-pink); border-color: var(--accent-pink); }

    /* Favorite Menu */
    .favorite-wrapper { display: inline-block; }
    .favorite-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      min-width: 220px;
      box-shadow: 0 8px 24px var(--shadow);
      z-index: 1000;
    }
    .favorite-menu-header {
      font-size: 0.9em;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .favorite-menu-list { max-height: 200px; overflow-y: auto; }
    .favorite-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 8px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .favorite-menu-item:hover { background: var(--bg-button); }
    .favorite-menu-item input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--accent-pink);
    }
    .favorite-menu-item span { flex: 1; font-size: 0.9em; }
    .favorite-menu-add {
      width: 100%;
      margin-top: 10px;
      padding: 10px;
      background: transparent;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 0.85em;
      transition: all 0.2s;
    }
    .favorite-menu-add:hover {
      border-color: var(--accent-pink);
      color: var(--accent-pink);
    }
    .favorite-locked {
      text-align: center;
      padding: 20px 10px;
      color: var(--text-muted);
      font-size: 0.85em;
    }
    .favorite-locked a { color: var(--accent-pink); }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; }

    /* ===== RWD 響應式設計 ===== */
    @media (max-width: 767px) {
      .header { padding: 12px 16px; }
      .header .logo { height: 28px; }
      .header h1 { font-size: 1.1em; }
      .header nav { gap: 12px; }
      .header nav a { font-size: 0.85em; }

      .container { padding: 12px; }
      .media-container { border-radius: 8px; margin-bottom: 16px; }
      .media-container video, .media-container img { max-height: 50vh; }

      .back-link { margin-bottom: 12px; font-size: 0.9em; }
      .info { padding: 16px; border-radius: 10px; }
      .info h2 { font-size: 1.1em; margin-bottom: 12px; }
      .info-row { font-size: 0.85em; flex-wrap: wrap; }

      .actions { gap: 8px; }
      .btn { padding: 10px 16px; font-size: 0.9em; flex: 1; min-width: 120px; text-align: center; }
    }

    @media (max-width: 479px) {
      .header { padding: 10px 12px; }
      .header .logo { height: 24px; }
      .header nav a { font-size: 0.8em; }

      .container { padding: 10px; }
      .media-container { border-radius: 6px; }
      .media-container video, .media-container img { max-height: 40vh; }

      .info { padding: 12px; border-radius: 8px; }
      .info h2 { font-size: 1em; }
      .info-row { font-size: 0.8em; margin-bottom: 8px; }

      .actions { flex-direction: column; }
      .btn { width: 100%; min-height: 44px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <a href="/lurl/" class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
    </a>
    <div class="header-actions">
      <button class="theme-toggle" onclick="toggleTheme()" title="切換主題">🌙</button>
    </div>
    <nav>
      <a href="/lurl/">首頁</a>
      <a href="/lurl/browse">瀏覽</a>
      <a href="/lurl/member/collections">⭐ 收藏</a>
      <a href="/lurl/admin">管理</a>
    </nav>
  </div>
  <div class="container">
    <a href="javascript:history.back()" class="back-link">← 返回</a>
    <div class="media-container">
      ${fileExists
        ? (isVideo
          ? `<video id="player" playsinline controls ${record.thumbnailPath ? `poster="/lurl/files/${record.thumbnailPath}" data-poster="/lurl/files/${record.thumbnailPath}"` : ''}></video>`
          : `<div class="img-skeleton" id="imgSkeleton"></div>
             <img src="/lurl/files/${record.backupPath}" alt="${title}" onload="this.classList.add('loaded'); document.getElementById('imgSkeleton').classList.add('hidden');">`)
        : `<div class="media-missing">
            <p>⚠️ 檔案尚未下載成功</p>
            <p style="font-size:0.8em;color:#555;">原始位置：${record.fileUrl}</p>
          </div>`
      }
    </div>
    ${isVideo && fileExists ? `
    <div class="quality-info" style="text-align:center; margin-bottom:10px; font-size:0.85em; color:#666;">
      ${record.hlsReady ? '🎬 HLS 串流（可選畫質）' : '📹 原始檔案'}
    </div>
    ` : ''}
    <div class="info">
      <h2>${title}</h2>
      <div class="info-row"><span>類型：</span>${isVideo ? '影片' : '圖片'}</div>
      <div class="info-row"><span>來源：</span>${record.source || 'lurl'}</div>
      <div class="info-row"><span>收錄時間：</span>${new Date(record.capturedAt).toLocaleString('zh-TW')}</div>
      <div class="info-row"><span>本地檔案：</span>${fileExists ? '✅ 已備份' : '❌ 未備份'}</div>
      <div class="info-row" style="word-break:break-all;"><span>原始頁面：</span><a href="${record.pageUrl}" target="_blank" style="color:#4a9eff;font-size:0.85em;">${record.pageUrl}</a></div>
      <div class="info-row" style="word-break:break-all;"><span>CDN：</span><span style="color:#555;font-size:0.85em;">${record.fileUrl}</span></div>
      <div class="tags-section">
        <span class="tags-label">標籤：</span>
        <div class="tags" id="tags"></div>
      </div>
      <div class="actions">
        ${fileExists ? `<a href="/lurl/files/${record.backupPath}" download class="btn btn-primary">下載</a>` : ''}
        ${record.ref ? `<a href="${record.ref}" target="_blank" class="btn btn-secondary">📖 D卡文章</a>` : ''}
        <div class="favorite-wrapper" style="position:relative;">
          <button class="btn btn-secondary" id="favoriteBtn" onclick="toggleFavoriteMenu()">
            <span id="favIcon">${canFavorite ? '⭐' : '🔒'}</span> 收藏
          </button>
          <div class="favorite-menu" id="favoriteMenu" style="display:none;">
            <div class="favorite-menu-header">收藏到...</div>
            <div class="favorite-menu-list" id="favoriteList">載入中...</div>
            <button class="favorite-menu-add" onclick="createNewCollection()">+ 新增收藏夾</button>
          </div>
        </div>
        ${!fileExists ? `<a href="${record.pageUrl}" target="_blank" class="btn btn-warning">🔄 重新下載（需安裝腳本）</a>` : ''}
      </div>
      ${!fileExists ? `<div class="status" style="margin-top:15px;color:#888;font-size:0.85em;">💡 點擊「重新下載」會開啟原始頁面，若已安裝 Tampermonkey 腳本，將自動備份檔案</div>` : ''}
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const recordId = '${record.id}';
    let currentTags = ${JSON.stringify(record.tags || [])};
    let expandedTag = null;

    const TAG_TREE = {
      '奶子': ['穿衣', '裸體', '大奶', '露點'],
      '屁股': [],
      '鮑魚': [],
      '全身': [],
      '姿勢': ['女上', '傳教士', '背後'],
      '口交': []
    };
    const MAIN_TAGS = Object.keys(TAG_TREE);

    function hasMainTag(tags, mainTag) {
      return tags.some(t => t === mainTag || t.startsWith(mainTag + ':'));
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    function renderTags() {
      const container = document.getElementById('tags');
      let html = '';

      MAIN_TAGS.forEach(mainTag => {
        const isActive = hasMainTag(currentTags, mainTag);  // 該分類是否有任何標籤被選
        const subTags = TAG_TREE[mainTag];
        const hasSubTags = subTags.length > 0;
        const isExpanded = expandedTag === mainTag;

        html += '<span class="tag-group">';

        if (hasSubTags) {
          // 有子標籤：點擊切換母標籤 + 展開子選項
          html += '<span class="tag ' + (isActive ? 'active' : '') + '" data-action="popover" data-tag="' + mainTag + '">' + mainTag + ' ▾</span>';

          if (isExpanded) {
            html += '<div class="tag-popover">';
            // 只顯示子標籤
            subTags.forEach(sub => {
              const fullTag = mainTag + ':' + sub;
              const isSubActive = currentTags.includes(fullTag);
              html += '<span class="tag sub ' + (isSubActive ? 'active' : '') + '" data-action="toggle" data-tag="' + fullTag + '">' + sub + '</span>';
            });
            html += '</div>';
          }
        } else {
          // 沒有子標籤：直接切換
          html += '<span class="tag ' + (isActive ? 'active' : '') + '" data-action="toggle" data-tag="' + mainTag + '">' + mainTag + '</span>';
        }

        html += '</span>';
      });

      container.innerHTML = html;
    }

    // 使用事件委派處理 tag 點擊
    document.getElementById('tags').addEventListener('click', function(e) {
      // 處理 tag 點擊
      const target = e.target.closest('.tag');
      if (!target) return;

      e.preventDefault();
      e.stopPropagation();

      const action = target.dataset.action;
      const tag = target.dataset.tag;

      if (action === 'popover' && tag) {
        // 點母標籤：同時切換母標籤 + 展開子選項
        toggleTag(tag);
        expandedTag = (expandedTag === tag) ? null : tag;
        renderTags();
      } else if (action === 'toggle' && tag) {
        toggleTag(tag);
      }
    });

    document.addEventListener('click', (e) => {
      if (expandedTag && !e.target.closest('.tag-group')) {
        expandedTag = null;
        renderTags();
      }
    });

    async function toggleTag(tag) {
      const newTags = currentTags.includes(tag)
        ? currentTags.filter(t => t !== tag)
        : [...currentTags, tag];

      try {
        const res = await fetch('/lurl/api/records/' + recordId + '/tags', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: newTags })
        });
        const data = await res.json();
        if (data.ok) {
          currentTags = data.tags;
          renderTags();
        }
      } catch (e) {
        showToast('標籤更新失敗');
      }
    }

    renderTags();

    // ===== 收藏功能 =====
    const canFavorite = ${canFavorite};
    const isLoggedIn = ${!!user};
    let favoriteMenuOpen = false;
    let collections = [];

    async function toggleFavoriteMenu() {
      const menu = document.getElementById('favoriteMenu');
      const list = document.getElementById('favoriteList');

      if (!isLoggedIn) {
        window.location.href = '/lurl/login?redirect=/lurl/view/' + recordId;
        return;
      }

      if (!canFavorite) {
        list.innerHTML = '<div class="favorite-locked">🔒 升級為老司機即可使用收藏功能<br><a href="/lurl/member/upgrade">立即升級</a></div>';
        document.querySelector('.favorite-menu-add').style.display = 'none';
        menu.style.display = favoriteMenuOpen ? 'none' : 'block';
        favoriteMenuOpen = !favoriteMenuOpen;
        return;
      }

      if (favoriteMenuOpen) {
        menu.style.display = 'none';
        favoriteMenuOpen = false;
        return;
      }

      menu.style.display = 'block';
      favoriteMenuOpen = true;
      list.innerHTML = '載入中...';

      try {
        const res = await fetch('/lurl/api/collections?recordId=' + recordId);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        collections = data.collections;
        renderCollectionList();
      } catch (e) {
        list.innerHTML = '<div style="color:#f87171;padding:10px;">載入失敗</div>';
      }
    }

    function renderCollectionList() {
      const list = document.getElementById('favoriteList');
      if (collections.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);padding:10px;text-align:center;">還沒有收藏夾<br>點擊下方新增</div>';
        return;
      }

      list.innerHTML = collections.map(c =>
        '<label class="favorite-menu-item">' +
          '<input type="checkbox" ' + (c.hasRecord ? 'checked' : '') + ' onchange="toggleCollection(\\'' + c.id + '\\', this.checked)">' +
          '<span>' + c.name + '</span>' +
        '</label>'
      ).join('');
    }

    async function toggleCollection(collectionId, checked) {
      try {
        if (checked) {
          await fetch('/lurl/api/collections/' + collectionId + '/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recordId })
          });
          showToast('已加入收藏');
        } else {
          await fetch('/lurl/api/collections/' + collectionId + '/items/' + recordId, {
            method: 'DELETE'
          });
          showToast('已移除收藏');
        }
        // 更新本地狀態
        const col = collections.find(c => c.id === collectionId);
        if (col) col.hasRecord = checked;
        updateFavoriteIcon();
      } catch (e) {
        showToast('操作失敗');
      }
    }

    function updateFavoriteIcon() {
      const icon = document.getElementById('favIcon');
      const hasAny = collections.some(c => c.hasRecord);
      icon.textContent = hasAny ? '⭐' : '☆';
    }

    async function createNewCollection() {
      const name = prompt('輸入收藏夾名稱：');
      if (!name) return;

      try {
        const res = await fetch('/lurl/api/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.ok) {
          collections.unshift({ ...data.collection, hasRecord: false });
          renderCollectionList();
          showToast('收藏夾已建立');
        }
      } catch (e) {
        showToast('建立失敗');
      }
    }

    // 點擊外部關閉選單
    document.addEventListener('click', (e) => {
      if (favoriteMenuOpen && !e.target.closest('.favorite-wrapper')) {
        document.getElementById('favoriteMenu').style.display = 'none';
        favoriteMenuOpen = false;
      }
    });
  </script>
  ${isVideo && fileExists ? `
  <script src="https://cdn.plyr.io/3.7.8/plyr.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <script>
    const video = document.getElementById('player');
    const hlsReady = ${record.hlsReady || false};
    const hlsUrl = '/lurl/hls/${record.id}/master.m3u8';
    const mp4Url = '/lurl/files/${record.backupPath}';
    const previewUrl = ${record.previewReady ? `'/lurl/files/${record.previewPath}'` : 'null'};
    const isShortVideo = ${record.isShortVideo || false};
    const posterUrl = ${record.thumbnailPath ? `'/lurl/files/${record.thumbnailPath}'` : 'null'};

    let hls = null;
    let currentPlayer = null;
    let hlsSwitched = false;

    function initPlayer() {
      // 設定 poster（縮圖）
      if (posterUrl) {
        video.poster = posterUrl;
      }

      const plyrOptions = {
        controls: [
          'play-large', 'play', 'progress', 'current-time', 'mute',
          'volume', 'settings', 'pip', 'fullscreen'
        ],
        settings: ['quality', 'speed'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        keyboard: { focused: true, global: true },
        storage: { enabled: true, key: 'plyr' }
      };

      // 短影片：直接用 MP4
      if (isShortVideo) {
        video.src = mp4Url;
        currentPlayer = new Plyr(video, plyrOptions);
        setupPlayer(currentPlayer);
        console.log('[Player] 短影片，直接播放 MP4');
        return;
      }

      // 策略：預覽片段秒開 + HLS 背景載入 + 無縫切換
      if (hlsReady && Hls.isSupported()) {
        // 1. 如果有預覽片段，先用預覽片段秒開
        if (previewUrl) {
          video.src = previewUrl;
          currentPlayer = new Plyr(video, plyrOptions);
          setupPlayer(currentPlayer);
          console.log('[Player] 預覽片段秒開');
        }
        // 沒有預覽片段，等 HLS 載入後再初始化（舊影片的情況）
        else {
          console.log('[Player] 無預覽片段，等待 HLS 載入...');
        }

        // 2. 背景載入 HLS
        hls = new Hls({
          maxBufferLength: 5,
          maxMaxBufferLength: 15,
          maxBufferSize: 30 * 1000 * 1000,
          maxBufferHole: 0.5,
          startLevel: 0,
          abrEwmaDefaultEstimate: 500000,
          enableWorker: true,
          startFragPrefetch: true,
          backBufferLength: 30
        });
        hls.loadSource(hlsUrl);

        // 3. HLS 準備好後處理
        hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
          if (hlsSwitched) return;

          // 設定畫質選項
          const availableQualities = hls.levels.map(l => l.height);
          availableQualities.unshift(0); // 自動

          const hlsPlyrOptions = {
            ...plyrOptions,
            quality: {
              default: 0,
              options: availableQualities,
              forced: true,
              onChange: (quality) => updateQuality(quality)
            },
            i18n: {
              qualityLabel: { 0: '自動' }
            }
          };

          // 有預覽片段：無縫切換
          if (currentPlayer) {
            const currentTime = video.currentTime;
            const wasPlaying = !video.paused;
            const volume = video.volume;
            const muted = video.muted;
            const playbackRate = video.playbackRate;

            console.log('[Player] HLS 準備好，切換中... (位置: ' + currentTime.toFixed(1) + 's)');

            hls.attachMedia(video);
            hlsSwitched = true;

            currentPlayer.destroy();
            currentPlayer = new Plyr(video, hlsPlyrOptions);
            setupPlayer(currentPlayer);

            // 恢復播放狀態
            video.currentTime = currentTime;
            video.volume = volume;
            video.muted = muted;
            video.playbackRate = playbackRate;
            if (wasPlaying) {
              video.play().catch(() => {});
            }

            console.log('[Player] 已切換到 HLS，支援多畫質');
          }
          // 無預覽片段：直接播放 HLS
          else {
            console.log('[Player] HLS 準備好，直接播放');
            hls.attachMedia(video);
            hlsSwitched = true;
            currentPlayer = new Plyr(video, hlsPlyrOptions);
            setupPlayer(currentPlayer);
          }
        });

        hls.on(Hls.Events.ERROR, function(event, data) {
          if (data.fatal) {
            console.error('[Player] HLS 載入失敗，繼續使用快速啟動源', data);
            // 不需要做什麼，已經在用快速啟動源了
          }
        });
      }
      // Safari 原生 HLS 支援
      else if (hlsReady && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        currentPlayer = new Plyr(video, plyrOptions);
        setupPlayer(currentPlayer);
      }
      // 原始 MP4（無 HLS）
      else {
        video.src = mp4Url;
        currentPlayer = new Plyr(video, plyrOptions);
        setupPlayer(currentPlayer);
      }
    }

    function updateQuality(newQuality) {
      if (!hls) return;
      if (newQuality === 0) {
        hls.currentLevel = -1; // 自動
      } else {
        hls.levels.forEach((level, index) => {
          if (level.height === newQuality) {
            hls.currentLevel = index;
          }
        });
      }
    }

    function setupPlayer(player) {
      // 設定 poster（縮圖）
      if (posterUrl) {
        player.poster = posterUrl;
      }

      // 檢查靜音模式
      const globalMuted = localStorage.getItem('lurl_muted') === 'true';
      if (globalMuted) {
        player.muted = true;
      }

      // 自動播放
      player.on('ready', () => {
        player.play().catch(() => {});
      });
    }

    initPlayer();
  </script>
  ` : ''}
  <script>
    // 記錄觀看歷史
    (function() {
      const recordId = '${record.id}';
      fetch('/lurl/api/member/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId, progress: 0 })
      }).catch(() => {});  // 忽略錯誤（未登入時會失敗）
    })();

    // 主題切換
    function toggleTheme() {
      const html = document.documentElement;
      const isDark = html.getAttribute('data-theme') === 'dark';
      html.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('lurl-theme', isDark ? 'light' : 'dark');
      document.querySelector('.theme-toggle').textContent = isDark ? '🌙' : '☀️';
    }
    (function() {
      const saved = localStorage.getItem('lurl-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = saved || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('.theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    })();
  </script>
</body>
</html>`;
}

// ==================== 主處理器 ====================

module.exports = {
  match(req) {
    return req.url.startsWith('/lurl');
  },

  async handle(req, res) {
    const fullPath = req.url.split('?')[0];
    const urlPath = fullPath.replace(/^\/lurl/, '') || '/';
    const query = parseQuery(req.url);

    console.log(`[lurl] ${req.method} ${urlPath}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // ==================== 登入系統 ====================

    // GET /login - 登入頁面
    if (req.method === 'GET' && urlPath === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage());
      return;
    }

    // POST /login - 處理登入
    if (req.method === 'POST' && urlPath === '/login') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const password = params.get('password');
        const redirect = params.get('redirect') || '/lurl/browse';

        if (password === ADMIN_PASSWORD) {
          const sessionToken = generateSessionToken(password);
          res.writeHead(302, {
            'Set-Cookie': `lurl_session=${sessionToken}; Path=/lurl; HttpOnly; SameSite=Strict; Max-Age=86400`,
            'Location': redirect
          });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginPage('密碼錯誤'));
        }
      });
      return;
    }

    // GET /logout - 登出
    if (req.method === 'GET' && urlPath === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': 'lurl_session=; Path=/lurl; HttpOnly; Max-Age=0',
        'Location': '/lurl/login'
      });
      res.end();
      return;
    }

    // ==================== 公開頁面 ====================

    // GET / - Landing 首頁
    if (req.method === 'GET' && urlPath === '/') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), landingPage());
      return;
    }

    // GET /download - 腳本下載
    if (req.method === 'GET' && urlPath === '/download') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), downloadPage());
      return;
    }

    // GET /pricing - 價格方案
    if (req.method === 'GET' && urlPath === '/pricing') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), pricingPage());
      return;
    }

    // GET /guide - 使用教學
    if (req.method === 'GET' && urlPath === '/guide') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), guidePage());
      return;
    }

    // GET /feedback - 意見回饋
    if (req.method === 'GET' && urlPath === '/feedback') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), feedbackPage());
      return;
    }

    // ==================== 會員認證 API ====================

    // GET /member/login - 會員登入頁
    if (req.method === 'GET' && urlPath === '/member/login') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), memberLoginPage());
      return;
    }

    // GET /member/register - 會員註冊頁
    if (req.method === 'GET' && urlPath === '/member/register') {
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), memberRegisterPage());
      return;
    }

    // POST /api/auth/register - 會員註冊
    if (req.method === 'POST' && urlPath === '/api/auth/register') {
      try {
        const body = await parseBody(req);
        const { email, password, nickname } = body;

        if (!email || !password) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '請填寫 Email 和密碼' }));
          return;
        }

        // 驗證 email 格式
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: 'Email 格式不正確' }));
          return;
        }

        // 密碼長度檢查
        if (password.length < 6) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '密碼至少需要 6 個字元' }));
          return;
        }

        // 檢查 email 是否已註冊
        const existing = lurlDb.getUserByEmail(email);
        if (existing) {
          res.writeHead(409, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '此 Email 已被註冊' }));
          return;
        }

        // 建立帳號
        const userId = crypto.randomUUID();
        const passwordHash = hashPassword(password);
        const now = new Date().toISOString();

        const user = lurlDb.createUser({
          id: userId,
          email,
          passwordHash,
          nickname: nickname || email.split('@')[0],
          tier: 'free',
          quotaBalance: FREE_QUOTA,
          createdAt: now,
          lastLoginAt: now
        });

        // 產生 JWT
        const token = generateJWT({ userId: user.id, email: user.email });

        res.writeHead(200, {
          ...corsHeaders(),
          'Set-Cookie': `lurl_member_token=${token}; Path=/lurl; HttpOnly; SameSite=Strict; Max-Age=${JWT_EXPIRES / 1000}`
        });
        res.end(JSON.stringify({
          ok: true,
          user: { id: user.id, email: user.email, nickname: user.nickname, tier: user.tier },
          token
        }));
      } catch (err) {
        console.error('[auth] 註冊失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '註冊失敗' }));
      }
      return;
    }

    // POST /api/auth/login - 會員登入
    if (req.method === 'POST' && urlPath === '/api/auth/login') {
      try {
        const body = await parseBody(req);
        const { email, password } = body;

        if (!email || !password) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '請填寫 Email 和密碼' }));
          return;
        }

        const user = lurlDb.getUserByEmail(email);
        if (!user) {
          res.writeHead(401, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: 'Email 或密碼錯誤' }));
          return;
        }

        if (!verifyPassword(password, user.passwordHash)) {
          res.writeHead(401, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: 'Email 或密碼錯誤' }));
          return;
        }

        // 更新最後登入時間
        lurlDb.updateUser(user.id, { lastLoginAt: new Date().toISOString() });

        // 產生 JWT
        const token = generateJWT({ userId: user.id, email: user.email });

        res.writeHead(200, {
          ...corsHeaders(),
          'Set-Cookie': `lurl_member_token=${token}; Path=/lurl; HttpOnly; SameSite=Strict; Max-Age=${JWT_EXPIRES / 1000}`
        });
        res.end(JSON.stringify({
          ok: true,
          user: { id: user.id, email: user.email, nickname: user.nickname, tier: user.tier },
          token
        }));
      } catch (err) {
        console.error('[auth] 登入失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '登入失敗' }));
      }
      return;
    }

    // POST /api/auth/logout - 會員登出
    if (req.method === 'POST' && urlPath === '/api/auth/logout') {
      res.writeHead(200, {
        ...corsHeaders(),
        'Set-Cookie': 'lurl_member_token=; Path=/lurl; HttpOnly; Max-Age=0'
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/auth/me - 取得當前會員資訊
    if (req.method === 'GET' && urlPath === '/api/auth/me') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          tier: user.tier,
          tierExpiry: user.tierExpiry,
          quotaBalance: user.quotaBalance
        }
      }));
      return;
    }

    // GET /member/quota - 會員額度頁面
    if (req.method === 'GET' && urlPath === '/member/quota') {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/member/quota' });
        res.end();
        return;
      }
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), memberQuotaPage(user));
      return;
    }

    // GET /api/member/quota - 取得會員額度資訊
    if (req.method === 'GET' && urlPath === '/api/member/quota') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      // 計算額度資訊
      const tierQuotas = { free: 3, basic: 30, premium: -1 }; // -1 = 無限
      const monthlyQuota = tierQuotas[user.tier] || 3;
      const isUnlimited = user.tier === 'premium';

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        quota: {
          balance: user.quotaBalance,
          monthlyQuota,
          tier: user.tier,
          tierExpiry: user.tierExpiry,
          isUnlimited
        }
      }));
      return;
    }

    // POST /api/member/use-quota - 消耗會員額度
    if (req.method === 'POST' && urlPath === '/api/member/use-quota') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      // 進階會員不需要消耗額度
      if (user.tier === 'premium') {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, unlimited: true }));
        return;
      }

      // 檢查額度
      if (user.quotaBalance <= 0) {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '額度不足' }));
        return;
      }

      // 消耗額度
      lurlDb.updateUser(user.id, { quotaBalance: user.quotaBalance - 1 });

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        remaining: user.quotaBalance - 1
      }));
      return;
    }

    // ==================== Member History ====================

    // GET /member/history - 觀看歷史頁面
    if (req.method === 'GET' && urlPath === '/member/history') {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/member/history' });
        res.end();
        return;
      }
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), memberHistoryPage(user));
      return;
    }

    // GET /api/member/history - 取得觀看歷史
    if (req.method === 'GET' && urlPath === '/api/member/history') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const limit = parseInt(query.limit) || 20;
      const offset = parseInt(query.offset) || 0;
      const history = lurlDb.getWatchHistory(user.id, limit, offset);
      const total = lurlDb.getWatchHistoryCount(user.id);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, history, total }));
      return;
    }

    // POST /api/member/history - 記錄觀看歷史
    if (req.method === 'POST' && urlPath === '/api/member/history') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { recordId, progress } = body;

        if (!recordId) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 recordId' }));
          return;
        }

        lurlDb.upsertWatchHistory(user.id, recordId, progress || 0);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[history] 記錄失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄失敗' }));
      }
      return;
    }

    // DELETE /api/member/history - 清除全部歷史
    if (req.method === 'DELETE' && urlPath === '/api/member/history') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      lurlDb.clearWatchHistory(user.id);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/member/history/:recordId - 刪除單筆歷史
    if (req.method === 'DELETE' && urlPath.startsWith('/api/member/history/')) {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const recordId = urlPath.replace('/api/member/history/', '');
      lurlDb.deleteWatchHistoryItem(user.id, recordId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== Member Profile ====================

    // GET /member/profile - 個人資料頁面
    if (req.method === 'GET' && urlPath === '/member/profile') {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/member/profile' });
        res.end();
        return;
      }
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), memberProfilePage(user));
      return;
    }

    // PUT /api/member/profile - 更新個人資料
    if (req.method === 'PUT' && urlPath === '/api/member/profile') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { nickname } = body;

        // 驗證暱稱
        if (nickname && nickname.length > 20) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '暱稱最多 20 個字元' }));
          return;
        }

        lurlDb.updateUser(user.id, { nickname: nickname || null });
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[profile] 更新失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '更新失敗' }));
      }
      return;
    }

    // PUT /api/member/password - 變更密碼
    if (req.method === 'PUT' && urlPath === '/api/member/password') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { currentPassword, newPassword } = body;

        if (!currentPassword || !newPassword) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '請填寫完整' }));
          return;
        }

        if (newPassword.length < 6) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '新密碼至少需要 6 個字元' }));
          return;
        }

        // 驗證目前密碼
        if (!verifyPassword(currentPassword, user.passwordHash)) {
          res.writeHead(401, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '目前密碼錯誤' }));
          return;
        }

        // 更新密碼
        const newHash = hashPassword(newPassword);
        lurlDb.updateUser(user.id, { passwordHash: newHash });

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[password] 變更失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '變更失敗' }));
      }
      return;
    }

    // DELETE /api/member/account - 刪除帳號
    if (req.method === 'DELETE' && urlPath === '/api/member/account') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      try {
        // 刪除相關資料
        lurlDb.clearWatchHistory(user.id);
        lurlDb.deleteUser(user.id);

        res.writeHead(200, {
          ...corsHeaders(),
          'Set-Cookie': 'lurl_member_token=; Path=/lurl; HttpOnly; Max-Age=0'
        });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[account] 刪除失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '刪除失敗' }));
      }
      return;
    }

    // ==================== Collections ====================

    // GET /member/collections - 收藏列表頁面
    if (req.method === 'GET' && urlPath === '/member/collections') {
      let user = getMemberFromRequest(req);
      // 支援 admin 登入
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        // 統一導向 admin 登入頁
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/member/collections' });
        res.end();
        return;
      }
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), memberCollectionsPage(user));
      return;
    }

    // GET /member/collections/:id - 收藏夾詳情頁面
    if (req.method === 'GET' && urlPath.startsWith('/member/collections/') && !urlPath.includes('/api/')) {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl' + urlPath });
        res.end();
        return;
      }

      const collectionId = urlPath.replace('/member/collections/', '');
      const collection = lurlDb.getCollection(collectionId);

      if (!collection || collection.userId !== user.id) {
        res.writeHead(404, corsHeaders('text/html; charset=utf-8'));
        res.end('<h1>收藏夾不存在</h1>');
        return;
      }

      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), collectionDetailPage(user, collection));
      return;
    }

    // GET /api/collections/status - 批量查詢收藏狀態
    if (req.method === 'GET' && urlPath === '/api/collections/status') {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, favorites: {} }));
        return;
      }

      if (user.tier !== 'premium' && user.tier !== 'admin') {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, favorites: {} }));
        return;
      }

      const recordIds = (query.recordIds || '').split(',').filter(Boolean);
      const favorites = {};

      // 取得用戶的所有收藏項目
      const collections = lurlDb.getCollections(user.id);
      for (const c of collections) {
        const items = lurlDb.getCollectionItems(c.id);
        for (const item of items) {
          if (recordIds.includes(item.recordId)) {
            favorites[item.recordId] = true;
          }
        }
      }

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, favorites }));
      return;
    }

    // POST /api/collections/quick-add - 快速加入預設收藏
    if (req.method === 'POST' && urlPath === '/api/collections/quick-add') {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      if (user.tier !== 'premium' && user.tier !== 'admin') {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏功能為老司機專屬' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { recordId } = body;

        if (!recordId) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 recordId' }));
          return;
        }

        // 找到或建立預設收藏夾
        let collections = lurlDb.getCollections(user.id);
        let defaultCollection = collections.find(c => c.name === '預設收藏');
        if (!defaultCollection) {
          defaultCollection = lurlDb.createCollection(user.id, '預設收藏', true);
        }

        // 檢查是否已收藏
        const isInAny = collections.some(c => lurlDb.isInCollection(c.id, recordId));

        if (isInAny) {
          // 已收藏，從所有收藏夾移除
          for (const c of collections) {
            if (lurlDb.isInCollection(c.id, recordId)) {
              lurlDb.removeFromCollection(c.id, recordId);
            }
          }
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, action: 'removed', isFavorite: false }));
        } else {
          // 未收藏，加入預設收藏夾
          lurlDb.addToCollection(defaultCollection.id, recordId);
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, action: 'added', isFavorite: true }));
        }
      } catch (err) {
        console.error('[collections] 快速收藏失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '操作失敗' }));
      }
      return;
    }

    // GET /api/collections - 取得收藏夾列表
    if (req.method === 'GET' && urlPath === '/api/collections') {
      let user = getMemberFromRequest(req);
      // 支援 admin 登入使用收藏功能
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      if (user.tier !== 'premium' && user.tier !== 'admin') {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏功能為老司機專屬' }));
        return;
      }

      const collections = lurlDb.getCollections(user.id);
      const recordId = query.recordId; // 可選：查詢特定內容是否已收藏

      // 為每個收藏夾加入項目數量和收藏狀態
      const collectionsWithCount = collections.map(c => ({
        ...c,
        itemCount: lurlDb.getCollectionItemCount(c.id),
        hasRecord: recordId ? lurlDb.isInCollection(c.id, recordId) : undefined
      }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, collections: collectionsWithCount }));
      return;
    }

    // POST /api/collections - 建立收藏夾
    if (req.method === 'POST' && urlPath === '/api/collections') {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      if (user.tier !== 'premium' && user.tier !== 'admin') {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏功能為老司機專屬' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { name, isPrivate } = body;

        if (!name || name.length > 30) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '收藏夾名稱無效' }));
          return;
        }

        const collection = lurlDb.createCollection(user.id, name, isPrivate !== false);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, collection }));
      } catch (err) {
        console.error('[collections] 建立失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '建立失敗' }));
      }
      return;
    }

    // PUT /api/collections/:id - 更新收藏夾
    if (req.method === 'PUT' && urlPath.startsWith('/api/collections/') && !urlPath.includes('/items')) {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const collectionId = urlPath.replace('/api/collections/', '');
      const collection = lurlDb.getCollection(collectionId);

      if (!collection || collection.userId !== user.id) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏夾不存在' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { name, isPrivate } = body;

        lurlDb.updateCollection(collectionId, { name, isPrivate });
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[collections] 更新失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '更新失敗' }));
      }
      return;
    }

    // DELETE /api/collections/:id - 刪除收藏夾
    if (req.method === 'DELETE' && urlPath.startsWith('/api/collections/') && !urlPath.includes('/items')) {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const collectionId = urlPath.replace('/api/collections/', '');
      const collection = lurlDb.getCollection(collectionId);

      if (!collection || collection.userId !== user.id) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏夾不存在' }));
        return;
      }

      lurlDb.deleteCollection(collectionId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/collections/:id/items - 取得收藏夾項目
    if (req.method === 'GET' && urlPath.match(/^\/api\/collections\/[^/]+\/items$/)) {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const collectionId = urlPath.split('/')[3];
      const collection = lurlDb.getCollection(collectionId);

      // Admin 可以訪問所有收藏夾
      if (!collection || (collection.userId !== user.id && user.id !== 'admin')) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏夾不存在' }));
        return;
      }

      const limit = parseInt(query.limit) || 20;
      const offset = parseInt(query.offset) || 0;
      const items = lurlDb.getCollectionItems(collectionId, limit, offset);
      const total = lurlDb.getCollectionItemCount(collectionId);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, items, total }));
      return;
    }

    // POST /api/collections/:id/items - 加入收藏
    if (req.method === 'POST' && urlPath.match(/^\/api\/collections\/[^/]+\/items$/)) {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      if (user.tier !== 'premium' && user.tier !== 'admin') {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏功能為老司機專屬' }));
        return;
      }

      const collectionId = urlPath.split('/')[3];
      const collection = lurlDb.getCollection(collectionId);

      // Admin 可以訪問所有收藏夾
      if (!collection || (collection.userId !== user.id && user.id !== 'admin')) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏夾不存在' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { recordId } = body;

        if (!recordId) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 recordId' }));
          return;
        }

        const result = lurlDb.addToCollection(collectionId, recordId);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, added: !!result }));
      } catch (err) {
        console.error('[collections] 加入失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '加入失敗' }));
      }
      return;
    }

    // DELETE /api/collections/:id/items/:recordId - 從收藏夾移除
    if (req.method === 'DELETE' && urlPath.match(/^\/api\/collections\/[^/]+\/items\/[^/]+$/)) {
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const parts = urlPath.split('/');
      const collectionId = parts[3];
      const recordId = parts[5];
      const collection = lurlDb.getCollection(collectionId);

      // Admin 可以訪問所有收藏夾
      if (!collection || (collection.userId !== user.id && user.id !== 'admin')) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '收藏夾不存在' }));
        return;
      }

      lurlDb.removeFromCollection(collectionId, recordId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== Hidden Records ====================

    // POST /api/hide/:recordId - 隱藏內容
    if (req.method === 'POST' && urlPath.startsWith('/api/hide/')) {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      if (user.tier !== 'premium') {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '隱藏功能為老司機專屬' }));
        return;
      }

      const recordId = urlPath.replace('/api/hide/', '');
      lurlDb.hideRecord(user.id, recordId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/hide/:recordId - 取消隱藏
    if (req.method === 'DELETE' && urlPath.startsWith('/api/hide/')) {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const recordId = urlPath.replace('/api/hide/', '');
      lurlDb.unhideRecord(user.id, recordId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/hidden - 取得隱藏列表
    if (req.method === 'GET' && urlPath === '/api/hidden') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const hiddenIds = lurlDb.getHiddenRecords(user.id);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, hidden: hiddenIds }));
      return;
    }

    // ==================== Tag Subscriptions ====================

    // GET /api/tags/subscribed - 取得已訂閱標籤
    if (req.method === 'GET' && urlPath === '/api/tags/subscribed') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      const tags = lurlDb.getSubscribedTags(user.id);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, tags }));
      return;
    }

    // POST /api/tags/subscribe - 訂閱標籤
    if (req.method === 'POST' && urlPath === '/api/tags/subscribe') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      if (user.tier !== 'premium') {
        res.writeHead(403, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '標籤訂閱為老司機專屬' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { tag } = body;

        if (!tag) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 tag' }));
          return;
        }

        lurlDb.subscribeTag(user.id, tag);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[tags] 訂閱失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '訂閱失敗' }));
      }
      return;
    }

    // DELETE /api/tags/subscribe - 取消訂閱標籤
    if (req.method === 'DELETE' && urlPath === '/api/tags/subscribe') {
      const user = getMemberFromRequest(req);
      if (!user) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '未登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { tag } = body;

        if (!tag) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 tag' }));
          return;
        }

        lurlDb.unsubscribeTag(user.id, tag);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[tags] 取消訂閱失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '取消訂閱失敗' }));
      }
      return;
    }

    // ==================== Phase 1 ====================

    // GET /health
    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'ok', version: 'v3-fixed', timestamp: new Date().toISOString() }));
      return;
    }

    // POST /capture (需要 CLIENT_TOKEN)
    if (req.method === 'POST' && urlPath === '/capture') {
      if (!isClientAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid client token' }));
        return;
      }
      try {
        const { title, pageUrl, fileUrl, type = 'video', ref, cookies, thumbnail } = await parseBody(req);

        if (!title || !pageUrl || !fileUrl) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        // 去重與封鎖檢查
        const existingRecords = readAllRecords();

        // 檢查 fileUrl 是否已被封鎖
        const blockedRecord = existingRecords.find(r => r.fileUrl === fileUrl && r.blocked);
        if (blockedRecord) {
          console.log(`[lurl] 跳過已封鎖內容: ${fileUrl}`);
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, blocked: true, message: '此內容已被封鎖' }));
          return;
        }
        const duplicate = existingRecords.find(r => r.pageUrl === pageUrl || r.fileUrl === fileUrl);
        if (duplicate) {
          // 檢查檔案是否真的存在
          const filePath = path.join(DATA_DIR, duplicate.backupPath);
          const fileExists = fs.existsSync(filePath);

          if (fileExists) {
            console.log(`[lurl] 跳過重複頁面: ${pageUrl}`);
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, duplicate: true, existingId: duplicate.id }));
          } else {
            // 記錄存在但檔案不存在，更新 fileUrl（CDN 可能換了）並讓前端上傳
            if (duplicate.fileUrl !== fileUrl) {
              console.log(`[lurl] CDN URL 已更新: ${duplicate.fileUrl} → ${fileUrl}`);
              // 更新記錄中的 fileUrl
              updateRecordFileUrl(duplicate.id, fileUrl);
            }
            console.log(`[lurl] 重複頁面但檔案遺失，需要前端上傳: ${pageUrl}`);
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, duplicate: true, id: duplicate.id, needUpload: true }));
          }
          return;
        }

        ensureDirs();
        // 先產生 ID，用於確保檔名唯一
        const id = Date.now().toString(36);

        // 從 fileUrl 取得原始副檔名
        const urlExt = path.extname(new URL(fileUrl).pathname).toLowerCase() || (type === 'video' ? '.mp4' : '.jpg');
        const ext = ['.mp4', '.mov', '.webm', '.avi'].includes(urlExt) ? urlExt : (type === 'video' ? '.mp4' : '.jpg');
        const safeTitle = sanitizeFilename(title);
        // 檔名加上 ID 確保唯一性（同標題不同影片不會覆蓋）
        const filename = `${safeTitle}_${id}${ext}`;
        const targetDir = type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const folder = type === 'video' ? 'videos' : 'images';
        const backupPath = `${folder}/${filename}`; // 用正斜線，URL 才正確

        // 保存縮圖（如果有）- 轉成 WebP 格式
        let thumbnailPath = null;
        if (thumbnail && type === 'video') {
          try {
            const thumbFilename = `${id}.webp`;
            const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
            // thumbnail 是 data:image/jpeg;base64,... 格式
            const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            // 用 sharp 轉成 WebP 並壓縮
            await sharp(buffer)
              .resize(320, null, { withoutEnlargement: true })
              .webp({ quality: 75 })
              .toFile(thumbFullPath);
            thumbnailPath = `thumbnails/${thumbFilename}`;
            console.log(`[lurl] 縮圖已存 (WebP): ${thumbFilename}`);
            // 註冊到 Pokkit
            try {
              fileStore.adopt('thumbnails', thumbFilename, 'image/webp', {
                id: `thumb:${id}`,
                tags: [`record:${id}`, 'type:thumbnail'],
              });
            } catch (e) { /* skip if already exists */ }
          } catch (thumbErr) {
            console.error(`[lurl] 縮圖保存失敗: ${thumbErr.message}`);
          }
        }

        const record = {
          id,
          title,
          pageUrl,
          fileUrl,
          type,
          source: 'lurl',
          capturedAt: new Date().toISOString(),
          backupPath,
          ...(ref && { ref }), // D卡文章連結（如果有）
          ...(thumbnailPath && { thumbnailPath }) // 縮圖路徑（如果有）
        };

        appendRecord(record);
        console.log(`[lurl] 記錄已存: ${title}`);

        // 後端用 cookies 嘗試下載（可能會失敗，但前端會補上傳）
        const videoFullPath = path.join(targetDir, filename);
        downloadFile(fileUrl, videoFullPath, pageUrl, cookies || '').then(async (ok) => {
          console.log(`[lurl] 後端備份${ok ? '完成' : '失敗'}: ${filename}${cookies ? ' (有cookie)' : ''}`);

          // 下載成功後處理縮圖
          if (ok) {
            // 註冊到 Pokkit 儲存索引
            try {
              const mime = type === 'video' ? 'video/mp4' : 'application/octet-stream';
              fileStore.adopt(folder, filename, mime, {
                id: `${folder}:${id}`,
                tags: [`record:${id}`, `type:${type}`],
                metadata: { recordId: id, title },
              });
            } catch (e) { console.warn(`[lurl] fileStore adopt skip: ${e.message}`); }

            if (type === 'video' && !thumbnailPath) {
              // 影片：用 ffmpeg 產生縮圖
              const thumbFilename = `${id}.webp`;
              const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
              const thumbOk = await generateVideoThumbnail(videoFullPath, thumbFullPath);
              if (thumbOk) {
                updateRecordThumbnail(id, `thumbnails/${thumbFilename}`);
                // 註冊縮圖到 Pokkit
                try {
                  fileStore.adopt('thumbnails', thumbFilename, 'image/webp', {
                    id: `thumb:${id}`,
                    tags: [`record:${id}`, 'type:thumbnail'],
                  });
                } catch (e) { /* skip */ }
              }
            }

            // 影片下載成功後自動加入 HLS 轉檔佇列
            if (type === 'video') {
              queueHLSTranscode(id);
            }

            if (type === 'image') {
              // 圖片：用 sharp 產生縮圖
              const thumbPath = await processImage(videoFullPath, id);
              if (thumbPath) {
                updateRecordThumbnail(id, thumbPath);
              }
            }
          }
        });

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, id: record.id, needUpload: true }));
      } catch (err) {
        console.error('[lurl] Error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ==================== RPC 單一入口 ====================
    // POST /api/rpc - 統一 API 入口（給 userscript 使用）
    // Action 縮寫對照：
    //   cb = check-backup   檢查備份
    //   rc = recover        執行修復
    //   vr = version        版本檢查
    //   bl = blocked-urls   封鎖清單
    //   rd = report-device  回報設備資訊
    if (req.method === 'POST' && urlPath === '/api/rpc') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const { a, p } = body; // a = action, p = payload
        const visitorId = req.headers['x-visitor-id'] || '';

        switch (a) {
          // cb = check-backup（邏輯同 /api/check-backup）
          case 'cb': {
            const pageUrl = p?.url;
            if (!pageUrl) {
              res.writeHead(400, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Missing url' }));
              return;
            }

            const urlId = extractUrlId(pageUrl);
            const records = readAllRecords();

            // 用 pageUrl 動態提取 ID 比對（相容舊資料）
            const record = records.find(r => {
              if (r.blocked) return false;
              const recordId = extractUrlId(r.pageUrl);
              return recordId === urlId;
            });

            if (!record) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ hasBackup: false }));
              return;
            }

            // 檢查本地檔案是否存在
            const localFilePath = path.join(DATA_DIR, record.backupPath);
            if (!fs.existsSync(localFilePath)) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ hasBackup: false }));
              return;
            }

            // 檢查是否已修復過
            const alreadyRecovered = visitorId ? !!hasRecovered(visitorId, urlId) : false;
            const quota = visitorId ? getVisitorQuota(visitorId) : { usedCount: 0, freeQuota: FREE_QUOTA };
            const remaining = getRemainingQuota(quota);
            const backupUrl = `/lurl/files/${record.backupPath}`;

            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({
              hasBackup: true,
              alreadyRecovered,
              backupUrl,
              record: { type: record.type, title: record.title },
              quota: { remaining, used: quota.usedCount, total: quota.freeQuota + (quota.bonusQuota || 0) }
            }));
            return;
          }

          // rc = recover（邏輯同 /api/recover）
          case 'rc': {
            const pageUrl = p?.url;
            if (!pageUrl || !visitorId) {
              res.writeHead(400, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Missing url or visitorId' }));
              return;
            }

            const urlId = extractUrlId(pageUrl);
            const records = readAllRecords();

            // 用 pageUrl 動態提取 ID 比對
            const record = records.find(r => {
              if (r.blocked) return false;
              const recordId = extractUrlId(r.pageUrl);
              return recordId === urlId;
            });

            if (!record) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'no_backup' }));
              return;
            }

            // 檢查本地檔案是否存在
            const localFilePath = path.join(DATA_DIR, record.backupPath);
            if (!fs.existsSync(localFilePath)) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'no_backup' }));
              return;
            }

            const backupUrl = `/lurl/files/${record.backupPath}`;

            // 冪等性檢查
            const recoveredEntry = hasRecovered(visitorId, urlId);
            if (recoveredEntry) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({
                ok: true,
                alreadyRecovered: true,
                backupUrl,
                record: { type: record.type, title: record.title },
                quota: { remaining: getRemainingQuota(getVisitorQuota(visitorId)) }
              }));
              return;
            }

            // 檢查額度
            const quota = getVisitorQuota(visitorId);
            const remaining = getRemainingQuota(quota);

            if (remaining === 0) {
              res.writeHead(200, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'quota_exhausted' }));
              return;
            }

            // 扣額度
            const newQuota = useQuota(visitorId, pageUrl, urlId, backupUrl);
            const newRemaining = getRemainingQuota(newQuota);

            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({
              ok: true,
              backupUrl,
              record: { type: record.type, title: record.title },
              quota: { remaining: newRemaining }
            }));
            return;
          }

          // vr = version
          case 'vr': {
            const config = readVersionConfig();
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({
              latestVersion: config.latestVersion,
              minVersion: config.minVersion,
              downloadUrl: config.downloadUrl,
              changelog: config.changelog
            }));
            return;
          }

          // bl = blocked-urls
          case 'bl': {
            if (!isClientAuthenticated(req)) {
              res.writeHead(401, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
              return;
            }

            const records = readAllRecords();
            const blockedUrls = records
              .filter(r => r.backupStatus === 'completed')
              .map(r => r.urlId);

            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, blockedUrls }));
            return;
          }

          // rd = report-device
          case 'rd': {
            if (!visitorId) {
              res.writeHead(400, corsHeaders());
              res.end(JSON.stringify({ ok: false, error: 'Missing visitorId' }));
              return;
            }

            // 取得現有設備資訊
            const existingQuota = getVisitorQuota(visitorId) || {};
            const existingDevice = existingQuota.device || {};

            const device = {
              ...existingDevice,
              lastSeen: Date.now(),
            };

            // 基本設備資訊
            if (p?.nt || p?.dl || p?.rtt) {
              device.network = {
                type: p?.nt || existingDevice.network?.type || null,
                downlink: p?.dl || existingDevice.network?.downlink || null,
                rtt: p?.rtt || existingDevice.network?.rtt || null
              };
            }
            if (p?.cpu || p?.mem) {
              device.hardware = {
                cores: p?.cpu || existingDevice.hardware?.cores || null,
                memory: p?.mem || existingDevice.hardware?.memory || null
              };
            }
            if (p?.bl !== undefined || p?.bc !== undefined) {
              device.battery = {
                level: p?.bl ?? existingDevice.battery?.level ?? null,
                charging: p?.bc ?? existingDevice.battery?.charging ?? null
              };
            }

            // 測速結果
            if (p?.speedMbps) {
              device.speedTest = {
                mbps: p.speedMbps,
                bytes: p.speedBytes || null,
                duration: p.speedDuration || null,
                testedAt: Date.now()
              };
              console.log(`[lurl] 測速結果: ${visitorId.substring(0, 8)}... = ${p.speedMbps} Mbps`);
            }

            updateQuota(visitorId, { device });
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          default:
            res.writeHead(400, corsHeaders());
            res.end(JSON.stringify({ ok: false, error: 'Unknown action' }));
            return;
        }
      } catch (err) {
        console.error('[lurl] RPC error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/upload - 前端上傳 blob（支援分塊上傳，需要 CLIENT_TOKEN）
    if (req.method === 'POST' && urlPath === '/api/upload') {
      if (!isClientAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid client token' }));
        return;
      }
      try {
        const id = req.headers['x-record-id'];
        const chunkIndex = req.headers['x-chunk-index'];
        const totalChunks = req.headers['x-total-chunks'];

        if (!id) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 x-record-id header' }));
          return;
        }

        // 找到對應的記錄
        const records = readAllRecords();
        const record = records.find(r => r.id === id);
        if (!record) {
          res.writeHead(404, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '找不到記錄' }));
          return;
        }

        // 讀取 body（binary）
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        if (buffer.length === 0) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '沒有收到檔案資料' }));
          return;
        }

        ensureDirs();
        const targetDir = record.type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const filename = path.basename(record.backupPath);
        const destPath = path.join(targetDir, filename);

        // 分塊上傳
        if (chunkIndex !== undefined && totalChunks !== undefined) {
          const chunkDir = path.join(DATA_DIR, 'chunks', id);
          if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
          }

          // 存分塊
          const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
          fs.writeFileSync(chunkPath, buffer);
          console.log(`[lurl] 分塊 ${parseInt(chunkIndex) + 1}/${totalChunks} 收到: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

          // 檢查是否所有分塊都收到
          const receivedChunks = fs.readdirSync(chunkDir).filter(f => f.startsWith('chunk_')).length;
          if (receivedChunks === parseInt(totalChunks)) {
            // 組裝完整檔案
            console.log(`[lurl] 所有分塊收齊，組裝中...`);

            // 同步寫入組裝檔案
            const allChunks = [];
            for (let i = 0; i < parseInt(totalChunks); i++) {
              const chunkData = fs.readFileSync(path.join(chunkDir, `chunk_${i}`));
              allChunks.push(chunkData);
            }
            const finalBuffer = Buffer.concat(allChunks);
            fs.writeFileSync(destPath, finalBuffer);

            // 清理分塊
            fs.rmSync(chunkDir, { recursive: true });

            console.log(`[lurl] 分塊上傳完成: ${filename} (${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

            // 註冊到 Pokkit 儲存索引
            try {
              const bucket = record.type === 'video' ? 'videos' : 'images';
              const mime = record.type === 'video' ? 'video/mp4' : 'application/octet-stream';
              fileStore.adopt(bucket, filename, mime, {
                id: `${bucket}:${id}`,
                tags: [`record:${id}`, `type:${record.type}`],
                metadata: { recordId: id, title: record.title },
              });
            } catch (e) { console.warn(`[lurl] fileStore adopt skip: ${e.message}`); }

            // 上傳完成後為圖片生成縮圖
            if (record.type === 'image' && !record.thumbnailPath) {
              processImage(destPath, id).then(thumbPath => {
                if (thumbPath) updateRecordThumbnail(id, thumbPath);
              });
            }

            // 影片上傳完成後自動加入 HLS 轉檔佇列
            if (record.type === 'video') {
              queueHLSTranscode(id);
            }
          }

          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, chunk: parseInt(chunkIndex), total: parseInt(totalChunks) }));
        } else {
          // 單次上傳（小檔案）
          fs.writeFileSync(destPath, buffer);
          console.log(`[lurl] 前端上傳成功: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

          // 註冊到 Pokkit 儲存索引
          try {
            const bucket = record.type === 'video' ? 'videos' : 'images';
            const mime = record.type === 'video' ? 'video/mp4' : 'application/octet-stream';
            fileStore.adopt(bucket, filename, mime, {
              id: `${bucket}:${id}`,
              tags: [`record:${id}`, `type:${record.type}`],
              metadata: { recordId: id, title: record.title },
            });
          } catch (e) { console.warn(`[lurl] fileStore adopt skip: ${e.message}`); }

          // 上傳完成後為圖片生成縮圖
          if (record.type === 'image' && !record.thumbnailPath) {
            processImage(destPath, id).then(thumbPath => {
              if (thumbPath) updateRecordThumbnail(id, thumbPath);
            });
          }

          // 影片上傳完成後自動加入 HLS 轉檔佇列
          if (record.type === 'video') {
            queueHLSTranscode(id);
          }

          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, size: buffer.length }));
        }
      } catch (err) {
        console.error('[lurl] Upload error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ==================== Phase 2 ====================

    // GET /admin (需要登入)
    if (req.method === 'GET' && urlPath === '/admin') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/admin' });
        res.end();
        return;
      }
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), adminPage());
      return;
    }

    // GET /api/records (需要登入)
    if (req.method === 'GET' && urlPath === '/api/records') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      let records = readAllRecords(); // SQLite 已按 capturedAt DESC 排序
      const type = query.type;
      const q = query.q;
      const page = parseInt(query.page) || 1;
      const limit = parseInt(query.limit) || 50; // 預設每頁 50 筆

      // 先檢查檔案存在狀態（原始 MP4/MOV 或 HLS 版本）
      records = records.map(r => {
        let fileExists = false;
        if (r.type === 'video') {
          // 視訊：只檢查 MP4/MOV 或 HLS
          const ext = r.backupPath ? path.extname(r.backupPath).toLowerCase() : '';
          const hasLocalFile = ['.mp4', '.mov'].includes(ext) && fs.existsSync(path.join(DATA_DIR, r.backupPath));
          const hasHLS = r.hlsReady && fs.existsSync(path.join(HLS_DIR, r.id, 'master.m3u8'));
          fileExists = hasLocalFile || hasHLS;
        } else {
          // 圖片：直接檢查 backupPath
          fileExists = r.backupPath && fs.existsSync(path.join(DATA_DIR, r.backupPath));
        }
        return { ...r, fileExists };
      });

      // Blocked filter (預設不顯示封鎖的，除非明確指定)
      const blocked = query.blocked;
      if (blocked === 'true') {
        records = records.filter(r => r.blocked);
      } else if (blocked !== 'all') {
        // 預設：不顯示封鎖的
        records = records.filter(r => !r.blocked);
      }

      // Rating filter
      const rating = query.rating;
      if (rating === 'like') {
        records = records.filter(r => r.rating === 'like');
      } else if (rating === 'dislike') {
        records = records.filter(r => r.rating === 'dislike');
      }

      // Type filter
      if (type === 'pending') {
        // 未下載：只顯示檔案不存在的
        records = records.filter(r => !r.fileExists);
      } else if (type === 'blocked') {
        // 已封鎖的：只顯示 blocked=true (已被上面的 blocked filter 過濾，這裡要重新讀取)
        records = readAllRecords()
          .map(r => {
            let fileExists = false;
            if (r.type === 'video') {
              const ext = r.backupPath ? path.extname(r.backupPath).toLowerCase() : '';
              const hasLocalFile = ['.mp4', '.mov'].includes(ext) && fs.existsSync(path.join(DATA_DIR, r.backupPath));
              const hasHLS = r.hlsReady && fs.existsSync(path.join(HLS_DIR, r.id, 'master.m3u8'));
              fileExists = hasLocalFile || hasHLS;
            } else {
              fileExists = r.backupPath && fs.existsSync(path.join(DATA_DIR, r.backupPath));
            }
            return { ...r, fileExists };
          })
          .filter(r => r.blocked);
      } else {
        // 全部/影片/圖片：只顯示已下載的
        records = records.filter(r => r.fileExists);
        if (type && type !== 'all') {
          records = records.filter(r => r.type === type);
        }
      }

      // Search filter (q parameter)
      if (q) {
        const searchTerm = q.toLowerCase();
        records = records.filter(r =>
          r.id.toLowerCase().includes(searchTerm) ||
          (r.title && r.title.toLowerCase().includes(searchTerm)) ||
          (r.pageUrl && r.pageUrl.toLowerCase().includes(searchTerm))
        );
      }

      // Tag filter (AND logic - must match all selected tags)
      const tagsParam = query.tags;
      if (tagsParam) {
        const filterTags = tagsParam.split(',').filter(Boolean);
        records = records.filter(r => {
          const recordTags = r.tags || [];
          // 每個篩選標籤都必須匹配
          return filterTags.every(filterTag => {
            if (filterTag.includes(':')) {
              // 子標籤：精確匹配
              return recordTags.includes(filterTag);
            } else {
              // 主標籤：匹配主標籤本身或其任何子標籤
              return recordTags.some(t => t === filterTag || t.startsWith(filterTag + ':'));
            }
          });
        });
      }

      const total = records.length;
      const totalPages = Math.ceil(total / limit);

      // 分頁
      const start = (page - 1) * limit;
      const paginatedRecords = records.slice(start, start + limit);

      // 只對當前頁加上縮圖狀態
      const recordsWithStatus = paginatedRecords.map(r => ({
        ...r,
        thumbnailExists: r.thumbnailPath ? fs.existsSync(path.join(DATA_DIR, r.thumbnailPath)) : false
      }));

      const jsonBody = JSON.stringify({
        records: recordsWithStatus,
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages
      });
      sendCompressed(req, res, 200, corsHeaders(), jsonBody);
      return;
    }

    // GET /api/version - 腳本版本檢查（公開，不需要驗證）
    if (req.method === 'GET' && urlPath === '/api/version') {
      try {
        const versionFile = path.join(__dirname, 'version.json');
        if (fs.existsSync(versionFile)) {
          const versionConfig = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify(versionConfig));
        } else {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({
            latestVersion: '0.0.0',
            minVersion: '0.0.0',
            message: '',
            updateUrl: '',
            forceUpdate: false,
            announcement: ''
          }));
        }
      } catch (err) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          latestVersion: '0.0.0',
          minVersion: '0.0.0',
          message: '',
          updateUrl: '',
          forceUpdate: false,
          announcement: ''
        }));
      }
      return;
    }

    // POST /api/version - 更新版本設定（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/version') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }
      try {
        const body = await parseBody(req);
        const versionFile = path.join(__dirname, 'version.json');
        const config = {
          latestVersion: body.latestVersion || '0.0.0',
          minVersion: body.minVersion || '0.0.0',
          message: body.message || '',
          updateUrl: body.updateUrl || '',
          forceUpdate: body.forceUpdate || false,
          announcement: body.announcement || ''
        };
        fs.writeFileSync(versionFile, JSON.stringify(config, null, 2));
        console.log('[lurl] 版本設定已更新:', config.latestVersion);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[lurl] 更新版本設定失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/fix-untitled - 修復 untitled 記錄（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/fix-untitled') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }
      try {
        const records = readAllRecords();
        // 包含 'untitled' 和 'untitled_xxxxx' 開頭的記錄
        const isUntitled = (title) => !title || title === 'untitled' || title === 'undefined' || title.startsWith('untitled_');
        const untitledRecords = records.filter(r => isUntitled(r.title));

        if (untitledRecords.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, fixed: 0, message: '沒有需要修復的 untitled 記錄' }));
          return;
        }

        // 讀取所有行
        const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(l => l.trim());
        let fixedCount = 0;
        const newLines = lines.map(line => {
          try {
            const record = JSON.parse(line);
            if (isUntitled(record.title)) {
              // 嘗試從 pageUrl 擷取標題
              let newTitle = null;
              if (record.pageUrl) {
                try {
                  const url = new URL(record.pageUrl);
                  // 嘗試從 URL 路徑取得有意義的名稱
                  const pathParts = url.pathname.split('/').filter(Boolean);
                  if (pathParts.length > 0) {
                    const lastPart = decodeURIComponent(pathParts[pathParts.length - 1]);
                    // 移除副檔名和特殊字元
                    const cleaned = lastPart.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ').trim();
                    if (cleaned && cleaned.length > 2 && !cleaned.startsWith('untitled')) {
                      newTitle = cleaned.substring(0, 200);
                    }
                  }
                  // 如果路徑沒有好標題，用 hostname
                  if (!newTitle) {
                    newTitle = url.hostname.replace(/^www\./, '');
                  }
                } catch (e) {
                  // URL 解析失敗
                }
              }
              // 如果還是沒標題，用 ID
              if (!newTitle) {
                newTitle = `video_${record.id}`;
              }
              record.title = newTitle;
              fixedCount++;
            }
            return JSON.stringify(record);
          } catch (e) {
            return line;
          }
        });

        // 寫回檔案
        fs.writeFileSync(RECORDS_FILE, newLines.join('\n') + '\n');
        console.log(`[lurl] 已修復 ${fixedCount} 個 untitled 記錄`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, fixed: fixedCount, total: untitledRecords.length }));
      } catch (err) {
        console.error('[lurl] 修復 untitled 失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/cleanup-duplicates - 清理重複記錄（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/cleanup-duplicates') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        const seen = new Map(); // fileUrl -> record (保留第一個)
        const toRemove = [];

        records.forEach(r => {
          // 優先用 fileUrl 去重，若 fileUrl 相同只保留第一筆
          if (seen.has(r.fileUrl)) {
            toRemove.push(r);
          } else {
            seen.set(r.fileUrl, r);
          }
        });

        if (toRemove.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, removed: 0, message: '沒有重複記錄' }));
          return;
        }

        // 刪除重複記錄的檔案（如果有）
        toRemove.forEach(r => {
          const filePath = path.join(DATA_DIR, r.backupPath);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[lurl] 刪除重複檔案: ${r.backupPath}`);
          }
          if (r.thumbnailPath) {
            const thumbPath = path.join(DATA_DIR, r.thumbnailPath);
            if (fs.existsSync(thumbPath)) {
              fs.unlinkSync(thumbPath);
            }
          }
        });

        // 保留的記錄
        const keepRecords = Array.from(seen.values());
        fs.writeFileSync(RECORDS_FILE, keepRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

        console.log(`[lurl] 已清理 ${toRemove.length} 個重複記錄`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, removed: toRemove.length }));
      } catch (err) {
        console.error('[lurl] 清理重複失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/cleanup-hls-originals - 清理已轉 HLS 的原始影片檔（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/cleanup-hls-originals') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        const hlsRecords = records.filter(r => r.hlsReady === true);

        let deleted = 0;
        let freedBytes = 0;
        const deletedFiles = [];

        hlsRecords.forEach(r => {
          if (r.backupPath) {
            const videoPath = path.join(DATA_DIR, r.backupPath);
            if (fs.existsSync(videoPath)) {
              try {
                const stat = fs.statSync(videoPath);
                freedBytes += stat.size;
                fs.unlinkSync(videoPath);
                deleted++;
                deletedFiles.push(r.backupPath);
                console.log(`[lurl] 清理 HLS 原始檔: ${r.backupPath}`);
              } catch (e) {
                console.error(`[lurl] 刪除失敗: ${r.backupPath}`, e.message);
              }
            }
          }
        });

        const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
        console.log(`[lurl] 已清理 ${deleted} 個 HLS 原始檔，釋放 ${freedMB} MB`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          deleted,
          freedMB: parseFloat(freedMB),
          totalHlsRecords: hlsRecords.length
        }));
      } catch (err) {
        console.error('[lurl] 清理 HLS 原始檔失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/repair-paths - 修復重複的 backupPath（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/repair-paths') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();

        // 找出 backupPath 重複的
        const pathCounts = {};
        records.forEach(r => {
          pathCounts[r.backupPath] = (pathCounts[r.backupPath] || 0) + 1;
        });

        const duplicatePaths = new Set(
          Object.entries(pathCounts).filter(([_, count]) => count > 1).map(([p]) => p)
        );

        if (duplicatePaths.size === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, fixed: 0, message: '沒有重複的檔案路徑' }));
          return;
        }

        let fixedCount = 0;
        const updatedRecords = records.map(r => {
          if (duplicatePaths.has(r.backupPath)) {
            // 產生新的唯一檔名
            const ext = path.extname(r.backupPath);
            const folder = r.type === 'video' ? 'videos' : 'images';
            const safeTitle = sanitizeFilename(r.title.replace(/_[a-z0-9]+$/i, '')); // 移除舊的 ID 後綴
            const newFilename = `${safeTitle}_${r.id}${ext}`;
            const newBackupPath = `${folder}/${newFilename}`;

            console.log(`[lurl] 修復路徑: ${r.backupPath} → ${newBackupPath}`);

            fixedCount++;
            return {
              ...r,
              backupPath: newBackupPath,
              fileExists: false, // 標記需要重新下載
            };
          }
          return r;
        });

        // 寫回檔案
        fs.writeFileSync(RECORDS_FILE, updatedRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

        console.log(`[lurl] 已修復 ${fixedCount} 個重複路徑`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          fixed: fixedCount,
          message: `已修復 ${fixedCount} 個路徑，請執行「重試失敗下載」重新抓取`
        }));
      } catch (err) {
        console.error('[lurl] 修復路徑失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/generate-thumbnails - 為現有影片產生縮圖（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/generate-thumbnails') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        // 找出有影片檔案但沒縮圖的記錄（支援 MP4/MOV 或 HLS）
        const needThumbnails = records.filter(r => {
          if (r.type !== 'video') return false;
          if (r.thumbnailPath && fs.existsSync(path.join(DATA_DIR, r.thumbnailPath))) return false;
          // 檢查是否有原始 MP4/MOV
          if (r.backupPath) {
            const ext = path.extname(r.backupPath).toLowerCase();
            if (['.mp4', '.mov'].includes(ext) && fs.existsSync(path.join(DATA_DIR, r.backupPath))) {
              return true;
            }
          }
          // 檢查是否有 HLS
          if (r.hlsReady && fs.existsSync(path.join(HLS_DIR, r.id, 'master.m3u8'))) {
            return true;
          }
          return false;
        });

        if (needThumbnails.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, total: 0, message: '所有影片都已有縮圖' }));
          return;
        }

        console.log(`[lurl] 開始產生 ${needThumbnails.length} 個縮圖`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: needThumbnails.length,
          message: `開始產生 ${needThumbnails.length} 個縮圖...`
        }));

        // 背景執行
        (async () => {
          let successCount = 0;
          for (let i = 0; i < needThumbnails.length; i++) {
            const record = needThumbnails[i];
            console.log(`[lurl] 產生縮圖 ${i + 1}/${needThumbnails.length}: ${record.id}`);

            // 決定影片來源路徑（優先原始 MP4/MOV，否則用 HLS）
            let videoPath = null;
            if (record.backupPath) {
              const ext = path.extname(record.backupPath).toLowerCase();
              if (['.mp4', '.mov'].includes(ext) && fs.existsSync(path.join(DATA_DIR, record.backupPath))) {
                videoPath = path.join(DATA_DIR, record.backupPath);
              }
            }
            if (!videoPath && record.hlsReady) {
              const hlsPath = path.join(HLS_DIR, record.id, 'master.m3u8');
              if (fs.existsSync(hlsPath)) {
                videoPath = hlsPath;
              }
            }
            if (!videoPath) {
              console.log(`[lurl] 跳過 ${record.id}：找不到影片檔案`);
              continue;
            }

            const thumbFilename = `${record.id}.jpg`;
            const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);

            let ok = false;

            // 優先使用 workr
            if (workr) {
              try {
                const result = await workr.submitAndWait('thumbnail', {
                  videoPath,
                  outputPath: thumbPath,
                  timestamp: '00:00:01',
                  width: 320
                });
                ok = result.success;
                if (!ok) {
                  console.log(`[lurl] workr 縮圖失敗，fallback 到本地: ${result.error}`);
                  ok = await generateVideoThumbnail(videoPath, thumbPath);
                }
              } catch (e) {
                console.log(`[lurl] workr 不可用，使用本地方法: ${e.message}`);
                ok = await generateVideoThumbnail(videoPath, thumbPath);
              }
            } else {
              // Fallback: 使用本地方法
              ok = await generateVideoThumbnail(videoPath, thumbPath);
            }

            if (ok) {
              updateRecordThumbnail(record.id, `thumbnails/${thumbFilename}`);
              successCount++;
            }

            // 間隔避免太快
            if (i < needThumbnails.length - 1) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          console.log(`[lurl] 縮圖產生完成: ${successCount}/${needThumbnails.length}`);
        })().catch(err => {
          console.error('[lurl] 縮圖產生錯誤:', err);
        });

      } catch (err) {
        console.error('[lurl] 縮圖產生失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/retry-failed - 重試下載失敗的檔案（需要 Admin 登入）
    // 使用 Puppeteer 開原頁面，在頁面 context 裡下載 CDN
    if (req.method === 'POST' && urlPath === '/api/retry-failed') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      if (!lurlRetry) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Puppeteer 未安裝，請執行 npm install' }));
        return;
      }

      try {
        const records = readAllRecords();
        // 找出下載失敗的記錄 (有 fileUrl 但檔案不存在，視訊要檢查 MP4/MOV 或 HLS)
        const failedRecords = records.filter(r => {
          if (!r.fileUrl) return false; // 沒有原始 URL，無法重試
          if (r.type === 'video') {
            // 視訊：檢查 MP4/MOV 或 HLS
            const ext = r.backupPath ? path.extname(r.backupPath).toLowerCase() : '';
            const hasLocalFile = ['.mp4', '.mov'].includes(ext) && fs.existsSync(path.join(DATA_DIR, r.backupPath));
            const hasHLS = r.hlsReady && fs.existsSync(path.join(HLS_DIR, r.id, 'master.m3u8'));
            return !hasLocalFile && !hasHLS;
          } else {
            if (!r.backupPath) return true;
            return !fs.existsSync(path.join(DATA_DIR, r.backupPath));
          }
        });

        if (failedRecords.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, total: 0, message: '沒有需要重試的失敗記錄' }));
          return;
        }

        console.log(`[lurl] 開始用 Puppeteer 重試 ${failedRecords.length} 個失敗記錄`);

        // 非同步處理，先回傳
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: failedRecords.length,
          message: `開始重試 ${failedRecords.length} 個失敗記錄，處理中...`
        }));

        // 背景執行重試 - 優先使用 workr
        (async () => {
          let result = null;

          // 優先使用 workr 批次下載
          if (workr) {
            try {
              console.log('[lurl] 使用 workr 批次下載');
              const jobResult = await workr.submitAndWait('download', {
                records: failedRecords,
                dataDir: DATA_DIR
              }, { timeout: 10 * 60 * 1000 }); // 10 分鐘 timeout

              if (jobResult.success) {
                // 轉換 workr 格式為統一格式
                const successIds = jobResult.result.results
                  .filter(r => r.success)
                  .map(r => r.id);

                result = {
                  total: jobResult.result.total,
                  successCount: jobResult.result.success,
                  successIds
                };
                console.log(`[lurl] workr 批次下載完成: ${result.successCount}/${result.total}`);
              } else {
                throw new Error(jobResult.error || 'workr job failed');
              }
            } catch (e) {
              console.log(`[lurl] workr 不可用，使用本地 Puppeteer: ${e.message}`);
              // Fallback 到本地方法
              if (lurlRetry) {
                result = await lurlRetry.batchRetry(failedRecords, DATA_DIR, (current, total, record) => {
                  console.log(`[lurl] 重試進度: ${current}/${total} - ${record.id}`);
                });
              } else {
                throw new Error('Puppeteer 未安裝，且 workr 不可用');
              }
            }
          } else {
            // Fallback: 使用本地方法
            if (lurlRetry) {
              result = await lurlRetry.batchRetry(failedRecords, DATA_DIR, (current, total, record) => {
                console.log(`[lurl] 重試進度: ${current}/${total} - ${record.id}`);
              });
            } else {
              throw new Error('Puppeteer 未安裝，且 workr 不可用');
            }
          }

          // 更新記錄的 fileExists 狀態
          if (result && result.successCount > 0) {
            const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(l => l.trim());
            const newLines = lines.map(line => {
              try {
                const rec = JSON.parse(line);
                if (result.successIds.includes(rec.id)) {
                  rec.fileExists = true;
                  rec.retrySuccess = true;
                  rec.retriedAt = new Date().toISOString();
                }
                return JSON.stringify(rec);
              } catch (e) {
                return line;
              }
            });
            fs.writeFileSync(RECORDS_FILE, newLines.join('\n') + '\n');
          }

          console.log(`[lurl] 重試完成: 成功 ${result.successCount}/${result.total}`);
        })().catch(err => {
          console.error('[lurl] 重試過程發生錯誤:', err);
        });

      } catch (err) {
        console.error('[lurl] 重試失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/retry-status - 取得失敗記錄數量
    if (req.method === 'GET' && urlPath === '/api/retry-status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const records = readAllRecords();
      // 有 fileUrl 但檔案不存在的才需要重試（視訊要檢查 MP4/MOV 或 HLS）
      const failedRecords = records.filter(r => {
        if (!r.fileUrl) return false; // 沒有原始 URL，無法重試
        if (r.type === 'video') {
          // 視訊：檢查 MP4/MOV 或 HLS
          const ext = r.backupPath ? path.extname(r.backupPath).toLowerCase() : '';
          const hasLocalFile = ['.mp4', '.mov'].includes(ext) && fs.existsSync(path.join(DATA_DIR, r.backupPath));
          const hasHLS = r.hlsReady && fs.existsSync(path.join(HLS_DIR, r.id, 'master.m3u8'));
          return !hasLocalFile && !hasHLS; // 兩者都不存在才需要重試
        } else {
          // 圖片：檢查 backupPath
          if (!r.backupPath) return true;
          return !fs.existsSync(path.join(DATA_DIR, r.backupPath));
        }
      });
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        failed: failedRecords.length,
        puppeteerAvailable: !!lurlRetry
      }));
      return;
    }

    // POST /api/optimize - 批次優化圖片（生成縮圖、轉 WebP）
    if (req.method === 'POST' && urlPath === '/api/optimize') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const { mode = 'thumbnails' } = body; // thumbnails | webp | both

        const records = readAllRecords();
        const results = { processed: 0, skipped: 0, failed: 0, details: [] };

        for (const record of records) {
          // 跳過沒有備份檔案的記錄
          const sourcePath = path.join(DATA_DIR, record.backupPath);
          if (!fs.existsSync(sourcePath)) {
            results.skipped++;
            continue;
          }

          // 生成缺少的縮圖
          if ((mode === 'thumbnails' || mode === 'both') && !record.thumbnailPath) {
            try {
              if (record.type === 'image') {
                const thumbPath = await processImage(sourcePath, record.id);
                if (thumbPath) {
                  updateRecordThumbnail(record.id, thumbPath);
                  results.processed++;
                  results.details.push({ id: record.id, action: 'thumbnail', status: 'ok' });
                } else {
                  results.failed++;
                }
              } else if (record.type === 'video') {
                const thumbFilename = `${record.id}.webp`;
                const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
                const ok = await generateVideoThumbnail(sourcePath, thumbFullPath);
                if (ok) {
                  updateRecordThumbnail(record.id, `thumbnails/${thumbFilename}`);
                  results.processed++;
                  results.details.push({ id: record.id, action: 'thumbnail', status: 'ok' });
                } else {
                  results.failed++;
                }
              }
            } catch (err) {
              results.failed++;
              results.details.push({ id: record.id, action: 'thumbnail', status: 'error', error: err.message });
            }
          } else if (mode === 'thumbnails' && record.thumbnailPath) {
            results.skipped++;
          }

          // 原圖轉 WebP（僅圖片）
          if ((mode === 'webp' || mode === 'both') && record.type === 'image') {
            const ext = path.extname(record.backupPath).toLowerCase();
            if (ext !== '.webp') {
              try {
                const webpFilename = record.backupPath.replace(/\.\w+$/, '.webp');
                const webpPath = path.join(DATA_DIR, webpFilename);

                await sharp(sourcePath)
                  .webp({ quality: 85 })
                  .toFile(webpPath);

                // 刪除原檔，更新記錄
                fs.unlinkSync(sourcePath);
                updateRecordBackupPath(record.id, webpFilename);
                results.processed++;
                results.details.push({ id: record.id, action: 'webp', status: 'ok' });
              } catch (err) {
                results.failed++;
                results.details.push({ id: record.id, action: 'webp', status: 'error', error: err.message });
              }
            } else {
              results.skipped++;
            }
          }
        }

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, ...results }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/optimize/status - 查詢優化狀態（缺少縮圖的數量等）
    if (req.method === 'GET' && urlPath === '/api/optimize/status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const records = readAllRecords();
      let missingThumbnails = 0;
      let nonWebpImages = 0;
      let totalImages = 0;
      let totalVideos = 0;

      for (const record of records) {
        const sourcePath = path.join(DATA_DIR, record.backupPath);
        if (!fs.existsSync(sourcePath)) continue;

        if (record.type === 'image') {
          totalImages++;
          if (!record.thumbnailPath) missingThumbnails++;
          if (!record.backupPath.endsWith('.webp')) nonWebpImages++;
        } else if (record.type === 'video') {
          totalVideos++;
          if (!record.thumbnailPath) missingThumbnails++;
        }
      }

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        totalImages,
        totalVideos,
        missingThumbnails,
        nonWebpImages,
        canOptimize: missingThumbnails > 0 || nonWebpImages > 0
      }));
      return;
    }

    // ==================== 維護系統 API ====================

    // GET /api/maintenance/status - 取得維護系統狀態
    if (req.method === 'GET' && urlPath === '/api/maintenance/status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const scheduler = initMaintenanceScheduler();
        const status = await scheduler.getStatus();

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, ...status }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/run - 執行所有維護策略
    if (req.method === 'POST' && urlPath === '/api/maintenance/run') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const scheduler = initMaintenanceScheduler();

        if (scheduler.isRunning) {
          res.writeHead(409, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '維護任務執行中', currentTask: scheduler.currentTask }));
          return;
        }

        // 非同步執行
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, message: '維護任務已開始執行' }));

        scheduler.runAll().catch(err => {
          console.error('[Maintenance] 執行失敗:', err);
        });
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/run/:strategy - 執行特定策略
    if (req.method === 'POST' && urlPath.startsWith('/api/maintenance/run/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      const strategyName = urlPath.replace('/api/maintenance/run/', '');

      try {
        const scheduler = initMaintenanceScheduler();

        if (scheduler.isRunning) {
          res.writeHead(409, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '維護任務執行中', currentTask: scheduler.currentTask }));
          return;
        }

        // 非同步執行
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, message: `策略 ${strategyName} 已開始執行` }));

        scheduler.runOne(strategyName).catch(err => {
          console.error(`[Maintenance] 策略 ${strategyName} 執行失敗:`, err);
        });
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/maintenance/config - 取得維護配置
    if (req.method === 'GET' && urlPath === '/api/maintenance/config') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const scheduler = initMaintenanceScheduler();
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, config: scheduler.config }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/config - 更新維護配置
    if (req.method === 'POST' && urlPath === '/api/maintenance/config') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const scheduler = initMaintenanceScheduler();
        const newConfig = scheduler.updateConfig(body);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, config: newConfig }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/maintenance/history - 取得維護歷史
    if (req.method === 'GET' && urlPath === '/api/maintenance/history') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const scheduler = initMaintenanceScheduler();
        const limit = parseInt(query.limit) || 20;
        const history = scheduler.getHistory(limit);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, history }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/auto/start - 啟動自動排程
    if (req.method === 'POST' && urlPath === '/api/maintenance/auto/start') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const scheduler = initMaintenanceScheduler();
        scheduler.startAutoRun();

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          message: '自動排程已啟動',
          nextRun: scheduler.getNextRunTime(),
          interval: scheduler.config.runInterval
        }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/auto/stop - 停止自動排程
    if (req.method === 'POST' && urlPath === '/api/maintenance/auto/stop') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const scheduler = initMaintenanceScheduler();
        scheduler.stopAutoRun();

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, message: '自動排程已停止' }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/maintenance/analyze - 取得詳細分析（使用 RecordChecker）
    if (req.method === 'GET' && urlPath === '/api/maintenance/analyze') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        const analysis = recordChecker.analyzeRecords(records);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: analysis.total,
          videos: analysis.videos,
          images: analysis.images,
          needsDownload: analysis.needsDownload.length,
          needsThumbnail: analysis.needsThumbnail.length,
          needsPreview: analysis.needsPreview.length,
          needsHLS: analysis.needsHLS.length,
          canCleanup: analysis.canCleanup.length,
          missingFiles: analysis.missingFiles.length
        }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/maintenance/status-counts - 取得狀態統計（快速，使用資料庫索引）
    if (req.method === 'GET' && urlPath === '/api/maintenance/status-counts') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const counts = lurlDb.getStatusCounts();
        const records = readAllRecords();
        const statusAnalysis = recordChecker.analyzeRecordsByStatus(records);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          counts,
          pending: statusAnalysis.pending,
          total: records.length,
          videos: statusAnalysis.videos,
          images: statusAnalysis.images,
        }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/sync - 同步狀態與檔案系統
    if (req.method === 'POST' && urlPath === '/api/maintenance/sync') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { dryRun = false } = body;

        const records = readAllRecords();
        const result = recordChecker.syncAllStatuses(
          records,
          (id, updates) => lurlDb.updateRecord(id, updates),
          { dryRun }
        );

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          ...result,
          message: dryRun ? '模擬同步完成' : '狀態同步完成',
        }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/maintenance/migrate - 執行狀態遷移（從現有資料設定初始狀態）
    if (req.method === 'POST' && urlPath === '/api/maintenance/migrate') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const { dryRun = false, force = false } = body;

        const result = lurlDb.migrateRecordStatuses(recordChecker, { dryRun, force });

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          ...result,
          message: dryRun ? '模擬遷移完成' : '狀態遷移完成',
        }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/records/by-status - 按狀態查詢記錄
    if (req.method === 'GET' && urlPath === '/api/records/by-status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const field = url.searchParams.get('field') || 'downloadStatus';
        const value = url.searchParams.get('value') || 'pending';
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);

        const records = lurlDb.getRecordsByStatus(field, value, limit);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          field,
          value,
          count: records.length,
          records: records.map(r => ({
            id: r.id,
            title: r.title,
            type: r.type,
            capturedAt: r.capturedAt,
            downloadStatus: r.downloadStatus,
            thumbnailStatus: r.thumbnailStatus,
            previewStatus: r.previewStatus,
            hlsStatus: r.hlsStatus,
            originalStatus: r.originalStatus,
            downloadRetries: r.downloadRetries,
            downloadError: r.downloadError,
          })),
        }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/records/:id/status - 更新單筆狀態
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/status$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const id = urlPath.split('/')[3];
        const body = await parseBody(req);

        // 只允許更新狀態欄位
        const allowedFields = [
          'sourceStatus', 'sourceCheckedAt',
          'downloadStatus', 'downloadRetries', 'downloadError',
          'thumbnailStatus', 'previewStatus', 'hlsStatus', 'originalStatus',
          'lastProcessedAt', 'lastErrorAt',
        ];

        const updates = {};
        for (const field of allowedFields) {
          if (body[field] !== undefined) {
            updates[field] = body[field];
          }
        }

        if (Object.keys(updates).length === 0) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '沒有有效的更新欄位' }));
          return;
        }

        const record = lurlDb.updateRecord(id, updates);
        if (!record) {
          res.writeHead(404, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
          return;
        }

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, record }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/source/report - 腳本回報來源狀態
    if (req.method === 'POST' && urlPath === '/api/source/report') {
      try {
        const body = await parseBody(req);
        const { token, reports } = body;

        // 驗證 token
        if (token !== CLIENT_TOKEN) {
          res.writeHead(401, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '無效的 token' }));
          return;
        }

        if (!Array.isArray(reports) || reports.length === 0) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '需要 reports 陣列' }));
          return;
        }

        const results = { updated: 0, notFound: 0, errors: [] };

        for (const report of reports) {
          try {
            const { pageUrl, fileUrl, status } = report;

            // 尋找記錄
            let record = null;
            if (pageUrl) {
              record = lurlDb.findRecordByUrl(pageUrl);
            }
            if (!record && fileUrl) {
              record = lurlDb.findRecordByFileUrl(fileUrl);
            }

            if (!record) {
              results.notFound++;
              continue;
            }

            // 更新來源狀態
            lurlDb.updateRecord(record.id, {
              sourceStatus: status || 'unknown',
              sourceCheckedAt: new Date().toISOString(),
            });

            results.updated++;
          } catch (err) {
            results.errors.push({ report, error: err.message });
          }
        }

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, ...results }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/stats - 公開基本統計（供 dashboard 使用）
    if (req.method === 'GET' && urlPath === '/api/stats') {
      const records = readAllRecords();
      const totalRecords = records.length;
      const totalVideos = records.filter(r => r.type === 'video').length;
      const totalImages = records.filter(r => r.type === 'image').length;

      // 如果是登入狀態，返回更多資訊
      if (isAdminAuthenticated(req)) {
        const urlCounts = {};
        records.forEach(r => {
          urlCounts[r.pageUrl] = (urlCounts[r.pageUrl] || 0) + 1;
        });
        const topUrls = Object.entries(urlCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([pageUrl, count]) => ({ pageUrl, count }));

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ total: totalRecords, totalRecords, totalVideos, totalImages, videos: totalVideos, images: totalImages, topUrls }));
        return;
      }

      // 公開版本只返回基本統計
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ totalRecords, totalVideos, totalImages }));
      return;
    }

    // ==================== 額度管理 API ====================

    // GET /api/quotas - 取得所有用戶額度列表
    if (req.method === 'GET' && urlPath === '/api/quotas') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const quotas = readAllQuotas().map(q => ({
        ...q,
        isVip: isVipVisitor(q.visitorId),
        remaining: getRemainingQuota(q),
        total: q.status === 'vip' || isVipVisitor(q.visitorId) ? '∞' : (q.freeQuota + (q.bonusQuota || 0))
      }));

      // 按最後使用時間排序
      quotas.sort((a, b) => {
        if (!a.lastUsed) return 1;
        if (!b.lastUsed) return -1;
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, quotas }));
      return;
    }

    // GET /api/quotas/:visitorId - 取得單一用戶詳情
    if (req.method === 'GET' && urlPath.startsWith('/api/quotas/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const visitorId = decodeURIComponent(urlPath.replace('/api/quotas/', ''));
      const quota = getVisitorQuota(visitorId);
      const remaining = getRemainingQuota(quota);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        quota: {
          ...quota,
          isVip: isVipVisitor(visitorId),
          remaining,
          total: quota.status === 'vip' || isVipVisitor(visitorId) ? '∞' : (quota.freeQuota + (quota.bonusQuota || 0))
        }
      }));
      return;
    }

    // POST /api/quotas/:visitorId - 更新用戶（配發額度、禁止、備註）
    if (req.method === 'POST' && urlPath.startsWith('/api/quotas/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const visitorId = decodeURIComponent(urlPath.replace('/api/quotas/', ''));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const updates = {};
        if (body.bonusQuota !== undefined) updates.bonusQuota = parseInt(body.bonusQuota) || 0;
        if (body.status !== undefined && ['active', 'banned', 'vip'].includes(body.status)) {
          updates.status = body.status;
        }
        if (body.note !== undefined) updates.note = String(body.note);
        if (body.addBonus !== undefined) {
          const current = getVisitorQuota(visitorId);
          updates.bonusQuota = (current.bonusQuota || 0) + parseInt(body.addBonus);
        }

        const updated = updateQuota(visitorId, updates);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, quota: updated }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // DELETE /api/quotas/:visitorId - 刪除用戶記錄
    if (req.method === 'DELETE' && urlPath.startsWith('/api/quotas/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const visitorId = decodeURIComponent(urlPath.replace('/api/quotas/', ''));
      deleteQuota(visitorId);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== 回饋 API ====================

    // POST /api/feedback - 提交回饋（公開 API）
    if (req.method === 'POST' && urlPath === '/api/feedback') {
      try {
        const body = await parseBody(req);
        const { type, message, contact, timestamp } = body;

        if (!type || !message) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        // 儲存回饋到檔案
        const feedbackDir = path.join(DATA_DIR, 'feedback');
        if (!fs.existsSync(feedbackDir)) {
          fs.mkdirSync(feedbackDir, { recursive: true });
        }

        const feedbackFile = path.join(feedbackDir, 'feedback.jsonl');
        const feedbackEntry = JSON.stringify({
          id: Date.now().toString(36),
          type,
          message,
          contact: contact || '',
          timestamp: timestamp || new Date().toISOString(),
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
        }) + '\n';

        fs.appendFileSync(feedbackFile, feedbackEntry);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ==================== 兌換碼 API ====================

    // POST /api/redeem - 兌換序號（公開 API，不需登入）
    if (req.method === 'POST' && urlPath === '/api/redeem') {
      try {
        const body = await parseBody(req);
        const code = body.code?.trim();
        const visitorId = body.visitorId;

        if (!code || !visitorId) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少兌換碼或訪客 ID' }));
          return;
        }

        const result = redeemCode(code, visitorId);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/redemptions - 取得所有兌換碼（需要管理員權限）
    if (req.method === 'GET' && urlPath === '/api/redemptions') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const redemptions = readAllRedemptions();
      const stats = {
        total: redemptions.length,
        used: redemptions.filter(r => r.usedBy).length,
        unused: redemptions.filter(r => !r.usedBy).length,
        expired: redemptions.filter(r => r.expiresAt && new Date(r.expiresAt) < new Date() && !r.usedBy).length
      };

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, redemptions, stats }));
      return;
    }

    // POST /api/redemptions/generate - 生成新兌換碼（需要管理員權限）
    if (req.method === 'POST' && urlPath === '/api/redemptions/generate') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const body = await parseBody(req);
        const count = Math.min(parseInt(body.count) || 1, 100); // 最多一次 100 個
        const bonus = parseInt(body.bonus) || 5;
        const expiresAt = body.expiresAt || null;
        const note = body.note || '';

        const codes = createRedemptionCodes(count, bonus, expiresAt, note);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, codes }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // DELETE /api/redemptions/:code - 刪除兌換碼（需要管理員權限）
    if (req.method === 'DELETE' && urlPath.startsWith('/api/redemptions/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const code = decodeURIComponent(urlPath.replace('/api/redemptions/', ''));
      deleteRedemptionCode(code);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== 使用者管理 API ====================

    // GET /api/users - 取得所有使用者（含設備資訊、貢獻統計）
    if (req.method === 'GET' && urlPath === '/api/users') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const users = readAllQuotas().map(q => ({
        visitorId: q.visitorId,
        usedCount: q.usedCount,
        freeQuota: q.freeQuota,
        bonusQuota: q.bonusQuota || 0,
        status: q.status || 'active',
        note: q.note || '',
        isVip: isVipVisitor(q.visitorId),
        remaining: getRemainingQuota(q),
        total: q.status === 'vip' || isVipVisitor(q.visitorId) ? '∞' : (q.freeQuota + (q.bonusQuota || 0)),
        lastUsed: q.lastUsed,
        history: q.history || [],
        // 設備資訊（由腳本回報）
        device: q.device || null,
        // 貢獻統計
        contribution: q.contribution || null
      }));

      // 按最後使用時間排序
      users.sort((a, b) => {
        if (!a.lastUsed) return 1;
        if (!b.lastUsed) return -1;
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });

      const jsonBody = JSON.stringify({ ok: true, users });
      sendCompressed(req, res, 200, corsHeaders(), jsonBody);
      return;
    }

    // PATCH /api/users/:visitorId - 更新使用者
    if (req.method === 'PATCH' && urlPath.startsWith('/api/users/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const visitorId = decodeURIComponent(urlPath.replace('/api/users/', ''));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const updates = {};
        if (body.status !== undefined && ['active', 'banned', 'vip'].includes(body.status)) {
          updates.status = body.status;
        }
        if (body.note !== undefined) updates.note = String(body.note);
        if (body.addBonus !== undefined) {
          const current = getVisitorQuota(visitorId);
          updates.bonusQuota = (current.bonusQuota || 0) + parseInt(body.addBonus);
        }

        const updated = updateQuota(visitorId, updates);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, user: updated }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/users/:visitorId/device - 腳本回報設備資訊
    if (req.method === 'POST' && urlPath.match(/^\/api\/users\/[^/]+\/device$/)) {
      try {
        const visitorId = decodeURIComponent(urlPath.replace('/api/users/', '').replace('/device', ''));
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

        const device = {
          lastSeen: Date.now(),
          network: {
            type: body.networkType || null,
            downlink: body.downlink || null,
            rtt: body.rtt || null
          },
          hardware: {
            cores: body.cores || null,
            memory: body.memory || null
          },
          battery: {
            level: body.batteryLevel || null,
            charging: body.batteryCharging || null
          }
        };

        updateQuota(visitorId, { device });
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/logs - 取得最近操作日誌
    if (req.method === 'GET' && urlPath === '/api/logs') {
      const records = readAllRecords();
      // 將最近的記錄轉換為日誌格式
      const logs = records
        .slice(-50)
        .reverse()
        .map(r => ({
          time: r.capturedAt,  // 正確的欄位名稱
          type: r.backupStatus === 'completed' ? 'upload' : (r.backupStatus === 'failed' ? 'error' : 'view'),
          message: `${r.type === 'video' ? '影片' : '圖片'}: ${r.title || r.pageUrl}`
        }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ logs }));
      return;
    }

    // GET /api/logs/stream - SSE 即時日誌串流
    if (req.method === 'GET' && urlPath === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // 送出連接成功訊息
      res.write(`data: ${JSON.stringify({ type: 'connected', message: '已連接即時日誌' })}\n\n`);

      // 加入客戶端列表
      sseClients.add(res);
      console.log(`[lurl] SSE 客戶端連接，目前 ${sseClients.size} 個`);

      // 客戶端斷開時移除
      req.on('close', () => {
        sseClients.delete(res);
        console.log(`[lurl] SSE 客戶端斷開，剩餘 ${sseClients.size} 個`);
      });

      return;
    }

    // DELETE /api/records/:id (需要登入)
    if (req.method === 'DELETE' && urlPath.startsWith('/api/records/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.replace('/api/records/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      // 刪除所有關聯檔案（主檔 + 縮圖 + 預覽 + HLS）
      const removedCount = fileStore.removeByTag(`record:${id}`);
      console.log(`[lurl] fileStore 刪除 ${removedCount} 個關聯檔案`);

      // Fallback: 如果 fileStore 沒刪到主檔，直接刪
      const filePath = path.join(DATA_DIR, record.backupPath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // 更新記錄（過濾掉要刪除的）
      const newRecords = records.filter(r => r.id !== id);
      fs.writeFileSync(RECORDS_FILE, newRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 已刪除: ${record.title}`);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/records/:id/vote (需要登入) - 投票（計數版）
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/vote$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const vote = body.vote; // 'like' | 'dislike'

      if (vote !== 'like' && vote !== 'dislike') {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Invalid vote value' }));
        return;
      }

      const records = readAllRecords();
      const recordIndex = records.findIndex(r => r.id === id);

      if (recordIndex === -1) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const record = records[recordIndex];
      const oldVote = record.myVote || null;

      // 初始化計數（舊記錄可能沒有）
      if (typeof record.likeCount !== 'number') record.likeCount = 0;
      if (typeof record.dislikeCount !== 'number') record.dislikeCount = 0;

      // 投票邏輯
      if (vote === oldVote) {
        // 點同一個 = 取消投票
        record.myVote = null;
        if (oldVote === 'like') record.likeCount = Math.max(0, record.likeCount - 1);
        if (oldVote === 'dislike') record.dislikeCount = Math.max(0, record.dislikeCount - 1);
      } else {
        // 點不同的 = 切換投票
        if (oldVote === 'like') record.likeCount = Math.max(0, record.likeCount - 1);
        if (oldVote === 'dislike') record.dislikeCount = Math.max(0, record.dislikeCount - 1);
        if (vote === 'like') record.likeCount++;
        if (vote === 'dislike') record.dislikeCount++;
        record.myVote = vote;
      }

      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 投票更新: ${record.title} -> ${record.myVote} (👍${record.likeCount} 👎${record.dislikeCount})`);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        likeCount: record.likeCount,
        dislikeCount: record.dislikeCount,
        myVote: record.myVote
      }));
      return;
    }

    // POST /api/records/:id/block (需要登入) - 封鎖/解除封鎖
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/block$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const block = body.block; // true | false

      const records = readAllRecords();
      const recordIndex = records.findIndex(r => r.id === id);

      if (recordIndex === -1) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const record = records[recordIndex];
      let deleted = false;

      if (block) {
        // 封鎖：刪除本地檔案和縮圖，保留記錄
        record.blocked = true;
        record.blockedAt = new Date().toISOString();

        // 透過 Pokkit 統一刪除所有關聯檔案
        const removedCount = fileStore.removeByTag(`record:${id}`);
        deleted = removedCount > 0;

        // Fallback: 確保主檔案也被刪除
        const filePath = path.join(DATA_DIR, record.backupPath);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted = true;
        }

        record.fileExists = false;
        console.log(`[lurl] 封鎖: ${record.title} (刪除 ${removedCount} 個檔案)`);
      } else {
        // 解除封鎖：清除封鎖狀態
        record.blocked = false;
        record.blockedAt = null;
        record.fileExists = false; // 需要重新下載
        console.log(`[lurl] 解除封鎖: ${record.title}`);
      }

      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, deleted }));
      return;
    }

    // PATCH /api/records/:id/tags (需要登入) - 更新標籤
    if (req.method === 'PATCH' && urlPath.match(/^\/api\/records\/[^/]+\/tags$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const { tags } = body;

      if (!Array.isArray(tags)) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'tags must be an array' }));
        return;
      }

      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Record not found' }));
        return;
      }

      record.tags = tags;
      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 標籤更新: ${record.title} -> [${tags.join(', ')}]`);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, tags: record.tags }));
      return;
    }

    // GET /api/tags - 取得所有可用標籤（階層式）
    if (req.method === 'GET' && urlPath === '/api/tags') {
      const TAG_TREE = {
        '奶子': ['穿衣', '裸體', '大奶', '露點'],
        '屁股': [],
        '鮑魚': [],
        '全身': [],
        '姿勢': ['女上', '傳教士', '背後'],
        '口交': []
      };
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ tagTree: TAG_TREE, mainTags: Object.keys(TAG_TREE) }));
      return;
    }

    // GET /api/blocked-urls (Client Token 驗證) - 給 Userscript 的封鎖清單
    if (req.method === 'GET' && urlPath === '/api/blocked-urls') {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '');

      if (token !== CLIENT_TOKEN && !isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const records = readAllRecords();
      const blockedUrls = records
        .filter(r => r.blocked)
        .map(r => r.fileUrl);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        urls: blockedUrls,
        count: blockedUrls.length,
        updatedAt: new Date().toISOString()
      }));
      return;
    }

    // ==================== 修復服務 API ====================

    // GET /api/check-backup - 檢查是否有備份（公開，用 visitorId）
    if (req.method === 'GET' && urlPath === '/api/check-backup') {
      const pageUrl = query.url;
      const visitorId = req.headers['x-visitor-id'];

      if (!pageUrl) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing url parameter' }));
        return;
      }

      // 從 URL 提取 ID（尾部），例如 https://lurl.cc/B0Fe7 → B0Fe7
      const urlId = pageUrl.split('/').pop().split('?')[0].toLowerCase();

      const records = readAllRecords();

      // 用 ID 匹配（大小寫不敏感），而非完整 URL
      const record = records.find(r => {
        if (r.blocked) return false;
        const recordId = r.pageUrl.split('/').pop().split('?')[0].toLowerCase();
        return recordId === urlId;
      });

      if (!record) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ hasBackup: false }));
        return;
      }

      // 檢查本地檔案是否存在（原始檔或 HLS 版本）
      const localFilePath = path.join(DATA_DIR, record.backupPath);
      const hlsPath = path.join(HLS_DIR, record.id, 'master.m3u8');
      const hasOriginal = fs.existsSync(localFilePath);
      const hasHLS = record.hlsReady && fs.existsSync(hlsPath);
      const fileExists = hasOriginal || hasHLS;

      if (!fileExists) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ hasBackup: false }));
        return;
      }

      // 優先使用原始檔，否則用 HLS
      const backupUrl = hasOriginal ? `/lurl/files/${record.backupPath}` : `/lurl/hls/${record.id}/master.m3u8`;

      // 檢查是否已修復過（不扣點直接給 URL）
      if (visitorId) {
        const recoveredEntry = hasRecovered(visitorId, urlId);
        if (recoveredEntry) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({
            hasBackup: true,
            alreadyRecovered: true,
            backupUrl,
            record: {
              id: record.id,
              title: record.title,
              type: record.type
            }
          }));
          return;
        }
      }

      // 取得額度資訊
      const quota = visitorId ? getVisitorQuota(visitorId) : { usedCount: 0, freeQuota: FREE_QUOTA, paidQuota: 0 };
      const remaining = getRemainingQuota(quota);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        hasBackup: true,
        alreadyRecovered: false,
        record: {
          id: record.id,
          title: record.title,
          type: record.type
        },
        quota: {
          remaining,
          total: quota.freeQuota + quota.paidQuota
        }
      }));
      return;
    }

    // POST /api/recover - 執行修復（消耗額度，冪等性：已修復過不重複扣點）
    if (req.method === 'POST' && urlPath === '/api/recover') {
      const visitorId = req.headers['x-visitor-id'];
      const body = await parseBody(req);
      const pageUrl = body.pageUrl;

      if (!visitorId) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing X-Visitor-Id header' }));
        return;
      }

      if (!pageUrl) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing pageUrl' }));
        return;
      }

      // 找備份（用 ID 匹配，大小寫不敏感）
      const urlId = pageUrl.split('/').pop().split('?')[0].toLowerCase();
      const records = readAllRecords();
      const record = records.find(r => {
        if (r.blocked) return false;
        const recordId = r.pageUrl.split('/').pop().split('?')[0].toLowerCase();
        return recordId === urlId;
      });

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'No backup found' }));
        return;
      }

      const localFilePath = path.join(DATA_DIR, record.backupPath);
      if (!fs.existsSync(localFilePath)) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Backup file not found' }));
        return;
      }

      const backupUrl = `/lurl/files/${record.backupPath}`;

      // 冪等性：檢查是否已修復過
      const recoveredEntry = hasRecovered(visitorId, urlId);
      if (recoveredEntry) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          alreadyRecovered: true,
          backupUrl,
          record: {
            id: record.id,
            title: record.title,
            type: record.type
          }
        }));
        return;
      }

      // 檢查額度
      const quota = getVisitorQuota(visitorId);
      const remaining = getRemainingQuota(quota);

      if (remaining === 0) {
        // -1 = 無限 (VIP)，0 = 用完或封禁，>0 = 還有額度
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: false,
          error: 'quota_exhausted',
          message: '免費額度已用完'
        }));
        return;
      }

      // 扣額度（帶入 urlId 和 backupUrl）
      const newQuota = useQuota(visitorId, pageUrl, urlId, backupUrl);
      const newRemaining = getRemainingQuota(newQuota);

      console.log(`[lurl] 修復服務: ${record.title} (visitor: ${visitorId.substring(0, 8)}..., 剩餘: ${newRemaining})`);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        backupUrl: `/lurl/files/${record.backupPath}`,
        record: {
          id: record.id,
          title: record.title,
          type: record.type
        },
        quota: {
          remaining: newRemaining,
          total: newQuota.freeQuota + newQuota.paidQuota
        }
      }));
      return;
    }

    // ==================== Phase 3 ====================

    // GET /sw.js - Service Worker for HLS caching
    if (req.method === 'GET' && urlPath === '/sw.js') {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/lurl/'
      }, serviceWorkerScript());
      return;
    }

    // GET /browse (需要登入)
    if (req.method === 'GET' && urlPath === '/browse') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/browse' });
        res.end();
        return;
      }
      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), browsePage());
      return;
    }

    // GET /view/:id (需要登入)
    if (req.method === 'GET' && urlPath.startsWith('/view/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': `/lurl/login?redirect=/lurl${urlPath}` });
        res.end();
        return;
      }
      const id = urlPath.replace('/view/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders('text/html; charset=utf-8'));
        res.end('<h1>404 - 找不到此內容</h1><a href="javascript:history.back()">返回影片庫</a>');
        return;
      }

      // 檢查本地檔案是否存在（原始檔或 HLS 版本）
      const localFilePath = path.join(DATA_DIR, record.backupPath);
      const hlsPath = path.join(HLS_DIR, record.id, 'master.m3u8');
      const fileExists = fs.existsSync(localFilePath) || (record.hlsReady && fs.existsSync(hlsPath));

      // 取得會員資訊（用於收藏功能）
      // 如果是 admin 登入但沒有會員帳號，給予 admin 權限
      let user = getMemberFromRequest(req);
      if (!user && isAdminAuthenticated(req)) {
        user = { id: 'admin', tier: 'admin', nickname: '管理員', email: 'admin@system' };
      }

      sendCompressed(req, res, 200, corsHeaders('text/html; charset=utf-8'), viewPage(record, fileExists, user));
      return;
    }

    // POST /api/retry/:id - 重新下載檔案 (需要登入)
    if (req.method === 'POST' && urlPath.startsWith('/api/retry/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.replace('/api/retry/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const targetDir = record.type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
      const localFilePath = path.join(DATA_DIR, record.backupPath);

      // 用 pageUrl 當 Referer 來下載
      const success = await downloadFile(record.fileUrl, localFilePath, record.pageUrl);

      if (success) {
        console.log(`[lurl] 重試下載成功: ${record.title}`);
        // 註冊到 Pokkit
        try {
          const bucket = record.type === 'video' ? 'videos' : 'images';
          const filename = path.basename(record.backupPath);
          const mime = record.type === 'video' ? 'video/mp4' : 'application/octet-stream';
          fileStore.adopt(bucket, filename, mime, {
            id: `${bucket}:${record.id}`,
            tags: [`record:${record.id}`, `type:${record.type}`],
            metadata: { recordId: record.id, title: record.title },
          });
        } catch (e) { /* skip if exists */ }
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '下載失敗，CDN 可能已過期' }));
      }
      return;
    }

    // GET/HEAD /hls/:recordId/* - HLS 串流檔案
    if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/hls/')) {
      const hlsPath = decodeURIComponent(urlPath.replace('/hls/', ''));
      const fullHlsPath = path.join(HLS_DIR, hlsPath);

      if (!fs.existsSync(fullHlsPath) || fs.statSync(fullHlsPath).isDirectory()) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ error: 'HLS file not found' }));
        return;
      }

      const ext = path.extname(fullHlsPath).toLowerCase();
      const mimeTypes = {
        '.m3u8': 'application/vnd.apple.mpegurl',
        '.ts': 'video/mp2t'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.statSync(fullHlsPath);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': ext === '.m3u8' ? 'no-cache' : 'public, max-age=31536000, immutable'
      });

      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(fullHlsPath).pipe(res);
      }
      return;
    }

    // POST /api/callback/hls/:id - workr HLS 轉檔完成回調
    if (req.method === 'POST' && urlPath.startsWith('/api/callback/hls/')) {
      const recordId = urlPath.replace('/api/callback/hls/', '');
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          console.log(`[HLS] Callback 收到: ${recordId}`, data.status);

          if (data.status === 'completed' && data.result?.success) {
            // 更新記錄
            updateRecord(recordId, {
              hlsReady: true,
              hlsPath: `hls/${recordId}/master.m3u8`
            });
            console.log(`[HLS] ${recordId} 轉檔完成，已更新記錄`);
            broadcastLog({ type: 'hls_complete', recordId });
          } else if (data.status === 'failed') {
            console.error(`[HLS] ${recordId} 轉檔失敗:`, data.error);
            broadcastLog({ type: 'hls_error', recordId, error: data.error });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error(`[HLS] Callback 解析失敗:`, e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // POST /api/hls/transcode/:id - 觸發 HLS 轉檔
    if (req.method === 'POST' && urlPath.startsWith('/api/hls/transcode/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const recordId = urlPath.replace('/api/hls/transcode/', '');
      queueHLSTranscode(recordId);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, message: '已加入轉檔佇列' }));
      return;
    }

    // POST /api/hls/transcode-all - 批次轉檔所有影片
    if (req.method === 'POST' && urlPath === '/api/hls/transcode-all') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const records = readAllRecords();
      const videos = records.filter(r => r.type === 'video' && r.fileExists !== false && !r.hlsReady);
      videos.forEach(r => queueHLSTranscode(r.id));
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, queued: videos.length }));
      return;
    }

    // GET /api/hls/status - 取得 HLS 轉檔狀態
    if (req.method === 'GET' && urlPath === '/api/hls/status') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify(getHLSStatus()));
      return;
    }

    // GET/HEAD /files/videos/:filename 或 /files/images/:filename
    if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/files/')) {
      const filePath = decodeURIComponent(urlPath.replace('/files/', '')); // URL decode 中文檔名

      // 防止讀取資料夾
      if (!filePath || filePath.endsWith('/') || !filePath.includes('.')) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: 'Invalid file path' }));
        return;
      }

      const fullFilePath = path.join(DATA_DIR, filePath);

      if (!fs.existsSync(fullFilePath) || fs.statSync(fullFilePath).isDirectory()) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      const ext = path.extname(fullFilePath).toLowerCase();
      const mimeTypes = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.statSync(fullFilePath);
      const fileSize = stat.size;

      // 支援 Range 請求（影片串流必需）
      const range = req.headers.range;
      if (range && contentType.startsWith('video/')) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(fullFilePath, { start, end }).pipe(res);
        }
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fileSize,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable'
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(fullFilePath).pipe(res);
        }
      }
      return;
    }

    // 404
    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};
