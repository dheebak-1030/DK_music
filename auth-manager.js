/**
 * DK Music — Centralized Supabase Authentication & Authorization Manager
 * 
 * Manages Supabase Auth session (JWT access tokens), user profile, role verification,
 * and state change events. Single singleton listener, no duplicate handlers.
 */

(function (global) {
  if (global.DKAuth) return;

  const authState = {
    isReady: false,
    session: null,
    user: null,
    profile: null,
    isAdmin: false,
    isAuthenticated: false,
    _readyCallbacks: [],
    _changeCallbacks: []
  };

  /**
   * Helper: Format phone number into E.164 standard (+91 default for 10-digit Indian numbers)
   */
  function formatE164Phone(raw) {
    if (!raw) return '';
    let cleaned = String(raw).trim().replace(/[^\d+]/g, '');
    if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
    if (cleaned.startsWith('+')) return cleaned;
    if (/^[6-9]\d{9}$/.test(cleaned)) return '+91' + cleaned;
    if (/^0[6-9]\d{9}$/.test(cleaned)) return '+91' + cleaned.slice(1);
    if (/^91[6-9]\d{9}$/.test(cleaned)) return '+' + cleaned;
    if (/^\d{10,15}$/.test(cleaned)) return '+' + cleaned;
    return '+' + cleaned;
  }

  /**
   * Fetch profile record for authenticated user from public.profiles table
   */
  async function fetchProfile(sb, user) {
    if (!sb || !user) return null;
    try {
      const { data, error } = await sb
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (!error && data) {
        return data;
      }

      // If profile record doesn't exist yet, try inserting or synthesizing one
      const fallbackProfile = {
        id: user.id,
        email: user.email || '',
        phone: user.phone || '',
        display_name: user.user_metadata?.display_name || user.user_metadata?.name || (user.email ? user.email.split('@')[0] : (user.phone || 'User')),
        role: user.user_metadata?.role || (user.email === 'admin@dkmusic.com' ? 'admin' : 'user'),
        status: 'active'
      };

      try {
        await sb.from('profiles').upsert([fallbackProfile], { onConflict: 'id' });
      } catch (_) {}

      return fallbackProfile;
    } catch (e) {
      console.warn('[DKAuth] Failed to load user profile:', e);
      return {
        id: user.id,
        email: user.email || '',
        phone: user.phone || '',
        display_name: user.user_metadata?.display_name || 'User',
        role: user.user_metadata?.role || 'user',
        status: 'active'
      };
    }
  }

  /**
   * Update internal auth state and notify subscribers
   */
  async function applyAuthState(session) {
    const sb = global.supabaseClient;
    authState.session = session;
    authState.user = session ? session.user : null;
    authState.isAuthenticated = !!(session && session.user);

    if (authState.isAuthenticated && sb) {
      const profile = await fetchProfile(sb, session.user);
      authState.profile = profile;
      authState.isAdmin = (profile?.role === 'admin' || session.user.user_metadata?.role === 'admin');
    } else {
      authState.profile = null;
      authState.isAdmin = false;
    }

    if (!authState.isReady) {
      authState.isReady = true;
      while (authState._readyCallbacks.length > 0) {
        const cb = authState._readyCallbacks.shift();
        try { cb(DKAuth); } catch (err) { console.error('[DKAuth] ready callback error:', err); }
      }
    }

    // Fire state change listeners
    for (const cb of authState._changeCallbacks) {
      try { cb(DKAuth); } catch (err) { console.error('[DKAuth] change callback error:', err); }
    }
  }

  /**
   * Initialize Supabase Auth listener
   */
  let _listenerRegistered = false;
  async function initAuthListener() {
    if (_listenerRegistered) return;
    _listenerRegistered = true;

    let sb = global.supabaseClient;
    if (!sb && typeof global.getSupabaseClient === 'function') {
      try { sb = await global.getSupabaseClient(); } catch (_) {}
    }

    if (!sb || !sb.auth) {
      console.warn('[DKAuth] Supabase client not ready, retrying...');
      setTimeout(() => {
        _listenerRegistered = false;
        initAuthListener();
      }, 300);
      return;
    }

    try {
      // 1. Initial session check
      const { data: { session }, error } = await sb.auth.getSession();
      if (error) {
        console.warn('[DKAuth] Session retrieval notice:', error.message);
      }
      await applyAuthState(session);

      // 2. Register single onAuthStateChange listener
      sb.auth.onAuthStateChange(async (event, newSession) => {
        console.log('[DKAuth] onAuthStateChange event:', event);
        await applyAuthState(newSession);
      });
    } catch (err) {
      console.error('[DKAuth] Auth initialization error:', err);
      authState.isReady = true;
      while (authState._readyCallbacks.length > 0) {
        const cb = authState._readyCallbacks.shift();
        try { cb(DKAuth); } catch (_) {}
      }
    }
  }

  // Public DKAuth API object
  const DKAuth = {
    get session() { return authState.session; },
    get user() { return authState.user; },
    get profile() { return authState.profile; },
    get isAdmin() { return authState.isAdmin; },
    get isAuthenticated() { return authState.isAuthenticated; },
    get isReady() { return authState.isReady; },
    get token() { return authState.session?.access_token || ''; },

    /**
     * Wait until the initial auth session check has finished
     */
    onReady: function (callback) {
      if (authState.isReady) {
        try { callback(DKAuth); } catch (e) { console.error(e); }
      } else {
        authState._readyCallbacks.push(callback);
      }
    },

    /**
     * Subscribe to auth state changes (login, logout, profile update)
     */
    onChange: function (callback) {
      if (typeof callback === 'function') {
        authState._changeCallbacks.push(callback);
      }
    },

    /**
     * Helper to resolve any identifier (email, phone, username) to standard Supabase Auth email
     */
    resolveEmail: function (identifier) {
      const clean = String(identifier || '').trim();
      if (!clean) return '';
      if (clean.includes('@')) return clean.toLowerCase();
      if (clean.toLowerCase() === 'admin') return 'admin@dkmusic.com';
      const safe = clean.replace(/[^\w]/g, '').toLowerCase();
      return safe + '@dkmusic.app';
    },

    /**
     * Standard Login with Password (Email, Mobile, or User ID)
     * Issues real Supabase JWT session tokens without requiring SMS provider
     */
    loginWithPassword: async function (identifier, password) {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (!sb || !sb.auth) throw new Error('Supabase Auth client is not initialized.');

      const cleanId = String(identifier).trim();
      const resolvedEmail = DKAuth.resolveEmail(cleanId);

      // 1. Try with resolved email
      try {
        const { data, error } = await sb.auth.signInWithPassword({
          email: resolvedEmail,
          password: password
        });
        if (!error && data?.session) {
          await applyAuthState(data.session);
          return data;
        }
        if (error && !error.message.includes('Invalid login credentials')) {
          throw error;
        }
      } catch (err) {
        if (!err.message || !err.message.includes('Invalid login credentials')) {
          throw err;
        }
      }

      // 2. If it was a phone number, try phone auth directly as fallback if enabled
      if (!cleanId.includes('@')) {
        try {
          const formatted = formatE164Phone(cleanId);
          const { data, error } = await sb.auth.signInWithPassword({ phone: formatted, password });
          if (!error && data?.session) {
            await applyAuthState(data.session);
            return data;
          }
        } catch (_) {}
      }

      // 3. If direct email had capital letters or variations, try direct
      if (cleanId.includes('@') && cleanId !== resolvedEmail) {
        const { data, error } = await sb.auth.signInWithPassword({ email: cleanId, password });
        if (!error && data?.session) {
          await applyAuthState(data.session);
          return data;
        }
      }

      throw new Error('Invalid login credentials. Please check your email/mobile and password.');
    },

    /**
     * Standard Sign Up with Password (Email, Mobile, or User ID)
     * Creates real Supabase Auth account and issues JWT session without SMS provider
     */
    signUpWithPassword: async function ({ identifier, password, displayName }) {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (!sb || !sb.auth) throw new Error('Supabase Auth client is not initialized.');

      const cleanId = String(identifier).trim();
      const resolvedEmail = DKAuth.resolveEmail(cleanId);
      const name = displayName || (cleanId.includes('@') ? cleanId.split('@')[0] : cleanId);

      const { data, error } = await sb.auth.signUp({
        email: resolvedEmail,
        password: password,
        options: {
          data: {
            display_name: name,
            phone: cleanId.includes('@') ? '' : cleanId
          }
        }
      });

      if (error) {
        console.warn('[DKAuth] Signup notice:', error.message);
        throw error;
      }

      // If session returned immediately (auto-confirm is default or enabled)
      if (data?.session) {
        await applyAuthState(data.session);
        return data;
      }

      // If user created, try immediate sign in
      try {
        const signInRes = await sb.auth.signInWithPassword({
          email: resolvedEmail,
          password: password
        });
        if (signInRes.data?.session) {
          await applyAuthState(signInRes.data.session);
          return signInRes.data;
        }
      } catch (_) {}

      return data;
    },

    /**
     * Sign out current user
     */
    logout: async function () {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (sb && sb.auth) {
        try {
          await sb.auth.signOut();
        } catch (e) {
          console.warn('[DKAuth] SignOut notice:', e.message);
        }
      }
      await applyAuthState(null);
    },

    /**
     * Reload user profile from public.profiles
     */
    refreshProfile: async function () {
      const sb = global.supabaseClient;
      if (sb && authState.user) {
        const profile = await fetchProfile(sb, authState.user);
        authState.profile = profile;
        authState.isAdmin = (profile?.role === 'admin' || authState.user.user_metadata?.role === 'admin');
        for (const cb of authState._changeCallbacks) {
          try { cb(DKAuth); } catch (_) {}
        }
      }
    }
  };

  global.DKAuth = DKAuth;

  // Auto-initialize when DOM or scripts are loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthListener);
  } else {
    initAuthListener();
  }

})(typeof window !== 'undefined' ? window : globalThis);
