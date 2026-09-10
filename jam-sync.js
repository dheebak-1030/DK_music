// ============================================================
// DK MUSIC — 3D LIVE JAM & DUAL DEVICE SYNC ENGINE
// Works Both ONLINE (Supabase Realtime Broadcast) & OFFLINE (BroadcastChannel & Local Storage P2P)
// ============================================================

(function () {
  'use strict';

  // State
  // State
  let currentRoomCode = null;
  let isHost = false;
  let isConnected = false;
  let isSyncing = true;
  let myDeviceId = (function () {
    try {
      let id = sessionStorage.getItem('dk_jam_device_id');
      if (!id) {
        id = 'dev_' + Math.random().toString(36).substring(2, 9);
        sessionStorage.setItem('dk_jam_device_id', id);
      }
      return id;
    } catch (e) {
      return 'dev_' + Math.random().toString(36).substring(2, 9);
    }
  })();
  const isMobileDev = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
  const myDeviceLabel = isMobileDev ? 'Mobile' : 'Desktop';

  let onlineChannel = null;
  let offlineChannel = null;
  let isReceivingRemoteAction = false;
  let lastSeekSent = 0;
  let peerCount = 0;
  const connectedDevices = new Map();

  // DOM Elements
  let jamModal = null;
  let btnOpenJamModal = null;
  let btnHeroHostRoom = null;
  let btnHeroJoinRoom = null;
  let btnMpsJam = null;
  let btnCloseJamModal = null;
  let tabHost = null;
  let tabJoin = null;
  let viewHost = null;
  let viewJoin = null;
  let viewActive = null;
  let displayRoomCode = null;
  let inputJoinCode = null;
  let btnConnectRoom = null;
  let btnCopyCode = null;
  let btnCopyLink = null;
  let btnDisconnectJam = null;
  let jamSyncToggle = null;
  let jamActiveSongTitle = null;
  let jamActiveSongArtist = null;
  let jamActiveCover = null;
  let btnJamDownloadOffline = null;
  let topbarJamBadge = null;
  let topbarRoomCode = null;
  let jamNetBadge = null;
  let jamStatusPill = null;
  let jamPeerStatusText = null;

  // Sound / Haptic
  function triggerHaptic(type = 'light') {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        if (type === 'light') navigator.vibrate(12);
        else if (type === 'medium') navigator.vibrate(25);
        else if (type === 'success') navigator.vibrate([15, 30, 20]);
      } catch (e) {}
    }
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
    } else {
      const t = document.getElementById('toast');
      if (t) {
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2800);
      }
    }
  }

  // Generate 6-digit room code: e.g. DK-7492
  function generateRoomCode() {
    const num = Math.floor(1000 + Math.random() * 9000);
    return `DK-${num}`;
  }

  // ── Network Detection (Online vs Offline) ───────────────────
  function isNetworkOnline() {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  }

  function updateNetworkStatusBadges() {
    const online = isNetworkOnline();
    if (jamNetBadge) {
      jamNetBadge.innerHTML = online
        ? `<i class="fas fa-wifi" style="color:#22c55e;"></i> Online Realtime Mode`
        : `<i class="fas fa-satellite-dish" style="color:#f59e0b;"></i> Offline Local Sync Mode`;
    }
    if (jamStatusPill) {
      if (isConnected) {
        jamStatusPill.className = `jam-status-indicator ${online ? 'online' : 'offline'}`;
        jamStatusPill.innerHTML = online
          ? `<span class="pulse-dot green"></span> Live Synced (Online Broadcast)`
          : `<span class="pulse-dot orange"></span> Live Synced (Offline Local P2P)`;
      } else {
        jamStatusPill.className = 'jam-status-indicator standby';
        jamStatusPill.innerHTML = `<span class="pulse-dot"></span> Ready to Connect`;
      }
    }
  }

  window.addEventListener('online', () => {
    updateNetworkStatusBadges();
    if (currentRoomCode) {
      toast('Switched to Global Online Realtime sync');
      setupChannels(currentRoomCode);
    }
  });

  window.addEventListener('offline', () => {
    updateNetworkStatusBadges();
    if (currentRoomCode) {
      toast('Offline mode: Syncing locally between devices/tabs');
    }
  });

  // ── Render Participant Devices in UI ────────────────────────
  function renderDevicesList() {
    const container = document.getElementById('jamDevicesList');
    const countPill = document.getElementById('jamDeviceCountPill');
    if (countPill) countPill.textContent = `${peerCount} Active`;
    if (!container) return;

    const list = Array.from(connectedDevices.values());
    container.innerHTML = list.map(d => {
      const isMe = d.deviceId === myDeviceId;
      const shortId = (d.deviceId || 'DEV').replace('dev_', '').toUpperCase();
      const label = d.label || (isMe ? 'This Device' : 'Guest Device');
      return `
      <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(255,255,255,0.04); padding:6px 10px; border-radius:6px; font-size:0.82rem; margin-bottom:4px;">
          <div style="display:flex; align-items:center; gap:8px;">
              <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e; box-shadow:0 0 6px #22c55e;"></span>
              <span style="font-weight:600; color:#fff;">${escHtml(label)} (${escHtml(shortId)})</span>
              ${isMe ? '<span style="font-size:0.7rem; background:rgba(168,85,247,0.25); color:#c084fc; padding:1px 6px; border-radius:4px; font-weight:700;">You</span>' : ''}
          </div>
          <span style="font-size:0.72rem; color:${d.isHost ? '#45f3ff' : '#94a3b8'}; font-weight:700; background:rgba(255,255,255,0.06); padding:2px 8px; border-radius:4px;">
              ${d.isHost ? '👑 HOST' : 'MEMBER'}
          </span>
      </div>`;
    }).join('');
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }

  // ── Communication Channels Setup ────────────────────────────
  function setupChannels(code) {
    cleanupChannels();
    currentRoomCode = code;

    connectedDevices.clear();
    connectedDevices.set(myDeviceId, {
      deviceId: myDeviceId,
      label: myDeviceLabel,
      isHost: isHost,
      isSelf: true,
      onlineAt: Date.now()
    });
    peerCount = Math.max(1, connectedDevices.size);
    renderDevicesList();
    updatePeerCountUI();

    // 1. Offline Channel (BroadcastChannel + LocalStorage fallback)
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        offlineChannel = new BroadcastChannel('dk_jam_' + code);
        offlineChannel.onmessage = (ev) => handleIncomingMessage(ev.data);
      }
    } catch (e) {
      console.warn('[JamSync] BroadcastChannel error:', e);
    }

    // 2. Online Channel (Supabase Realtime Broadcast & Presence)
    const sb = window.supabaseClient || window._supabaseClient;
    if (sb && isNetworkOnline()) {
      try {
        onlineChannel = sb.channel('jam_' + code, {
          config: {
            broadcast: { self: false },
            presence: { key: myDeviceId }
          }
        });

        onlineChannel.on('broadcast', { event: 'jam_event' }, (payload) => {
          if (payload && payload.payload) {
            handleIncomingMessage(payload.payload);
          }
        });

        const syncPresenceState = () => {
          if (!onlineChannel) return;
          const state = onlineChannel.presenceState();
          connectedDevices.clear();
          for (const key in state) {
            (state[key] || []).forEach(p => {
              const devId = p.deviceId || key;
              connectedDevices.set(devId, {
                deviceId: devId,
                label: p.label || 'Device',
                isHost: !!p.isHost,
                isSelf: devId === myDeviceId,
                onlineAt: p.onlineAt || Date.now()
              });
            });
          }
          // Ensure self is preserved
          connectedDevices.set(myDeviceId, {
            deviceId: myDeviceId,
            label: myDeviceLabel,
            isHost: isHost,
            isSelf: true,
            onlineAt: Date.now()
          });
          peerCount = Math.max(1, connectedDevices.size);
          renderDevicesList();
          updatePeerCountUI();
        };

        onlineChannel.on('presence', { event: 'sync' }, syncPresenceState);
        onlineChannel.on('presence', { event: 'join' }, syncPresenceState);
        onlineChannel.on('presence', { event: 'leave' }, syncPresenceState);

        onlineChannel.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            console.log(`[JamSync] Subscribed to Supabase online channel for room: ${code}`);
            await onlineChannel.track({
              deviceId: myDeviceId,
              label: myDeviceLabel,
              isHost: isHost,
              onlineAt: Date.now()
            });
            // Announce presence to peers
            sendBroadcastMessage({
              type: 'PEER_JOINED',
              deviceId: myDeviceId,
              label: myDeviceLabel,
              isHost: isHost,
              timestamp: Date.now()
            });
          }
        });
      } catch (err) {
        console.warn('[JamSync] Supabase broadcast initialization error:', err);
      }
    }

    // Send local offline join signal
    sendBroadcastMessage({
      type: 'PEER_JOINED',
      deviceId: myDeviceId,
      label: myDeviceLabel,
      isHost: isHost,
      timestamp: Date.now()
    });
  }

  function cleanupChannels() {
    const sb = window.supabaseClient || window._supabaseClient;
    if (onlineChannel && sb) {
      try {
        onlineChannel.untrack();
        sb.removeChannel(onlineChannel);
      } catch (e) {}
      onlineChannel = null;
    }
    if (offlineChannel) {
      try {
        offlineChannel.close();
      } catch (e) {}
      offlineChannel = null;
    }
  }

  // Send message across both channels
  function sendBroadcastMessage(data) {
    if (!currentRoomCode || !isSyncing) return;
    data.roomCode = currentRoomCode;
    data.senderDeviceId = myDeviceId;
    data.sentAt = Date.now();

    // 1. Send via Offline BroadcastChannel
    if (offlineChannel) {
      try {
        offlineChannel.postMessage(data);
      } catch (e) {}
    }

    // 2. Send via LocalStorage fallback (multi-tab/local)
    try {
      localStorage.setItem('dk_jam_msg_' + currentRoomCode, JSON.stringify(data));
    } catch (e) {}

    // 3. Send via Online Supabase Realtime Broadcast
    if (onlineChannel && isNetworkOnline()) {
      try {
        onlineChannel.send({
          type: 'broadcast',
          event: 'jam_event',
          payload: data
        });
      } catch (e) {
        console.warn('[JamSync] Error sending online broadcast:', e);
      }
    }
  }

  // Listen to LocalStorage fallback for offline multi-window sync
  window.addEventListener('storage', (e) => {
    if (currentRoomCode && e.key === 'dk_jam_msg_' + currentRoomCode && e.newValue) {
      try {
        const msg = JSON.parse(e.newValue);
        handleIncomingMessage(msg);
      } catch (err) {}
    }
  });

  // ── Handle Incoming Sync Messages ───────────────────────────
  function handleIncomingMessage(data) {
    if (!data || data.senderDeviceId === myDeviceId) return;
    if (data.roomCode !== currentRoomCode) return;

    // Handle Peer Join
    if (data.type === 'PEER_JOINED') {
      if (data.deviceId) {
        connectedDevices.set(data.deviceId, {
          deviceId: data.deviceId,
          label: data.label || 'Device',
          isHost: !!data.isHost,
          isSelf: false,
          onlineAt: data.timestamp || Date.now()
        });
      }
      peerCount = Math.max(1, connectedDevices.size);
      isConnected = true;
      triggerHaptic('success');
      toast(`🎉 Device joined room ${currentRoomCode}! (${peerCount} connected)`);
      renderDevicesList();
      updateConnectedUI();

      // Send presence acknowledgment so the newcomer knows about us
      sendBroadcastMessage({
        type: 'PEER_PRESENCE',
        deviceId: myDeviceId,
        label: myDeviceLabel,
        isHost: isHost
      });

      // If we are Host, send full state sync to the newcomer
      const audio = document.getElementById('audioPlayer');
      if (isHost && audio) {
        const curSong = window.currentQueue ? window.currentQueue[window.currentSongIndex] : null;
        if (curSong) {
          sendBroadcastMessage({
            type: 'STATE_SYNC',
            song: curSong,
            songIndex: window.currentSongIndex,
            currentTime: audio.currentTime,
            isPlaying: !audio.paused,
            queue: (window.currentQueue || []).slice(0, 50)
          });
        }
      }
      return;
    }

    // Handle Peer Presence Response
    if (data.type === 'PEER_PRESENCE') {
      if (data.deviceId) {
        connectedDevices.set(data.deviceId, {
          deviceId: data.deviceId,
          label: data.label || 'Device',
          isHost: !!data.isHost,
          isSelf: false,
          onlineAt: Date.now()
        });
        peerCount = Math.max(1, connectedDevices.size);
        renderDevicesList();
        updatePeerCountUI();
      }
      return;
    }

    // Handle State Sync from Host
    if (data.type === 'STATE_SYNC') {
      if (!isSyncing) return;
      isReceivingRemoteAction = true;
      try {
        if (Array.isArray(data.queue) && data.queue.length > 0 && (!window.currentQueue || window.currentQueue.length === 0)) {
          window.currentQueue = data.queue;
        }
        if (data.song) {
          syncPlayTrack(data.song, data.songIndex ?? 0, data.currentTime ?? 0, !!data.isPlaying, data.sentAt);
        }
      } finally {
        setTimeout(() => {
          isReceivingRemoteAction = false;
        }, 500);
      }
      return;
    }

    // Handle Peer Leave
    if (data.type === 'PEER_LEFT') {
      if (data.deviceId) {
        connectedDevices.delete(data.deviceId);
      }
      peerCount = Math.max(1, connectedDevices.size);
      toast('A device left the room');
      renderDevicesList();
      updatePeerCountUI();
      return;
    }

    // Handle Playback Sync
    if (!isSyncing) return;
    const audio = document.getElementById('audioPlayer');
    if (!audio) return;

    isReceivingRemoteAction = true;

    try {
      if (data.type === 'PLAY_TRACK') {
        toast(`▶️ Jam Room playing: "${data.song?.title || 'Song'}"`);
        syncPlayTrack(data.song, data.songIndex, data.currentTime, data.isPlaying, data.sentAt);
      } else if (data.type === 'PAUSE') {
        audio.pause();
        toast('⏸️ Playback paused');
      } else if (data.type === 'RESUME') {
        const latency = Math.max(0, (Date.now() - (data.sentAt || Date.now())) / 1000);
        const expectedTime = (data.currentTime || 0) + latency;
        if (Math.abs(audio.currentTime - expectedTime) > 0.4) {
          audio.currentTime = expectedTime;
        }
        audio.play().catch(() => {});
        toast('▶️ Playback resumed');
      } else if (data.type === 'SEEK') {
        if (typeof data.currentTime === 'number') {
          const latency = data.isPlaying ? Math.max(0, (Date.now() - (data.sentAt || Date.now())) / 1000) : 0;
          audio.currentTime = Math.max(0, (data.currentTime || 0) + latency);
          toast(`⏩ Seeked to ${fmtTime(audio.currentTime)}`);
        }
      } else if (data.type === 'NEXT_TRACK') {
        if (typeof window.nextSong === 'function') window.nextSong();
      } else if (data.type === 'PREV_TRACK') {
        if (typeof window.prevSong === 'function') window.prevSong();
      }
    } finally {
      setTimeout(() => {
        isReceivingRemoteAction = false;
      }, 400);
    }
  }

  // Format seconds to mm:ss
  function fmtTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Synchronize playing a specific song with timestamp correction
  async function syncPlayTrack(song, songIdx, targetTime = 0, autoPlay = true, sentAt = Date.now()) {
    if (!song) return;

    const latency = autoPlay ? Math.max(0, (Date.now() - (sentAt || Date.now())) / 1000) : 0;
    const initialSeek = (targetTime || 0) + latency;

    // Check if song is in current window.songs
    let foundIdx = -1;
    if (window.songs && Array.isArray(window.songs)) {
      foundIdx = window.songs.findIndex(s => s.id === song.id || s.title === song.title);
    }

    if (foundIdx !== -1 && typeof window.playSong === 'function') {
      // Use existing playSong engine
      await window.playSong(foundIdx);
    } else {
      // Play directly through audioEl
      const audio = document.getElementById('audioPlayer');
      if (audio) {
        // Offline check: see if device has cached audio
        let playSrc = song.file_url;
        if (window.DK_OfflineDB) {
          try {
            const blobUrl = await window.DK_OfflineDB.getOfflineAudioUrl(song.id);
            if (blobUrl) playSrc = blobUrl;
          } catch (e) {}
        }
        audio.src = playSrc;
        audio.load();
      }
    }

    const audio = document.getElementById('audioPlayer');
    if (audio) {
      if (initialSeek > 0) audio.currentTime = initialSeek;
      if (autoPlay) audio.play().catch(() => {});
    }

    updateActiveSongView(song);
  }

  // ── Hook Into Local Audio Events to Broadcast ──────────────
  function attachLocalAudioBroadcastHooks() {
    const audio = document.getElementById('audioPlayer');
    if (!audio) return;

    audio.addEventListener('play', () => {
      if (isReceivingRemoteAction || !currentRoomCode || !isSyncing) return;
      const curSong = window.currentQueue ? window.currentQueue[window.currentSongIndex] : null;
      sendBroadcastMessage({
        type: 'RESUME',
        currentTime: audio.currentTime,
        isPlaying: true,
        song: curSong
      });
    });

    audio.addEventListener('pause', () => {
      if (isReceivingRemoteAction || !currentRoomCode || !isSyncing) return;
      sendBroadcastMessage({
        type: 'PAUSE',
        currentTime: audio.currentTime,
        isPlaying: false
      });
    });

    audio.addEventListener('seeked', () => {
      if (isReceivingRemoteAction || !currentRoomCode || !isSyncing) return;
      if (Date.now() - lastSeekSent < 250) return;
      lastSeekSent = Date.now();
      sendBroadcastMessage({
        type: 'SEEK',
        currentTime: audio.currentTime,
        isPlaying: !audio.paused
      });
    });

    // When song changes locally
    const origPlaySong = window.playSong;
    if (typeof origPlaySong === 'function' && !window._jamHooked) {
      window._jamHooked = true;
      window.playSong = async function (idx) {
        const res = await origPlaySong.apply(this, arguments);
        if (!isReceivingRemoteAction && currentRoomCode && isSyncing) {
          const song = window.currentQueue ? window.currentQueue[idx] : null;
          if (song) {
            sendBroadcastMessage({
              type: 'PLAY_TRACK',
              song: song,
              songIndex: idx,
              currentTime: 0,
              isPlaying: true
            });
            updateActiveSongView(song);
          }
        }
        return res;
      };
    }

    // Hook Next & Prev controls
    document.getElementById('btnNext')?.addEventListener('click', () => {
      if (!isReceivingRemoteAction && currentRoomCode && isSyncing) {
        sendBroadcastMessage({ type: 'NEXT_TRACK' });
      }
    });
    document.getElementById('btnPrev')?.addEventListener('click', () => {
      if (!isReceivingRemoteAction && currentRoomCode && isSyncing) {
        sendBroadcastMessage({ type: 'PREV_TRACK' });
      }
    });
  }

  // ── UI Controller & Modal Setup ─────────────────────────────
  function initUI() {
    jamModal = document.getElementById('jamModal');
    btnOpenJamModal = document.getElementById('btnOpenJamModal');
    btnHeroHostRoom = document.getElementById('btnHeroHostRoom');
    btnHeroJoinRoom = document.getElementById('btnHeroJoinRoom');
    btnMpsJam = document.getElementById('btnMpsJam');
    btnCloseJamModal = document.getElementById('btnCloseJamModal');

    tabHost = document.getElementById('tabJamHost');
    tabJoin = document.getElementById('tabJamJoin');
    viewHost = document.getElementById('jamHostView');
    viewJoin = document.getElementById('jamJoinView');
    viewActive = document.getElementById('jamActiveSessionView');

    displayRoomCode = document.getElementById('displayJamRoomCode');
    inputJoinCode = document.getElementById('inputJoinJamCode');
    btnConnectRoom = document.getElementById('btnConnectJamRoom');
    btnCopyCode = document.getElementById('btnCopyJamCode');
    btnCopyLink = document.getElementById('btnCopyJamLink');
    btnDisconnectJam = document.getElementById('btnDisconnectJam');
    jamSyncToggle = document.getElementById('jamSyncToggle');

    jamActiveSongTitle = document.getElementById('jamActiveSongTitle');
    jamActiveSongArtist = document.getElementById('jamActiveSongArtist');
    jamActiveCover = document.getElementById('jamActiveCover');
    btnJamDownloadOffline = document.getElementById('btnJamDownloadOffline');

    topbarJamBadge = document.getElementById('topbarJamBadge');
    topbarRoomCode = document.getElementById('topbarRoomCode');
    jamNetBadge = document.getElementById('jamNetBadge');
    jamStatusPill = document.getElementById('jamStatusPill');
    jamPeerStatusText = document.getElementById('jamPeerStatusText');

    // Open Modal
    function openModal(defaultTab = 'host') {
      triggerHaptic('light');
      if (jamModal) jamModal.classList.remove('hidden');
      updateNetworkStatusBadges();
      if (!currentRoomCode) {
        if (defaultTab === 'join') switchTab('join');
        else switchTab('host');
      }
    }

    btnOpenJamModal?.addEventListener('click', () => {
      openModal('host');
      if (!currentRoomCode) startHostSession();
    });
    btnHeroHostRoom?.addEventListener('click', () => {
      openModal('host');
      if (!currentRoomCode) startHostSession();
    });
    btnHeroJoinRoom?.addEventListener('click', () => openModal('join'));
    btnMpsJam?.addEventListener('click', () => openModal('host'));

    // Close Modal
    btnCloseJamModal?.addEventListener('click', () => {
      triggerHaptic('light');
      jamModal?.classList.add('hidden');
    });

    jamModal?.addEventListener('click', (e) => {
      if (e.target === jamModal) jamModal.classList.add('hidden');
    });

    // Tab Switching
    tabHost?.addEventListener('click', () => switchTab('host'));
    tabJoin?.addEventListener('click', () => switchTab('join'));

    // Host: Start Room
    document.getElementById('btnRegenerateCode')?.addEventListener('click', () => {
      startHostSession();
    });

    // Join: Connect Button
    btnConnectRoom?.addEventListener('click', () => {
      const code = (inputJoinCode?.value || '').trim().toUpperCase();
      if (!code) {
        toast('Please enter a room code');
        return;
      }
      joinRoom(code);
    });

    inputJoinCode?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnConnectRoom?.click();
    });

    // Copy Code & Link
    btnCopyCode?.addEventListener('click', () => {
      if (!currentRoomCode) return;
      navigator.clipboard?.writeText(currentRoomCode);
      triggerHaptic('light');
      toast(`Copied code: ${currentRoomCode}`);
      btnCopyCode.innerHTML = `<i class="fas fa-check" style="color:#22c55e;"></i> Copied!`;
      setTimeout(() => {
        btnCopyCode.innerHTML = `<i class="far fa-copy"></i> Copy Code`;
      }, 2000);
    });

    btnCopyLink?.addEventListener('click', () => {
      if (!currentRoomCode) return;
      const url = `${window.location.origin}${window.location.pathname}?jam=${currentRoomCode}`;
      navigator.clipboard?.writeText(url);
      triggerHaptic('light');
      toast('Copied direct invite link!');
      btnCopyLink.innerHTML = `<i class="fas fa-check" style="color:#22c55e;"></i> Copied!`;
      setTimeout(() => {
        btnCopyLink.innerHTML = `<i class="fas fa-link"></i> Copy Invite Link`;
      }, 2000);
    });

    // Disconnect
    btnDisconnectJam?.addEventListener('click', () => {
      disconnectSession();
    });

    // Sync Toggle
    jamSyncToggle?.addEventListener('change', (e) => {
      isSyncing = e.target.checked;
      toast(isSyncing ? 'Real-time sync enabled' : 'Sync paused on this device');
    });

    // Download song offline from Jam modal
    btnJamDownloadOffline?.addEventListener('click', () => {
      const song = window.currentQueue ? window.currentQueue[window.currentSongIndex] : null;
      if (song && typeof window.toggleOfflineDownload === 'function') {
        window.toggleOfflineDownload(song);
        btnJamDownloadOffline.innerHTML = `<i class="fas fa-check" style="color:#22c55e;"></i> Saved Offline`;
      }
    });

    // Auto-join from URL parameter (e.g. ?jam=DK-8492)
    const params = new URLSearchParams(window.location.search);
    const urlJamCode = params.get('jam');
    if (urlJamCode) {
      setTimeout(() => {
        joinRoom(urlJamCode.toUpperCase());
        openModal('join');
      }, 500);
    }

    attachLocalAudioBroadcastHooks();
    updateNetworkStatusBadges();

    window.addEventListener('beforeunload', () => {
      if (currentRoomCode) {
        sendBroadcastMessage({ type: 'PEER_LEFT', deviceId: myDeviceId });
        cleanupChannels();
      }
    });
  }

  function switchTab(tab) {
    triggerHaptic('light');
    if (tab === 'host') {
      tabHost?.classList.add('active');
      tabJoin?.classList.remove('active');
      if (viewHost) viewHost.style.display = 'block';
      if (viewJoin) viewJoin.style.display = 'none';
      if (!currentRoomCode) startHostSession();
    } else {
      tabJoin?.classList.add('active');
      tabHost?.classList.remove('active');
      if (viewJoin) viewJoin.style.display = 'block';
      if (viewHost) viewHost.style.display = 'none';
      inputJoinCode?.focus();
    }
  }

  function startHostSession() {
    isHost = true;
    const code = generateRoomCode();
    currentRoomCode = code;
    setupChannels(code);

    if (displayRoomCode) {
      displayRoomCode.textContent = code;
    }

    isConnected = true;
    peerCount = 1;
    updateConnectedUI();
    toast(`Jam Room ${code} created! Share with your friends.`);
  }

  function joinRoom(code) {
    isHost = false;
    currentRoomCode = code;
    setupChannels(code);

    isConnected = true;
    peerCount = Math.max(1, connectedDevices.size);
    updateConnectedUI();
    toast(`Connected to Room ${code}!`);
  }

  function disconnectSession() {
    triggerHaptic('medium');
    sendBroadcastMessage({ type: 'PEER_LEFT', deviceId: myDeviceId });
    cleanupChannels();
    currentRoomCode = null;
    isConnected = false;
    peerCount = 0;
    connectedDevices.clear();

    if (viewActive) viewActive.style.display = 'none';
    if (topbarJamBadge) topbarJamBadge.classList.add('hidden');
    switchTab('host');
    updateNetworkStatusBadges();
    toast('Disconnected from Jam session');
  }

  function updateConnectedUI() {
    if (!currentRoomCode) return;

    if (topbarJamBadge) {
      topbarJamBadge.classList.remove('hidden');
      if (topbarRoomCode) topbarRoomCode.textContent = currentRoomCode;
    }

    if (viewActive) {
      viewActive.style.display = 'block';
    }

    const curSong = window.currentQueue ? window.currentQueue[window.currentSongIndex] : null;
    if (curSong) updateActiveSongView(curSong);

    updatePeerCountUI();
    updateNetworkStatusBadges();
  }

  function updatePeerCountUI() {
    if (jamPeerStatusText) {
      jamPeerStatusText.innerHTML = peerCount > 1
        ? `<i class="fas fa-users" style="color:#22c55e;"></i> ${peerCount} Devices Synced in Jam`
        : `<i class="fas fa-satellite-dish" style="color:#a855f7;"></i> Room Code Ready &bull; Waiting for friends...`;
    }
  }

  function updateActiveSongView(song) {
    if (!song) return;
    if (jamActiveSongTitle) jamActiveSongTitle.textContent = song.title || 'Unknown Title';
    if (jamActiveSongArtist) jamActiveSongArtist.textContent = song.artist || 'Unknown Artist';
    if (jamActiveCover) {
      if (song.cover_url) {
        jamActiveCover.src = song.cover_url;
        jamActiveCover.style.display = 'block';
      } else {
        jamActiveCover.style.display = 'none';
      }
    }

    // Check offline status
    if (btnJamDownloadOffline && window.DK_OfflineDB) {
      window.DK_OfflineDB.isTrackAvailableOffline(song.id).then(isOffline => {
        if (isOffline) {
          btnJamDownloadOffline.innerHTML = `<i class="fas fa-circle-check" style="color:#22c55e;"></i> Offline Ready`;
        } else {
          btnJamDownloadOffline.innerHTML = `<i class="fas fa-cloud-arrow-down"></i> Save Offline`;
        }
      });
    }
  }

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  // Expose to window
  window.DK_JamSync = {
    startHostSession,
    joinRoom,
    disconnectSession,
    getRoomCode: () => currentRoomCode,
    isConnected: () => isConnected,
    getPeerCount: () => peerCount,
    getDevices: () => Array.from(connectedDevices.values())
  };

})();
