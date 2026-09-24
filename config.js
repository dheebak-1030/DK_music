// Config file exporting Supabase credentials
const SUPABASE_URL = "https://brufxavwnnzcpchtfiqg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_qq1F4EnE3h6f9o_V5WxpTw_RJAZrsJb";

if (typeof window !== 'undefined') {
  window.SUPABASE_URL = SUPABASE_URL;
  window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY };
}
