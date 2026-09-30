/**
 * DK Music — Location Agreement Manager (MANDATORY)
 *
 * Rules:
 * 1. After authentication → Location Agreement screen (mandatory).
 * 2. User must check the box and click "Allow Location & Continue".
 * 3. Browser Geolocation API is called → latitude, longitude, accuracy saved.
 * 4. On success → save to Supabase user_locations + localStorage → enter app.
 * 5. On Deny/Error → show error + Retry button. App stays BLOCKED until location is granted.
 *    There is NO "Continue Anyway" — location is mandatory for all users.
 */

(function (global) {
  'use strict';

  let activeUser = null;
  let gateCallback = null;

  async function getGateSupabase() {
    if (global.supabaseClient) return global.supabaseClient;
    if (global._supabaseClient) return global._supabaseClient;
    if (global.__supabaseClientInstance) return global.__supabaseClientInstance;
    if (typeof global.getSupabaseClient === 'function') {
      const c = await global.getSupabaseClient();
      if (c) return c;
    }
    if (global.supabase && typeof global.supabase.createClient === 'function') {
      const url = global.SUPABASE_URL || 'https://brufxavwnnzcpchtfiqg.supabase.co';
      const key = global.SUPABASE_ANON_KEY || 'sb_publishable_qq1F4EnE3h6f9o_V5WxpTw_RJAZrsJb';
      const c = global.supabase.createClient(url, key);
      global.supabaseClient = c;
      return c;
    }
    return null;
  }

  /**
   * Save user location to Supabase user_locations + profiles + localStorage.
   * Saves the agreed flag under BOTH auth UUID and userId (mobile/email) to
   * prevent key-mismatch on subsequent logins.
   */
  async function saveLocation(userId, coords) {
    const timestamp = new Date().toISOString();
    let authUid = userId;
    let userEmail = '';
    let userPhone = '';
    let userName = '';

    const sb = await getGateSupabase();

    // Resolve the real Supabase Auth UUID and profile info
    try {
      if (sb && sb.auth) {
        const { data: { user } } = await sb.auth.getUser();
        if (user && user.id) {
          authUid = user.id;
          userEmail = user.email || '';
          userPhone = user.phone || '';
          userName = user.user_metadata?.display_name ||
            user.user_metadata?.name ||
            user.email?.split('@')[0] ||
            user.phone || '';
        }
      }
    } catch (_) { }

    const locRecord = {
      user_id: String(authUid || userId),
      username: userName || userPhone || userEmail || String(userId),
      email: userEmail,
      phone: userPhone,
      latitude: Number(coords.latitude),
      longitude: Number(coords.longitude),
      accuracy: coords.accuracy != null ? Number(coords.accuracy) : null,
      timestamp: timestamp,
      updated_at: timestamp
    };

    // 1. Save to Supabase
    try {
      if (sb) {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(authUid));
        
        // Update profiles by UUID if available
        if (isUuid) {
          try {
            await sb.from('profiles').update({
              latitude: locRecord.latitude,
              longitude: locRecord.longitude,
              location_updated_at: locRecord.timestamp
            }).eq('id', authUid);
          } catch (_) { }
        }

        // Update profiles by user_id
        if (userId) {
          try {
            await sb.from('profiles').update({
              latitude: locRecord.latitude,
              longitude: locRecord.longitude,
              location_updated_at: locRecord.timestamp
            }).eq('user_id', String(userId));
          } catch (_) { }
        }

        // Update profiles by email
        if (userEmail) {
          try {
            await sb.from('profiles').update({
              latitude: locRecord.latitude,
              longitude: locRecord.longitude,
              location_updated_at: locRecord.timestamp
            }).eq('email', userEmail);
          } catch (_) { }
        }

        // Upsert into user_locations table
        try {
          const locRow = {
            user_id: locRecord.user_id,
            username: locRecord.username,
            email: locRecord.email,
            latitude: locRecord.latitude,
            longitude: locRecord.longitude,
            accuracy: locRecord.accuracy,
            updated_at: locRecord.updated_at
          };
          const { error } = await sb
            .from('user_locations')
            .upsert([locRow], { onConflict: 'user_id' });
          if (error) {
            console.warn('[LocationGate] Upsert error, trying insert:', error.message);
            await sb.from('user_locations').insert([locRow]);
          } else {
            console.log('[LocationGate] Location saved to Supabase for user:', authUid);
          }
        } catch (e) {
          console.warn('[LocationGate] user_locations save error:', e.message);
        }
      }
    } catch (e) {
      console.warn('[LocationGate] Supabase save notice:', e);
    }

    // 2. Save to localStorage — flag stored under BOTH UUID and userId
    try {
      localStorage.setItem('dk_user_location', JSON.stringify(locRecord));
      if (authUid) localStorage.setItem('dk_location_agreed_' + authUid, 'true');
      if (userId && userId !== authUid) localStorage.setItem('dk_location_agreed_' + userId, 'true');

      const allLocs = JSON.parse(localStorage.getItem('dk_admin_user_locations') || '[]');
      const idx = allLocs.findIndex(l =>
        (l.user_id || l.userId) === String(authUid) ||
        (l.user_id || l.userId) === String(userId)
      );
      if (idx !== -1) {
        allLocs[idx] = locRecord;
      } else {
        allLocs.push(locRecord);
      }
      localStorage.setItem('dk_admin_user_locations', JSON.stringify(allLocs));
    } catch (_) { }

    return locRecord;
  }

  /**
   * Request browser Geolocation API
   */
  /**
   * Request browser Geolocation API with high accuracy GPS precision.
   * Uses watchPosition to give the device GPS antenna time to acquire satellites
   * and narrow accuracy (e.g. ±5m-25m) instead of returning an inaccurate initial cell-tower fix.
   */
  function requestBrowserLocation(maxWaitMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation is not supported by your browser.'));
        return;
      }

      let bestPos = null;
      let watchId = null;
      let timer = null;
      let isResolved = false;

      const finish = () => {
        if (isResolved) return;
        isResolved = true;

        if (watchId !== null) {
          try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
          watchId = null;
        }
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }

        if (bestPos && bestPos.coords) {
          resolve({
            latitude: Number(bestPos.coords.latitude),
            longitude: Number(bestPos.coords.longitude),
            accuracy: bestPos.coords.accuracy ? Math.round(bestPos.coords.accuracy) : null,
            timestamp: new Date().toISOString()
          });
        } else {
          // Fallback to single-shot getCurrentPosition with high accuracy
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              resolve({
                latitude: Number(pos.coords.latitude),
                longitude: Number(pos.coords.longitude),
                accuracy: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
                timestamp: new Date().toISOString()
              });
            },
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
          );
        }
      };

      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (!pos || !pos.coords) return;
            const acc = pos.coords.accuracy || 999999;
            console.log(`[LocationGate] GPS Fix received: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)} (±${Math.round(acc)}m)`);

            if (!bestPos || acc < (bestPos.coords.accuracy || 999999)) {
              bestPos = pos;
            }

            // If we have achieved tight satellite accuracy (<= 35m), finish immediately!
            if (acc <= 35) {
              finish();
            }
          },
          (err) => {
            console.warn('[LocationGate] watchPosition warning:', err.message);
            if (!bestPos) finish();
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs }
        );
      } catch (_) {
        finish();
      }

      timer = setTimeout(finish, maxWaitMs);
    });
  }

  let trackingWatchId = null;
  let trackingIntervalId = null;
  let lastRecordedTime = 0;
  let lastRecordedCoords = null;

  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function handlePositionUpdate(pos, user) {
    if (!pos || !pos.coords || !user) return;
    const now = Date.now();
    const coords = {
      latitude: Number(pos.coords.latitude),
      longitude: Number(pos.coords.longitude),
      accuracy: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
      timestamp: new Date().toISOString()
    };

    let shouldUpdate = false;
    if (!lastRecordedCoords || !lastRecordedTime) {
      shouldUpdate = true;
    } else if (now - lastRecordedTime >= 120000) { // 2 minutes
      shouldUpdate = true;
    } else {
      const dist = calculateDistance(
        lastRecordedCoords.latitude,
        lastRecordedCoords.longitude,
        coords.latitude,
        coords.longitude
      );
      if (dist >= 50) { // moved 50+ meters
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      lastRecordedTime = now;
      lastRecordedCoords = coords;
      const userId = user.id || user.userId || 'anonymous';
      saveLocation(userId, coords).catch(err => {
        console.warn('[LocationGate] Continuous tracking save notice:', err.message);
      });
    }
  }

  /**
   * Start tracking user location with high accuracy while using the web application
   */
  function startContinuousTracking(user) {
    if (!user || !navigator.geolocation) return;
    const targetUser = user;

    if (trackingWatchId === null) {
      try {
        trackingWatchId = navigator.geolocation.watchPosition(
          (pos) => handlePositionUpdate(pos, targetUser),
          (err) => console.log('[LocationGate] Continuous watch notice:', err.message),
          { enableHighAccuracy: true, maximumAge: 30000, timeout: 25000 }
        );
      } catch (_) {}
    }

    if (trackingIntervalId === null) {
      trackingIntervalId = setInterval(() => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
          (pos) => handlePositionUpdate(pos, targetUser),
          () => {},
          { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
        );
      }, 120000);
    }
  }

  /**
   * Complete gate flow — only called after successful location grant.
   */
  function finishGate(result) {
    const overlay = document.getElementById('permissionGateOverlay');
    if (overlay) overlay.classList.add('hidden');
    const appLayout = document.querySelector('.app-layout');
    if (appLayout) appLayout.style.visibility = 'visible';

    // Start continuous tracking while user uses the app
    if (activeUser) {
      startContinuousTracking(activeUser);
    }

    if (typeof gateCallback === 'function') {
      const cb = gateCallback;
      gateCallback = null;
      cb(result);
    }
  }

  /**
   * Attempt to get location, save it, and finish gate.
   * On failure: show a mandatory error with Retry — no skip allowed.
   */
  async function attemptLocation(checkbox, btnAllow, msgEl) {
    btnAllow.disabled = true;
    btnAllow.style.opacity = '0.5';
    btnAllow.style.cursor = 'not-allowed';
    btnAllow.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Requesting location...';

    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.color = '#45f3ff';
      msgEl.textContent = 'Please click "Allow" on your browser\'s location prompt.';
    }

    try {
      const coords = await requestBrowserLocation();
      const userId = activeUser.id || activeUser.userId || 'user_' + Date.now();
      await saveLocation(userId, coords);

      if (msgEl) {
        msgEl.style.color = '#22c55e';
        msgEl.textContent = '✓ Location verified! Entering DK Music...';
      }
      btnAllow.innerHTML = '<i class="fas fa-check-circle"></i> Location Verified!';
      setTimeout(() => finishGate({ granted: true, coords }), 800);

    } catch (err) {
      console.warn('[LocationGate] Location denied/failed:', err.message);

      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.color = '#f87171';
        msgEl.innerHTML =
          '<i class="fas fa-exclamation-triangle" style="margin-right:6px;"></i>' +
          '<strong>Location access is required</strong> to use DK Music.<br>' +
          '<span style="font-size:0.8rem;color:#94a3b8;margin-top:4px;display:block;">' +
          'Please allow location in your browser settings (🔒 icon in address bar), ' +
          'then click Retry.</span>';
      }

      // Show Retry — no skip/continue-anyway
      btnAllow.disabled = false;
      btnAllow.style.opacity = '1';
      btnAllow.style.cursor = 'pointer';
      btnAllow.innerHTML = '<i class="fas fa-rotate-right"></i> Retry Location Access';
      btnAllow.onclick = () => {
        if (checkbox) checkbox.checked = true; // keep checked for retry
        attemptLocation(checkbox, btnAllow, msgEl);
      };
    }
  }

  /**
   * Main gate presentation — location is MANDATORY.
   * Gate stays visible until the user grants location. No skip.
   */
  function showGate(user, onComplete) {
    activeUser = user || global.currentUser || { id: 'anonymous' };
    gateCallback = onComplete;

    const overlay = document.getElementById('permissionGateOverlay');
    if (!overlay) {
      // Safety fallback — gate HTML missing, cannot enforce
      console.warn('[LocationGate] Gate overlay missing from DOM.');
      const appLayout = document.querySelector('.app-layout');
      if (appLayout) appLayout.style.visibility = 'visible';
      if (typeof onComplete === 'function') onComplete({ granted: false, noDOM: true });
      return;
    }

    const checkbox  = document.getElementById('pgLocationCheckbox');
    const btnAllow  = document.getElementById('pgBtnAllowLocation');
    const msgEl     = document.getElementById('pgMessage');

    // Permanently hide the "Continue Anyway" fallback — location is mandatory
    const fallbackBox  = document.getElementById('pgFallbackOption');
    const btnContinue  = document.getElementById('pgBtnContinueAnyway');
    if (fallbackBox) fallbackBox.style.display = 'none';
    if (btnContinue)  btnContinue.style.display = 'none';

    // Reset UI
    if (checkbox) checkbox.checked = false;
    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
    if (btnAllow) {
      btnAllow.disabled = true;
      btnAllow.style.opacity = '0.5';
      btnAllow.style.cursor = 'not-allowed';
      btnAllow.innerHTML = '<i class="fas fa-location-arrow"></i> Allow Location &amp; Continue';
    }

    // Enable Allow button only when checkbox is checked
    if (checkbox && btnAllow) {
      checkbox.onchange = () => {
        const agreed = checkbox.checked;
        btnAllow.disabled = !agreed;
        btnAllow.style.opacity = agreed ? '1' : '0.5';
        btnAllow.style.cursor = agreed ? 'pointer' : 'not-allowed';
      };
    }

    // Handle Allow click — attempts to get location (mandatory)
    if (btnAllow) {
      btnAllow.onclick = () => {
        if (!checkbox || !checkbox.checked) return;
        attemptLocation(checkbox, btnAllow, msgEl);
      };
    }

    // Show gate overlay (blocks app behind it)
    overlay.classList.remove('hidden');
  }

  // Public Export
  global.DKPermissionGate = {
    show: showGate,
    saveLocation: saveLocation,
    startTracking: startContinuousTracking,
    getPreciseLocation: requestBrowserLocation
  };

})(typeof window !== 'undefined' ? window : globalThis);

