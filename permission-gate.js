/**
 * DK Music — Location Agreement Manager
 *
 * Requirements:
 * 1. After successful authentication -> Location Agreement screen.
 * 2. Show: "Allow location access to continue using DK Music." + Checkbox + "Allow Location & Continue" button.
 * 3. Only after checkbox is checked -> browser Geolocation API is called.
 * 4. On Allow -> get latitude, longitude, timestamp; save in Supabase user profile & localStorage.
 * 5. On Deny / Error -> inform user politely without crashing and let them continue.
 */

(function (global) {
  'use strict';

  let activeUser = null;
  let gateCallback = null;

  /**
   * Save user location record to Supabase profiles / user_locations & localStorage
   */
  async function saveLocation(userId, coords) {
    const timestamp = new Date().toISOString();
    const locRecord = {
      user_id: String(userId),
      latitude: Number(coords.latitude),
      longitude: Number(coords.longitude),
      accuracy: coords.accuracy !== null ? Number(coords.accuracy) : null,
      timestamp: timestamp,
      updated_at: timestamp
    };

    // 1. Save to Supabase (profiles or user_locations table)
    try {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (sb) {
        // Try updating user profiles first
        try {
          await sb.from('profiles').update({
            latitude: locRecord.latitude,
            longitude: locRecord.longitude,
            location_updated_at: locRecord.timestamp
          }).eq('id', userId);
        } catch (_) {}

        // Also upsert into user_locations if available
        try {
          const locRow = {
            user_id: locRecord.user_id,
            latitude: locRecord.latitude,
            longitude: locRecord.longitude,
            accuracy: locRecord.accuracy,
            updated_at: locRecord.updated_at
          };
          let { error } = await sb.from('user_locations').upsert([locRow], { onConflict: 'user_id' });
          if (error) {
            const ins = await sb.from('user_locations').insert([locRow]);
            error = ins.error;
            if (error) {
              const upd = await sb.from('user_locations').update({
                latitude: locRow.latitude,
                longitude: locRow.longitude,
                accuracy: locRow.accuracy,
                updated_at: locRow.updated_at
              }).eq('user_id', locRow.user_id);
              error = upd.error;
            }
          }
          if (error) {
            console.warn('[LocationGate] Supabase user_locations error:', error.message);
          } else {
            console.log('[LocationGate] Saved to Supabase user_locations.');
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[LocationGate] Supabase location save notice:', e);
    }

    // 2. Save to localStorage
    try {
      localStorage.setItem('dk_user_location', JSON.stringify(locRecord));
      localStorage.setItem('dk_location_agreed_' + userId, 'true');

      const allLocs = JSON.parse(localStorage.getItem('dk_admin_user_locations') || '[]');
      const idx = allLocs.findIndex(l => (l.user_id || l.userId) === String(userId));
      if (idx !== -1) {
        allLocs[idx] = locRecord;
      } else {
        allLocs.push(locRecord);
      }
      localStorage.setItem('dk_admin_user_locations', JSON.stringify(allLocs));
    } catch (_) {}

    return locRecord;
  }

  /**
   * Request browser Geolocation API
   */
  function requestBrowserLocation() {
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
            accuracy: pos.coords.accuracy || null,
            timestamp: new Date().toISOString()
          });
        },
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }

  /**
   * Complete gate flow
   */
  function finishGate(result) {
    const overlay = document.getElementById('permissionGateOverlay');
    if (overlay) overlay.classList.add('hidden');
    const appLayout = document.querySelector('.app-layout');
    if (appLayout) appLayout.style.visibility = 'visible';

    if (typeof gateCallback === 'function') {
      const cb = gateCallback;
      gateCallback = null;
      cb(result);
    }
  }

  /**
   * Main gate presentation
   */
  function showGate(user, onComplete) {
    activeUser = user || global.currentUser || { id: 'anonymous' };
    gateCallback = onComplete;

    const overlay = document.getElementById('permissionGateOverlay');
    if (!overlay) {
      finishGate({ granted: false });
      return;
    }

    const checkbox = document.getElementById('pgLocationCheckbox');
    const btnAllow = document.getElementById('pgBtnAllowLocation');
    const msgEl = document.getElementById('pgMessage');
    const fallbackBox = document.getElementById('pgFallbackOption');
    const btnContinue = document.getElementById('pgBtnContinueAnyway');

    // Reset UI state
    if (checkbox) checkbox.checked = false;
    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
    if (fallbackBox) fallbackBox.style.display = 'none';

    if (btnAllow) {
      btnAllow.disabled = true;
      btnAllow.style.opacity = '0.5';
      btnAllow.style.cursor = 'not-allowed';
      btnAllow.innerHTML = '<i class="fas fa-location-arrow"></i> Allow Location & Continue';
    }

    // Toggle button state strictly on checkbox change
    if (checkbox && btnAllow) {
      checkbox.onchange = () => {
        const agreed = checkbox.checked;
        btnAllow.disabled = !agreed;
        btnAllow.style.opacity = agreed ? '1' : '0.5';
        btnAllow.style.cursor = agreed ? 'pointer' : 'not-allowed';
      };
    }

    // Handle "Allow Location & Continue" click
    if (btnAllow) {
      btnAllow.onclick = async () => {
        if (!checkbox || !checkbox.checked) return;

        btnAllow.disabled = true;
        btnAllow.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Requesting location...';

        if (msgEl) {
          msgEl.style.display = 'block';
          msgEl.style.color = '#45f3ff';
          msgEl.textContent = 'Please click "Allow" on your browser location prompt.';
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

          setTimeout(() => {
            finishGate({ granted: true, coords });
          }, 800);

        } catch (err) {
          console.warn('[LocationGate] Location denied or failed:', err.message);
          const userId = activeUser.id || activeUser.userId || 'anonymous';
          try { localStorage.setItem('dk_location_agreed_' + userId, 'skipped'); } catch (_) {}

          if (msgEl) {
            msgEl.style.display = 'block';
            msgEl.style.color = '#fbbf24';
            msgEl.textContent = 'Location access was not granted. You can still continue using DK Music normally.';
          }

          if (fallbackBox) {
            fallbackBox.style.display = 'block';
          }

          if (btnAllow) {
            btnAllow.disabled = false;
            btnAllow.style.opacity = '1';
            btnAllow.style.cursor = 'pointer';
            btnAllow.innerHTML = '<i class="fas fa-arrow-right"></i> Continue to DK Music';
            btnAllow.onclick = () => finishGate({ granted: false, reason: err.message });
          }
        }
      };
    }

    // Fallback continue button
    if (btnContinue) {
      btnContinue.onclick = () => {
        const userId = activeUser.id || activeUser.userId || 'anonymous';
        try { localStorage.setItem('dk_location_agreed_' + userId, 'skipped'); } catch (_) {}
        finishGate({ granted: false, skipped: true });
      };
    }

    // Show modal
    overlay.classList.remove('hidden');
  }

  // Public Export
  global.DKPermissionGate = {
    show: showGate,
    saveLocation: saveLocation
  };

})(typeof window !== 'undefined' ? window : globalThis);
