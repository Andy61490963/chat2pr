import { defineConfig } from "vite";
import dashboard from "../vite.config";

// 測試只提供看板靜態資源；API 與登入回應由瀏覽器測試提供。
export default defineConfig({
  ...dashboard,
  envDir: false,
  server: { host: "127.0.0.1", hmr: false },
});
