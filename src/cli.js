#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import { authorize } from './auth.js';
import { scanDuplicateGroups } from './scanner.js';

dotenv.config();

const DEFAULT_CACHE_PATH = 'cache/scan-cache.json';
const DEFAULT_DELETE_STATE_PATH = 'cache/delete-progress.json';

function parseOptions(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--apply') {
      opts.apply = true;
      continue;
    }
    if (key === '--refresh') {
      opts.refresh = true;
      continue;
    }
    if (key === '--fast') {
      opts.fast = true;
      continue;
    }
    if (key === '--help' || key === '-h') {
      opts.help = true;
      continue;
    }
    if (key === '--title' || key === '--keep' || key === '--output' || key === '--cache' || key === '--state') {
      const value = argv[i + 1];
      if (value == null) throw new Error(`缺少參數：${key}`);
      opts[key.slice(2)] = value;
      i += 1;
      continue;
    }
  }
  return opts;
}

function usage() {
  return `ytm-dedupe: 清理 YouTube / YouTube Music 重複 playlist（同名且內容完全一致）

用法:
  ytm-dedupe scan [--title <title>] [--keep oldest|newest] [--fast]
  ytm-dedupe delete [--title <title>] [--keep oldest|newest] [--apply] [--fast] [--output <file>] [--cache <path>] [--state <file>] [--refresh]

說明:
  預設為 dry-run，不會刪除。只有加上 --apply 才會真的刪除 playlist。
  delete 預設會優先使用本地快取：${DEFAULT_CACHE_PATH}，可用 --refresh 強制重抓。
  加上 --fast 可改用快速流程：只以「同名 + itemCount」判定重複，不抓 playlistItems。
  fast 模式下會直接執行刪除，不再保留預覽模式；若要保留預覽請先用 scan --fast。
`;
}

function getDeleteStatePath(rawPath) {
  return path.resolve(process.cwd(), expandHome(rawPath || DEFAULT_DELETE_STATE_PATH));
}

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getCachePath(rawPath) {
  return path.resolve(process.cwd(), expandHome(rawPath || DEFAULT_CACHE_PATH));
}

async function loadCachedResult(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveCachedResult(cachePath, result) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf8');
}

async function loadDeleteState(statePath) {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function saveDeleteState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function buildDeleteFingerprint(result) {
  const signatureSource = result.duplicates
    .map((g) => {
      const dels = g.delete.map((item) => `${item.playlistId}:${item.signature}`).sort().join(',');
      return `${g.title}|${g.signature}|${dels}`;
    })
    .sort()
    .join('\n');
  return createHash('sha1').update(signatureSource).digest('hex');
}

function buildDeletePlan(result, cachePath) {
  const groups = result.duplicates;
  return {
    generatedAt: new Date().toISOString(),
    command: 'delete',
    mode: result.mode,
    cachePath,
    fingerprint: buildDeleteFingerprint(result),
    totals: {
      totalPlaylists: result.totals.totalPlaylists,
      duplicateGroups: groups.length,
      toDelete: groups.reduce((sum, g) => sum + g.delete.length, 0),
    },
    targets: groups.flatMap((g) => g.delete.map((d) => ({
      groupTitle: g.title,
      groupSignature: g.signature,
      playlistId: d.playlistId,
      title: d.title,
    }))),
    results: {},
  };
}

function isNotFoundError(err) {
  const status = err?.response?.status;
  const reason = err?.response?.data?.error?.errors?.[0]?.reason;
  const message = (err?.response?.data?.error?.message || err?.message || '').toLowerCase();
  return status === 404 || reason === 'notFound' || reason === 'playlistNotFound' || message.includes('not found');
}

function markDeleteProgress(state, playlistId, status, reason) {
  state.results[playlistId] = {
    status,
    reason,
    at: new Date().toISOString(),
  };
}

function extractApiMessage(error) {
  const apiErr = error?.response?.data?.error;
  if (apiErr) {
    const reason = apiErr.errors?.[0]?.reason || '';
    const msg = apiErr.message || 'YouTube API error';
    return `${msg}${reason ? ` (${reason})` : ''}`;
  }
  return error?.message || 'unknown error';
}

function printGroup(group) {
  console.log(`\nDuplicate group: ${group.title}`);
  console.log(`Signature: ${group.signature}`);
  console.log('Keep:');
  console.log(group.keep.playlistId);
  console.log('Delete:');
  for (const item of group.delete) {
    console.log(item.playlistId);
  }
  console.log('Reason:');
  console.log(group.reason || 'same title, same item count, identical ordered resource IDs');
}

function printSummary(result, mode, isApply = false) {
  console.log('\n=== 掃描摘要 ===');
  console.log(`總 playlist 數: ${result.totals.totalPlaylists}`);
  console.log(`重複群組數: ${result.totals.duplicateGroups}`);
  console.log(`待刪除 playlist 數: ${result.totals.toDelete}`);
  if (result.errors?.itemFetchFailures?.length) {
    console.log(`\nItem 抓取失敗: ${result.errors.itemFetchFailures.length}`);
    for (const it of result.errors.itemFetchFailures) {
      console.log(`- ${it.playlistId} (${it.title}): ${it.error}`);
    }
  }
  if (result.mode === 'fast') {
    console.log('\n目前使用快速模式：依「同名 + itemCount」判斷重複（未比對播放清單內容順序）。');
  }
  if (mode === 'delete' && !isApply) {
    console.log('\n目前為 dry-run，未加 --apply 不會刪除。');
  }
}

function printProgress(ev) {
  if (!ev) return;
  switch (ev.stage) {
    case 'playlistsTotal':
      console.log(`已找到 ${ev.total} 個播放清單（包含已過濾/未過濾）`);
      return;
    case 'playlistPage':
      console.log(`playlists.list 第 ${ev.page} 頁已抓取，累計 ${ev.count} 筆`);
      return;
    case 'playlistStart':
      console.log(`開始抓取 Playlist ${ev.index}/${ev.total}：${ev.playlistId} (${ev.title})`);
      return;
    case 'playlistItemPage':
      console.log(`  ${ev.playlistId} page ${ev.page}: 已抓 ${ev.fetched} 筆 items`);
      return;
    case 'playlistDone':
      console.log(`完成 Playlist ${ev.index}/${ev.total}：${ev.playlistId}，items=${ev.itemCount}`);
      return;
    default:
      return;
  }
}

function defaultBackupPath() {
  const t = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), `ytm-dedupe-backup-${t}.json`);
}

function validateKeepOption(keepMode) {
  if (!keepMode) return 'oldest';
  if (keepMode !== 'oldest' && keepMode !== 'newest') {
    throw new Error('--keep 目前僅支援 oldest 或 newest');
  }
  return keepMode;
}

function applyTitleFilter(result, title) {
  if (!title) return result;
  const duplicates = result.duplicates.filter((g) => g.title === title);
  return {
    ...result,
    duplicates,
    totals: {
      ...result.totals,
      duplicateGroups: duplicates.length,
      toDelete: duplicates.reduce((sum, g) => sum + g.delete.length, 0),
    },
  };
}

async function buildReportAndMaybeWrite(result, outputPath) {
  const out = {
    generatedAt: result.generatedAt,
    command: 'delete',
    groups: result.duplicates.map((g) => ({
      title: g.title,
      signature: g.signature,
      keep: {
        playlistId: g.keep.playlistId,
        title: g.keep.title,
      },
      delete: g.delete.map((d) => ({ playlistId: d.playlistId })),
      itemsSummary: [
        { playlistId: g.keep.playlistId, signature: g.keep.signature },
        ...g.delete.map((d) => ({ playlistId: d.playlistId, signature: d.signature })),
      ],
    })),
  };

  const backupPath = outputPath || defaultBackupPath();
  await fs.writeFile(backupPath, JSON.stringify(out, null, 2), 'utf8');
  return backupPath;
}

async function loadOrCreateScanResult(commandOptions, cachePath, forceRefresh) {
  const preferCache = !forceRefresh;
  if (preferCache) {
    const cached = await loadCachedResult(cachePath);
    const mode = commandOptions.fast ? 'fast' : 'full';
    if (cached?.duplicates && cached?.mode === mode) return cached;
  }

  const auth = await authorize().catch((err) => {
    const msg = extractApiMessage(err);
    throw new Error(`OAuth 失敗：${msg}`);
  });
  const youtube = google.youtube({ version: 'v3', auth });
  const result = await scanDuplicateGroups(youtube, {
    ...commandOptions,
    onProgress: printProgress,
  }).catch((err) => {
    throw new Error(`scan 失敗：${extractApiMessage(err)}`);
  });
  await saveCachedResult(cachePath, result).catch(() => {
    console.warn(`無法寫入快取：${cachePath}`);
  });
  return result;
}

async function runCommand(command, options) {
  const commandOptions = {
    title: options.title,
    keep: validateKeepOption(options.keep || 'oldest'),
    fast: Boolean(options.fast),
  };
  const cachePath = getCachePath(process.env.YTM_CACHE_PATH || options.cache);

  const modeText = command === 'scan' ? 'scan' : 'delete';
  console.log(`\n開始執行 ${modeText}，請稍候...`);

  const freshScanNeeded = command === 'scan' || options.refresh;
  const result = await loadOrCreateScanResult(commandOptions, cachePath, freshScanNeeded).then((r) => {
    if (command === 'delete' && !options.refresh) return applyTitleFilter(r, commandOptions.title);
    return command === 'scan' ? applyTitleFilter(r, commandOptions.title) : r;
  });

  if (command === 'scan') {
    console.log(`快取已儲存：${cachePath}`);
    for (const g of result.duplicates) printGroup(g);
    printSummary(result, 'scan');
    return;
  }

  for (const g of result.duplicates) printGroup(g);
  printSummary(result, 'delete', options.apply || options.fast);
  const shouldApply = options.apply || options.fast;
  if (!shouldApply) return;

  const auth = await authorize().catch((err) => {
    const msg = extractApiMessage(err);
    throw new Error(`OAuth 失敗：${msg}`);
  });
  const youtube = google.youtube({ version: 'v3', auth });

  const backupPath = await buildReportAndMaybeWrite(result, options.output).catch((err) => {
    throw new Error(`備份檔案寫入失敗：${err.message}`);
  });
  console.log(`\n已寫入刪除前備份：${backupPath}`);

  const statePath = getDeleteStatePath(process.env.YTM_DELETE_STATE_PATH || options.state);
  const newPlan = buildDeletePlan(result, cachePath);
  const prevState = await loadDeleteState(statePath);
  const state = prevState && prevState.fingerprint === newPlan.fingerprint
    ? { ...prevState }
    : newPlan;
  state.generatedAt = newPlan.generatedAt;
  state.fingerprint = newPlan.fingerprint;
  state.mode = newPlan.mode;
  state.cachePath = newPlan.cachePath;
  state.targets = newPlan.targets;
  if (!state.results) state.results = {};
  await saveDeleteState(statePath, state);

  const deleteTargets = state.targets.filter((item) => {
    const r = state.results[item.playlistId];
    return !(r && (r.status === 'done' || r.status === 'skipped'));
  });

  const failures = [];
  const skipped = [];
  let deleted = 0;
  const alreadyDone = state.targets.length - deleteTargets.length;
  console.log(`\n待刪除項目：${deleteTargets.length}，已完成/已跳過：${alreadyDone}`);

  if (!deleteTargets.length) {
    console.log('沒有待處理的刪除項目，本次流程直接結束。');
    return;
  }

  for (const target of deleteTargets) {
    try {
      await youtube.playlists.delete({ id: target.playlistId });
      deleted += 1;
      markDeleteProgress(state, target.playlistId, 'done');
      console.log(`已刪除: ${target.playlistId}`);
    } catch (err) {
      const msg = extractApiMessage(err);
      const status = isNotFoundError(err) ? 'skipped' : 'failed';
      markDeleteProgress(state, target.playlistId, status, msg);
      if (status === 'skipped') {
        skipped.push({ playlistId: target.playlistId, reason: msg });
      } else {
        failures.push({ playlistId: target.playlistId, reason: msg });
      }
      console.error(`刪除失敗: ${target.playlistId} -> ${msg}`);
    } finally {
      await saveDeleteState(statePath, state);
    }
  }

  console.log(`\n刪除完成：成功 ${deleted} / ${deleteTargets.length}`);
  if (failures.length) {
    console.log(`失敗 ${failures.length} 筆，其他項目仍會繼續處理：`);
    for (const f of failures) console.log(`- ${f.playlistId}: ${f.reason}`);
  }
  if (skipped.length) {
    console.log(`\\n已跳過 ${skipped.length} 筆（先前已刪除）：`);
    for (const s of skipped) console.log(`- ${s.playlistId}: ${s.reason}`);
  }
  if (!failures.length && !skipped.length) {
    console.log('全部刪除完成。');
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }

  const options = parseOptions(rest);
  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    if (command === 'scan') {
      await runCommand('scan', options);
      return;
    }
    if (command === 'delete') {
      await runCommand('delete', options);
      return;
    }
    console.log(usage());
  } catch (err) {
    console.error(`\n錯誤：${err.message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n致命錯誤：${err.message}`);
  process.exitCode = 1;
});
