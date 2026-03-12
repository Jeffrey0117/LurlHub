#!/usr/bin/env node
'use strict';

/**
 * migrate-to-pokkit.js
 *
 * Migrate LurlHub's existing files into Pokkit core index (SQLite).
 * This script does NOT move files — it calls adopt() to register
 * existing on-disk files in pokkit.db.
 *
 * Usage:
 *   node scripts/migrate-to-pokkit.js             # dry-run (preview only)
 *   node scripts/migrate-to-pokkit.js --run        # actually migrate
 */

const path = require('node:path');
const fs = require('node:fs');
const PokkitStore = require('../../pokkit/core');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRY_RUN = !process.argv.includes('--run');

if (DRY_RUN) {
  console.log('=== DRY RUN (use --run to actually migrate) ===\n');
}

// Initialize the store (same config as lurl.js will use)
const store = new PokkitStore({
  dataDir: DATA_DIR,
  buckets: {
    videos: { mode: 'flat' },
    images: { mode: 'flat' },
    thumbnails: { mode: 'flat' },
    previews: { mode: 'flat' },
    hls: { mode: 'flat' },
  },
  dbName: 'pokkit.db',
});

// Load all records from LurlHub's SQLite DB
const lurlDb = require(path.join(__dirname, '..', '_lurl-db'));
lurlDb.init();
const records = lurlDb.getAllRecords();

console.log(`Found ${records.length} records in LurlHub DB\n`);

const stats = {
  videos: { found: 0, adopted: 0, skipped: 0, missing: 0 },
  images: { found: 0, adopted: 0, skipped: 0, missing: 0 },
  thumbnails: { found: 0, adopted: 0, skipped: 0, missing: 0 },
  previews: { found: 0, adopted: 0, skipped: 0, missing: 0 },
  hls: { found: 0, adopted: 0, skipped: 0, missing: 0 },
};

for (const record of records) {
  const tags = [`record:${record.id}`];

  // 1. Main file (video or image)
  if (record.backupPath) {
    const isVideo = record.backupPath.startsWith('videos/');
    const isImage = record.backupPath.startsWith('images/');
    const bucket = isVideo ? 'videos' : isImage ? 'images' : null;

    if (bucket) {
      const filename = path.basename(record.backupPath);
      const filePath = path.join(DATA_DIR, record.backupPath);
      const cat = bucket;

      stats[cat].found++;

      if (!fs.existsSync(filePath)) {
        stats[cat].missing++;
      } else if (store.exists(`${cat}:${record.id}`)) {
        stats[cat].skipped++;
      } else {
        if (!DRY_RUN) {
          try {
            const mime = isVideo ? 'video/mp4' : guessMime(filename);
            store.adopt(bucket, filename, mime, {
              id: `${cat}:${record.id}`,
              tags: [...tags, `type:${cat === 'videos' ? 'video' : 'image'}`],
              metadata: { recordId: record.id, title: record.title },
            });
            stats[cat].adopted++;
          } catch (err) {
            console.warn(`  [WARN] ${cat} adopt failed for ${record.id}: ${err.message}`);
            stats[cat].missing++;
          }
        } else {
          stats[cat].adopted++; // count as would-adopt
        }
      }
    }
  }

  // 2. Thumbnail
  if (record.thumbnailPath) {
    const filename = path.basename(record.thumbnailPath);
    const filePath = path.join(DATA_DIR, record.thumbnailPath);

    stats.thumbnails.found++;

    if (!fs.existsSync(filePath)) {
      stats.thumbnails.missing++;
    } else if (store.exists(`thumb:${record.id}`)) {
      stats.thumbnails.skipped++;
    } else {
      if (!DRY_RUN) {
        try {
          store.adopt('thumbnails', filename, 'image/webp', {
            id: `thumb:${record.id}`,
            tags: [...tags, 'type:thumbnail'],
            metadata: { recordId: record.id },
          });
          stats.thumbnails.adopted++;
        } catch (err) {
          console.warn(`  [WARN] thumbnail adopt failed for ${record.id}: ${err.message}`);
          stats.thumbnails.missing++;
        }
      } else {
        stats.thumbnails.adopted++;
      }
    }
  }

  // 3. Preview
  const previewPath = path.join(DATA_DIR, 'previews', `${record.id}.mp4`);
  if (fs.existsSync(previewPath)) {
    stats.previews.found++;

    if (store.exists(`preview:${record.id}`)) {
      stats.previews.skipped++;
    } else {
      if (!DRY_RUN) {
        try {
          store.adopt('previews', `${record.id}.mp4`, 'video/mp4', {
            id: `preview:${record.id}`,
            tags: [...tags, 'type:preview'],
            metadata: { recordId: record.id },
          });
          stats.previews.adopted++;
        } catch (err) {
          console.warn(`  [WARN] preview adopt failed for ${record.id}: ${err.message}`);
          stats.previews.missing++;
        }
      } else {
        stats.previews.adopted++;
      }
    }
  }

  // 4. HLS directory
  const hlsDir = path.join(DATA_DIR, 'hls', record.id);
  const hlsMaster = path.join(hlsDir, 'master.m3u8');
  if (fs.existsSync(hlsMaster)) {
    stats.hls.found++;

    if (store.exists(`hls:${record.id}`)) {
      stats.hls.skipped++;
    } else {
      if (!DRY_RUN) {
        try {
          store.registerDirectory(`hls:${record.id}`, 'hls', record.id, {
            tags: [...tags, 'type:hls'],
            metadata: { recordId: record.id },
          });
          stats.hls.adopted++;
        } catch (err) {
          console.warn(`  [WARN] HLS register failed for ${record.id}: ${err.message}`);
          stats.hls.missing++;
        }
      } else {
        stats.hls.adopted++;
      }
    }
  }
}

// Print summary
console.log('\n=== Migration Summary ===\n');
console.log('Category     | Found | Adopted | Skipped | Missing');
console.log('-------------|-------|---------|---------|--------');
for (const [cat, s] of Object.entries(stats)) {
  console.log(
    `${cat.padEnd(13)}| ${String(s.found).padEnd(6)}| ${String(s.adopted).padEnd(8)}| ${String(s.skipped).padEnd(8)}| ${s.missing}`
  );
}

const totalAdopted = Object.values(stats).reduce((sum, s) => sum + s.adopted, 0);
const totalFound = Object.values(stats).reduce((sum, s) => sum + s.found, 0);

console.log(`\nTotal: ${totalAdopted}/${totalFound} files ${DRY_RUN ? 'would be' : ''} adopted`);

if (!DRY_RUN) {
  const dbStats = store.stats();
  console.log(`\nPokkit DB now has ${dbStats.totalFiles} files (${formatBytes(dbStats.totalBytes)})`);
}

store.close();

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  };
  return mimes[ext] || 'application/octet-stream';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}
