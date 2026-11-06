import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    clearScreen: false,
    // WebView2 and the Android System WebView are evergreen Chromium: ship modern,
    // minified code without legacy transforms, polyfills or source maps.
    build: {
        target: "es2022",
        cssTarget: "chrome111",
        sourcemap: false,
        modulePreload: { polyfill: false },
        reportCompressedSize: false,
    },
    server: {
        host: host || "127.0.0.1",
        port: 1420,
        strictPort: true,
        hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
        watch: { ignored: ["**/src-tauri/**"] },
    },
});
