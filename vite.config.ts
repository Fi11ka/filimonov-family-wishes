import { defineConfig, loadEnv, type Plugin } from "vite";

// The browser opens the connection to the API while the site's code is still
// loading, so the first request does not wait for it. `crossorigin` matches
// the API requests, which are sent without cookies.
function preconnectApi(apiUrl: string | undefined): Plugin {
  return {
    name: "preconnect-api",
    transformIndexHtml() {
      if (!apiUrl) return;
      let origin: string;
      try {
        origin = new URL(apiUrl).origin;
      } catch {
        return;
      }
      return [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: origin, crossorigin: "" },
          injectTo: "head",
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: "./",
  build: { target: "es2022" },
  server: { port: 5173 },
  plugins: [preconnectApi(loadEnv(mode, process.cwd(), "VITE_").VITE_API_URL)],
}));
