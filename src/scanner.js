import { createHash } from 'node:crypto';

const MAX_RESULTS = 50;

function makeSignature(title, orderedIds) {
  const body = `${title}|${orderedIds.join(',')}`;
  return createHash('sha1').update(body).digest('hex');
}

function extractResourceKey(item) {
  const rid = item.snippet?.resourceId || item.contentDetails || {};
  if (rid.videoId) return `video:${rid.videoId}`;
  if (rid.playlistId) return `playlist:${rid.playlistId}`;
  if (rid.channelId) return `channel:${rid.channelId}`;
  return item.id || '';
}

export async function listAllPlaylists(youtube, opts = {}) {
  const playlists = [];
  const titleFilter = opts.titleFilter;
  let pageToken;

  do {
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
  } while (pageToken);

  return playlists;
}

export async function listPlaylistResourceIds(youtube, playlistId) {
  const ids = [];
  let pageToken;

  do {
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
  } while (pageToken);

  return ids;
}

export async function scanDuplicateGroups(youtube, options = {}) {
  const playlists = await listAllPlaylists(youtube, { titleFilter: options.title });
  const validPlaylists = [];
  const itemErrors = [];

  for (const playlist of playlists) {
    try {
      const orderedResourceIds = await listPlaylistResourceIds(youtube, playlist.playlistId);
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
  }

  const groups = new Map();
  for (const item of validPlaylists) {
    const key = `${item.title}\n${item.itemCount}\n${item.signature}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const duplicates = [];
  for (const [_, playlistsWithSame] of groups.entries()) {
    if (playlistsWithSame.length <= 1) continue;

    const keepMode = options.keep || 'oldest';
    const withPublishedAt = playlistsWithSame
      .map((item) => ({ ...item, _publishedTs: Date.parse(item.publishedAt || '') }))
      .filter((item) => Number.isFinite(item._publishedTs));

    let keep;
    if (withPublishedAt.length === 0) {
      const orderedByScan = [...playlistsWithSame].sort((a, b) => a.sequence - b.sequence);
      keep = orderedByScan[0];
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
