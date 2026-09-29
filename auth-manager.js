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
      authState.isAdmin = (profile?.role === 'admin');
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
     * Helper to resolve any identifier (email, username/User ID) to standard Supabase Auth email
     */
    resolveEmail: async function (identifier) {
      const clean = String(identifier || '').trim();
      if (!clean) return '';
      if (clean.includes('@')) return clean.toLowerCase();
      if (clean.toLowerCase() === 'admin') return 'admin@dkmusic.com';

      // Check cached mapping in localStorage
      const cached = localStorage.getItem('dk_user_id_map_' + clean.toLowerCase());
      if (cached && cached.includes('@')) return cached.toLowerCase();

      // Check Supabase profiles table for matching user_id
      try {
        const sb = global.supabaseClient || (await global.getSupabaseClient?.());
        if (sb) {
          const { data } = await sb.from('profiles').select('email').ilike('user_id', clean).maybeSingle();
          if (data && data.email) {
            localStorage.setItem('dk_user_id_map_' + clean.toLowerCase(), data.email);
            return data.email.toLowerCase();
          }
        }
      } catch (_) {}

      const safe = clean.replace(/[^\w]/g, '').toLowerCase();
      return safe + '@dkmusic.app';
    },

    /**
     * Standard Login with Password (Email or User ID)
     * Issues real Supabase JWT session tokens
     */
    loginWithPassword: async function (identifier, password) {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (!sb || !sb.auth) throw new Error('Supabase Auth client is not initialized.');

      const cleanId = String(identifier).trim();
      if (!cleanId) throw new Error('Email or User ID is required.');
      if (!password) throw new Error('Password is required.');

      const resolvedEmail = await DKAuth.resolveEmail(cleanId);

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

      // 2. If cleanId contains '@' and was different from resolved, try direct
      if (cleanId.includes('@') && cleanId.toLowerCase() !== resolvedEmail) {
        const { data, error } = await sb.auth.signInWithPassword({ email: cleanId.toLowerCase(), password });
        if (!error && data?.session) {
          await applyAuthState(data.session);
          return data;
        }
      }

      // 3. Fallback check for synthesized email user@dkmusic.app
      if (!cleanId.includes('@')) {
        const fallbackEmail = cleanId.replace(/[^\w]/g, '').toLowerCase() + '@dkmusic.app';
        if (fallbackEmail !== resolvedEmail) {
          try {
            const { data, error } = await sb.auth.signInWithPassword({ email: fallbackEmail, password });
            if (!error && data?.session) {
              await applyAuthState(data.session);
              return data;
            }
          } catch (_) {}
        }
      }

      throw new Error('Invalid login credentials. Please check your Email/User ID and Password.');
    },

    /**
     * Standard Sign Up with Password: User ID + Email + Password
     * Creates real Supabase Auth account and updates profile
     */
    signUpWithPassword: async function ({ userId, email, identifier, password, displayName }) {
      const sb = global.supabaseClient || (await global.getSupabaseClient?.());
      if (!sb || !sb.auth) throw new Error('Supabase Auth client is not initialized.');

      const cleanUserId = String(userId || displayName || '').trim();
      const cleanEmail = String(email || identifier || '').trim().toLowerCase();

      if (!cleanUserId) throw new Error('User ID is required.');
      if (!cleanEmail || !cleanEmail.includes('@')) throw new Error('Valid email address is required.');
      if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');

      // Check if User ID is already taken in profiles table
      try {
        const { data: existingUser } = await sb
          .from('profiles')
          .select('id, user_id')
          .ilike('user_id', cleanUserId)
          .maybeSingle();

        if (existingUser) {
          throw new Error(`User ID "${cleanUserId}" is already taken. Please choose another.`);
        }
      } catch (checkErr) {
        if (checkErr.message && checkErr.message.includes('already taken')) {
          throw checkErr;
        }
      }

      // Supabase Auth SignUp
      const { data, error } = await sb.auth.signUp({
        email: cleanEmail,
        password: password,
        options: {
          data: {
            user_id: cleanUserId,
            display_name: cleanUserId
          }
        }
      });

      if (error) {
        if (/already registered|email.*exists/i.test(error.message)) {
          throw new Error('This email is already registered. Please log in instead.');
        }
        throw error;
      }

      // Cache User ID -> Email mapping locally
      localStorage.setItem('dk_user_id_map_' + cleanUserId.toLowerCase(), cleanEmail);

      // Upsert profile record
      const uid = data?.user?.id;
      if (uid) {
        try {
          await sb.from('profiles').upsert([{
            id: uid,
            user_id: cleanUserId,
            email: cleanEmail,
            display_name: cleanUserId,
            role: 'user',
            status: 'active',
            updated_at: new Date().toISOString()
          }], { onConflict: 'id' });
        } catch (_) {}
      }

      // If session returned immediately
      if (data?.session) {
        await applyAuthState(data.session);
        return data;
      }

      // Try automatic sign-in
      try {
        const signInRes = await sb.auth.signInWithPassword({
          email: cleanEmail,
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
