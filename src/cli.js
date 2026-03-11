#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';
import dotenv from 'dotenv';
import { authorize } from './auth.js';
import { scanDuplicateGroups } from './scanner.js';

dotenv.config();

function parseOptions(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--apply') {
      opts.apply = true;
      continue;
    }
    if (key === '--help' || key === '-h') {
      opts.help = true;
      continue;
    }
    if (key === '--title' || key === '--keep' || key === '--output') {
      const value = argv[i + 1];
      if (value == null) throw new Error(`缺少參數：${key}`);
      opts[key.slice(2)] = value;
      i += 1;
    }
  }
  return opts;
}

function usage() {
  return `ytm-dedupe: 清理 YouTube / YouTube Music 重複 playlist（同名且內容完全一致）

用法:
  ytm-dedupe scan [--title <title>] [--keep oldest|newest]
  ytm-dedupe delete [--title <title>] [--keep oldest|newest] [--apply] [--output <file>]

說明:
  預設為 dry-run，不會刪除。只有加上 --apply 才會真的刪除 playlist。
`;
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
  console.log('same title, same item count, identical ordered resource IDs');
}

function printSummary(result, mode) {
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
  if (mode === 'delete') {
    console.log('\n目前為 dry-run，未加 --apply 不會刪除。');
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

async function runCommand(command, options) {
  const commandOptions = {
    title: options.title,
    keep: validateKeepOption(options.keep || 'oldest'),
  };

  const auth = await authorize().catch((err) => {
    const msg = extractApiMessage(err);
    throw new Error(`OAuth 失敗：${msg}`);
  });
  const youtube = google.youtube({ version: 'v3', auth });

  const result = await scanDuplicateGroups(youtube, commandOptions).catch((err) => {
    throw new Error(`scan 失敗：${extractApiMessage(err)}`);
  });

  if (command === 'scan') {
    for (const g of result.duplicates) printGroup(g);
    printSummary(result, 'scan');
    return;
  }

  // delete command
  for (const g of result.duplicates) printGroup(g);
  printSummary(result, 'delete');
  if (!options.apply) {
    return;
  }

  const backupPath = await buildReportAndMaybeWrite(result, options.output).catch((err) => {
    throw new Error(`備份檔案寫入失敗：${err.message}`);
  });
  console.log(`\n已寫入刪除前備份：${backupPath}`);

  const deleteTargets = result.duplicates.flatMap((g) => g.delete);
  const failures = [];
  let deleted = 0;
  for (const target of deleteTargets) {
    try {
      await youtube.playlists.delete({ id: target.playlistId });
      deleted += 1;
      console.log(`已刪除: ${target.playlistId}`);
    } catch (err) {
      const msg = extractApiMessage(err);
      failures.push({ playlistId: target.playlistId, reason: msg });
      console.error(`刪除失敗: ${target.playlistId} -> ${msg}`);
    }
  }

  console.log(`\n刪除完成：成功 ${deleted} / ${deleteTargets.length}`);
  if (failures.length) {
    console.log(`失敗 ${failures.length} 筆，其他項目仍會繼續處理：`);
    for (const f of failures) console.log(`- ${f.playlistId}: ${f.reason}`);
  } else {
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

main().catch(async (err) => {
  console.error(`\n致命錯誤：${err.message}`);
  process.exitCode = 1;
});
