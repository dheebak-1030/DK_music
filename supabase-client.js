/**
 * Supabase Single Client Configuration for DK Music
 * Reads SUPABASE_URL and publishable key (SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEY) from .env.
 * Security: Strictly prohibits and filters out any service-role or secret keys.
 */

(function (global) {
  // Return singleton if already initialized
  if (global.__supabaseClientInstance) {
    global.supabaseClient = global.__supabaseClientInstance;
    return;
  }

  // Safe configuration holder
  let config = {
    supabaseUrl: '',
    supabaseAnonKey: ''
  };

  /**
   * Helper: Parse .env key-values safely.
   * Discards any service-role / secret / private keys.
   */
  function parseEnvSafely(envText) {
    const result = {};
    if (!envText || typeof envText !== 'string') return result;

    const lines = envText.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();

        // Strip enclosing quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }

        // Security check: NEVER accept service-role or secret keys
        if (/service[_-]?role|secret|private/i.test(key)) {
          console.warn('[Supabase Security] Ignored sensitive key from environment:', key);
          continue;
        }

        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Load environment configuration from available sources (.env, server API, process.env)
   */
  function resolveConfig() {
    // 1. Check Node.js / bundler process.env if present
    if (typeof process !== 'undefined' && process.env) {
      const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
      if (url && key) {
        return { supabaseUrl: url.trim(), supabaseAnonKey: key.trim() };
      }
    }

    // 2. Check window.__ENV__ or window.ENV if pre-injected
    const injected = global.__ENV__ || global.ENV || {};
    if (injected.SUPABASE_URL && (injected.SUPABASE_ANON_KEY || injected.SUPABASE_PUBLISHABLE_KEY)) {
      return {
        supabaseUrl: injected.SUPABASE_URL.trim(),
        supabaseAnonKey: (injected.SUPABASE_ANON_KEY || injected.SUPABASE_PUBLISHABLE_KEY).trim()
      };
    }

    // 3. In browser environment: try loading from server or local .env synchronously
    if (typeof XMLHttpRequest !== 'undefined') {
      // 3. Try fetching local .env file (if running via static server / Live Server)
      const envPaths = ['.env', 'data/.env', '/.env', '/data/.env'];
      for (const path of envPaths) {
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', path, false);
          xhr.send(null);
          if (xhr.status === 200 && xhr.responseText) {
            const parsed = parseEnvSafely(xhr.responseText);
            const url = parsed.SUPABASE_URL || parsed.VITE_SUPABASE_URL;
            const key = parsed.SUPABASE_ANON_KEY || parsed.SUPABASE_PUBLISHABLE_KEY || parsed.VITE_SUPABASE_PUBLISHABLE_KEY || parsed.VITE_SUPABASE_ANON_KEY;
            if (url && key) {
              return { supabaseUrl: url.trim(), supabaseAnonKey: key.trim() };
            }
          }
        } catch (_) {}
      }
    }

    // 4. Fallback defaults
    return {
      supabaseUrl: 'https://brufxavwnnzcpchtfiqg.supabase.co',
      supabaseAnonKey: 'sb_publishable_qq1F4EnE3h6f9o_V5WxpTw_RJAZrsJb'
    };
  }

  // Resolve config synchronously
  config = resolveConfig();

  // Create Client Singleton
  let client = null;

  function initClient(url, key) {
    if (!url || !key) return null;

    let createFn = null;
    if (global.supabase && typeof global.supabase.createClient === 'function') {
      createFn = global.supabase.createClient;
    } else if (typeof require === 'function') {
      try {
        const sbPkg = require('@supabase/supabase-js');
        createFn = sbPkg.createClient;
      } catch (_) {}
    }

    if (typeof createFn === 'function') {
      try {
        return createFn(url, key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true
          }
        });
      } catch (err) {
        console.warn('[Supabase] Initialization error:', err);
      }
    }
    return null;
  }

  client = initClient(config.supabaseUrl, config.supabaseAnonKey);

  // If client library hasn't finished loading yet, attach async resolution helper
  const clientPromise = new Promise((resolve) => {
    if (client) {
      resolve(client);
      return;
    }
    // Poll briefly for UMD/CDN script loading
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      client = initClient(config.supabaseUrl, config.supabaseAnonKey);
      if (client || attempts > 20) {
        clearInterval(interval);
        if (client) {
          global.__supabaseClientInstance = client;
          global.supabaseClient = client;
        }
        resolve(client);
      }
    }, 100);
  });

  // Assign to globals
  global.__supabaseClientInstance = client;
  global.supabaseClient = client;
  global.getSupabaseClient = () => (client ? Promise.resolve(client) : clientPromise);
  global.isSupabaseConnected = () => !!client;
  global.supabaseConfig = {
    url: config.supabaseUrl,
    hasKey: !!config.supabaseAnonKey
  };

  // Node / CommonJS exports if applicable
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      supabaseClient: client,
      getSupabaseClient: global.getSupabaseClient,
      isSupabaseConnected: global.isSupabaseConnected,
      supabaseConfig: global.supabaseConfig
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
