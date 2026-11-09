import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // The Supabase URL and publishable/anon key are public client configuration.
  // Keep environment overrides available, but provide the existing project values
  // so production builds are correctly configured even when CI has no VITE_* vars.
  // Never put SUPABASE_SERVICE_ROLE_KEY or any other server secret here.
  const env = loadEnv(mode, ".", "VITE_");
  const supabaseUrl = env.VITE_SUPABASE_URL || "https://saavqlbwffrwxingbnri.supabase.co";
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || "sb_publishable_IruAYNoelmN7N4Q1Hy2HFg_wxw-1zgS";

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(supabaseAnonKey)
    },
    server: {
      port: 5173,
      host: "0.0.0.0",
      proxy: { "/api": "http://localhost:8787" }
    }
  };
});
