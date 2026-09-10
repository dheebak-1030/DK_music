// ============================================================
// DK MUSIC — SUPABASE CLOUD STORAGE ENGINE
// Handles audio + artwork uploads, song metadata persistence,
// and playlist sync via the existing Supabase connection.
// Uses the SINGLETON supabaseClient — never creates a new one.
// ============================================================

(function (global) {
  'use strict';

  const AUDIO_BUCKET = 'dk-music-audio';
  const COVERS_BUCKET = 'dk-music-covers';

  // ── Helpers ─────────────────────────────────────────────────

  function getClient() {
    return global.supabaseClient || global.__supabaseClientInstance || null;
  }

  /** Sanitise a filename for safe storage paths */
  function safeFileName(name) {
    return name
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 120);
  }

  // ── Upload Progress Helper ───────────────────────────────────

  /**
   * Upload a file to a Supabase Storage bucket.
   * Returns the public URL on success, throws on failure.
   */
  async function uploadFileToStorage(bucket, filePath, file, onProgress) {
    const client = getClient();
    if (!client) throw new Error('Supabase client not available');

    if (typeof onProgress === 'function') onProgress(0, 'Starting upload...');

    const { data, error } = await client.storage
      .from(bucket)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || 'application/octet-stream'
      });

    if (error) throw error;

    if (typeof onProgress === 'function') onProgress(100, 'Upload complete');

    const { data: urlData } = client.storage.from(bucket).getPublicUrl(filePath);
    return urlData && urlData.publicUrl ? urlData.publicUrl : null;
  }

  // ── Audio Upload ─────────────────────────────────────────────

  /**
   * Upload an audio file (MP3/WAV/FLAC/AAC) to Supabase Storage.
   * @param {File} file - The audio File object
   * @param {string} songId - Unique song ID (used in path)
   * @param {function} onProgress - (percent, message) callback
   * @returns {string} Public URL of uploaded audio
   */
  async function uploadAudioFile(file, songId, onProgress) {
    const ext = file.name.split('.').pop().toLowerCase() || 'mp3';
    const safeName = safeFileName(file.name.replace(/\.[^/.]+$/, ''));
    const filePath = 'songs/' + songId + '_' + safeName + '.' + ext;
    return uploadFileToStorage(AUDIO_BUCKET, filePath, file, onProgress);
  }

  // ── Cover Art Upload ─────────────────────────────────────────

  /**
   * Upload album/song artwork to Supabase Storage.
   * @param {File} file - The image File object
   * @param {string} songId - Unique song ID
   * @param {function} onProgress - (percent, message) callback
   * @returns {string} Public URL of uploaded image
   */
  async function uploadCoverImage(file, songId, onProgress) {
    const ext = file.name.split('.').pop().toLowerCase() || 'jpg';
    const filePath = 'covers/' + songId + '_cover.' + ext;
    return uploadFileToStorage(COVERS_BUCKET, filePath, file, onProgress);
  }

  // ── Delete from Storage ───────────────────────────────────────

  /**
   * Delete a file from Supabase Storage using its public URL.
   */
  async function deleteFromStorage(fileUrl, bucket) {
    if (!fileUrl) return;
    const client = getClient();
    if (!client) return;

    try {
      // Extract path from public URL:
      // https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>
      var urlObj = new URL(fileUrl);
      var marker = '/object/public/' + bucket + '/';
      var pathSegments = urlObj.pathname.split(marker);
      if (pathSegments.length < 2) return;
      var storagePath = decodeURIComponent(pathSegments[1]);

      var result = await client.storage.from(bucket).remove([storagePath]);
      if (result.error) console.warn('[CloudStorage] Delete warning:', result.error.message);
      else console.log('[CloudStorage] Deleted: ' + storagePath);
    } catch (e) {
      console.warn('[CloudStorage] Error deleting file:', e);
    }
  }

  // ── Song Metadata in Supabase DB ─────────────────────────────

  /**
   * Upsert a song record to the Supabase `songs` table.
   */
  async function upsertSongToDB(songData) {
    const client = getClient();
    if (!client) return null;

    const record = {
      id: songData.id,
      title: songData.title,
      artist: songData.artist,
      album: songData.album || 'Single',
      cover_url: songData.cover_url || null,
      file_url: songData.file_url || songData.audio_url || null,
      downloadable: songData.downloadable !== false,
      is_cloud: true,
      uploaded_by: songData.uploaded_by || 'admin'
    };

    const { data, error } = await client.from('songs').upsert([record], {
      onConflict: 'id'
    });

    if (error) {
      console.warn('[CloudStorage] DB upsert error:', error.message);
      return null;
    }
    return (data && data[0]) ? data[0] : record;
  }

  /**
   * Delete a song from the Supabase `songs` table.
   */
  async function deleteSongFromDB(songId) {
    const client = getClient();
    if (!client) return;

    const { error } = await client.from('songs').delete().eq('id', songId);
    if (error) console.warn('[CloudStorage] DB delete error:', error.message);
  }

  // ── Playlist Sync ────────────────────────────────────────────

  /**
   * Fetch all playlists from Supabase `playlists` table.
   */
  async function fetchCloudPlaylists() {
    const client = getClient();
    if (!client) return [];

    try {
      const { data, error } = await client
        .from('playlists')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('[CloudStorage] Fetch playlists error:', error.message);
        return [];
      }
      return data || [];
    } catch (e) {
      console.warn('[CloudStorage] fetchCloudPlaylists exception:', e);
      return [];
    }
  }

  /**
   * Upsert a playlist record to Supabase `playlists` table.
   */
  async function upsertPlaylistToDB(playlist) {
    const client = getClient();
    if (!client) return null;

    const record = {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description || '',
      cover: playlist.cover || null,
      songs: Array.isArray(playlist.songs) ? playlist.songs : [],
      created_by: playlist.createdBy || 'admin'
    };

    const { data, error } = await client.from('playlists').upsert([record], {
      onConflict: 'id'
    });

    if (error) {
      console.warn('[CloudStorage] Playlist upsert error:', error.message);
      return null;
    }
    return (data && data[0]) ? data[0] : record;
  }

  /**
   * Delete a playlist from Supabase `playlists` table.
   */
  async function deletePlaylistFromDB(playlistId) {
    const client = getClient();
    if (!client) return;

    const { error } = await client.from('playlists').delete().eq('id', playlistId);
    if (error) console.warn('[CloudStorage] Playlist delete error:', error.message);
  }

  // ── Connection Status ────────────────────────────────────────

  /**
   * Check Supabase Storage + DB connectivity.
   * Returns status object with boolean fields.
   */
  async function checkStorageStatus() {
    const client = getClient();
    var status = {
      clientReady: !!client,
      storageConnected: false,
      dbConnected: false,
      bucketsAvailable: []
    };

    if (!client) return status;

    try {
      const { data: buckets, error } = await client.storage.listBuckets();
      if (!error && buckets) {
        status.storageConnected = true;
        status.bucketsAvailable = buckets.map(function(b) { return b.name; });
      }
    } catch (e) {
      // storage may still work even if listBuckets fails due to RLS
    }

    try {
      const { error: dbErr } = await client.from('songs').select('id').limit(1);
      if (!dbErr) status.dbConnected = true;
    } catch (e) { }

    return status;
  }

  // ── Export ───────────────────────────────────────────────────

  global.DK_CloudStorage = {
    uploadAudioFile,
    uploadCoverImage,
    deleteFromStorage,
    upsertSongToDB,
    deleteSongFromDB,
    fetchCloudPlaylists,
    upsertPlaylistToDB,
    deletePlaylistFromDB,
    checkStorageStatus,
    AUDIO_BUCKET,
    COVERS_BUCKET
  };

  console.log('[DK CloudStorage] Cloud Storage Engine initialized.');

})(typeof window !== 'undefined' ? window : globalThis);
