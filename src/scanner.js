import { createHash } from 'node:crypto';

const MAX_RESULTS = 50;
const MAX_PAGES_WARNING = 2000;

function makeSignature(title, orderedIds) {
  const body = `${title}|${orderedIds.join(',')}`;
  return createHash('sha1').update(body).digest('hex');
}

function emitProgress(progress, payload) {
  if (typeof progress === 'function') {
    progress(payload);
  }
}

function extractResourceKey(item) {
  const rid = item.snippet?.resourceId || item.contentDetails || {};
  if (rid.videoId) return `video:${rid.videoId}`;
  if (rid.playlistId) return `playlist:${rid.playlistId}`;
  if (rid.channelId) return `channel:${rid.channelId}`;
  return item.id || '';
}

function safePageLoop(nextPageToken, seen) {
  if (!nextPageToken) return false;
  if (seen.has(nextPageToken)) return false;
  seen.add(nextPageToken);
  return true;
}

export async function listAllPlaylists(youtube, opts = {}) {
  const playlists = [];
  const titleFilter = opts.titleFilter;
  const progress = opts.onProgress;
  let pageToken;
  const seen = new Set();
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > MAX_PAGES_WARNING) {
      throw new Error(`playlists.list 分頁超過 ${MAX_PAGES_WARNING} 頁，停止避免無窮迴圈。`);
    }

    const res = await youtube.playlists.list({
      part: 'id,snippet,contentDetails',
      mine: true,
      maxResults: MAX_RESULTS,
      pageToken,
    });

    const items = res.data.items || [];
    for (const p of items) {
      const title = p.snippet?.title || '';
      if (titleFilter && title !== titleFilter) continue;
      playlists.push({
        playlistId: p.id,
        title,
        publishedAt: p.snippet?.publishedAt || null,
        itemCount: Number(p.contentDetails?.itemCount || 0),
        sequence: playlists.length,
      });
    }

    pageToken = res.data.nextPageToken;
    emitProgress(progress, {
      stage: 'playlistPage',
      page: pageCount,
      count: playlists.length,
      hasMore: Boolean(pageToken),
    });
  } while (safePageLoop(pageToken, seen));

  return playlists;
}

export async function listPlaylistResourceIds(youtube, playlistId, progress) {
  const ids = [];
  const progress = arguments[2];
  let pageToken;
  const seen = new Set();
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > MAX_PAGES_WARNING) {
      throw new Error(`playlistItems.list 分頁超過 ${MAX_PAGES_WARNING} 頁，停止避免無窮迴圈。`);
    }

    const res = await youtube.playlistItems.list({
      part: 'id,snippet,contentDetails',
      playlistId,
      maxResults: MAX_RESULTS,
      pageToken,
    });
    const items = res.data.items || [];
    for (const item of items) {
      ids.push(extractResourceKey(item));
    }
    pageToken = res.data.nextPageToken;
    emitProgress(progress, {
      stage: 'playlistItemPage',
      playlistId,
      page: pageCount,
      fetched: ids.length,
      hasMore: Boolean(pageToken),
    });
  } while (safePageLoop(pageToken, seen));

  return ids;
}

export async function scanDuplicateGroups(youtube, options = {}) {
  const progress = options.onProgress;
  const playlists = await listAllPlaylists(youtube, {
    titleFilter: options.title,
    onProgress: (ev) => emitProgress(progress, ev),
  });
  const validPlaylists = [];
  const itemErrors = [];
  emitProgress(progress, {
    stage: 'playlistsTotal',
    total: playlists.length,
  });

  for (let i = 0; i < playlists.length; i += 1) {
    const playlist = playlists[i];
    emitProgress(progress, {
      stage: 'playlistStart',
      index: i + 1,
      total: playlists.length,
      playlistId: playlist.playlistId,
      title: playlist.title,
    });

    try {
      const orderedResourceIds = await listPlaylistResourceIds(
        youtube,
        playlist.playlistId,
        (ev) => emitProgress(progress, { ...ev, index: i + 1, total: playlists.length }),
      );
      if (orderedResourceIds.length !== playlist.itemCount) {
        playlist.fetchedItemCount = orderedResourceIds.length;
      } else {
        playlist.fetchedItemCount = playlist.itemCount;
      }

      playlist.orderedResourceIds = orderedResourceIds;
      playlist.signature = makeSignature(playlist.title, orderedResourceIds);
      validPlaylists.push(playlist);
    } catch (error) {
      const message = (error?.response?.data?.error?.message) || error?.message || String(error);
      itemErrors.push({
        playlistId: playlist.playlistId,
        title: playlist.title,
        error: message,
      });
    }

    emitProgress(progress, {
      stage: 'playlistDone',
      index: i + 1,
      total: playlists.length,
      playlistId: playlist.playlistId,
      title: playlist.title,
      itemCount: playlist.orderedResourceIds?.length || 0,
    });
  }

  const groups = new Map();
  for (const item of validPlaylists) {
    const key = `${item.title}\n${item.itemCount}\n${item.signature}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const duplicates = [];
  for (const playlistsWithSame of groups.values()) {
    if (playlistsWithSame.length <= 1) continue;

    const keepMode = options.keep || 'oldest';
    const withPublishedAt = playlistsWithSame
      .map((item) => ({ ...item, _publishedTs: Date.parse(item.publishedAt || '') }))
      .filter((item) => Number.isFinite(item._publishedTs));

    let keep;
    if (withPublishedAt.length === 0) {
      const orderedByScan = [...playlistsWithSame].sort((a, b) => a.sequence - b.sequence);
      keep = orderedByScan[0];
      if (keepMode === 'newest') {
        keep = orderedByScan[orderedByScan.length - 1];
      }
    } else if (keepMode === 'newest') {
      withPublishedAt.sort((a, b) => b._publishedTs - a._publishedTs);
      keep = withPublishedAt[0];
    } else {
      withPublishedAt.sort((a, b) => a._publishedTs - b._publishedTs);
      keep = withPublishedAt[0];
    }

    const deleteCandidates = playlistsWithSame.filter((p) => p.playlistId !== keep.playlistId);

    if (deleteCandidates.length > 0) {
      duplicates.push({
        title: playlistsWithSame[0].title,
        signature: playlistsWithSame[0].signature,
        keep: {
          playlistId: keep.playlistId,
          title: keep.title,
          publishedAt: keep.publishedAt,
          itemCount: keep.itemCount,
          signature: keep.signature,
        },
        delete: deleteCandidates.map((p) => ({
          playlistId: p.playlistId,
          title: p.title,
          publishedAt: p.publishedAt,
          itemCount: p.itemCount,
          signature: p.signature,
        })),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      totalPlaylists: playlists.length,
      scannedPlaylists: validPlaylists.length,
      duplicateGroups: duplicates.length,
      toDelete: duplicates.reduce((sum, g) => sum + g.delete.length, 0),
    },
    duplicates,
    errors: {
      itemFetchFailures: itemErrors,
    },
  };
}
