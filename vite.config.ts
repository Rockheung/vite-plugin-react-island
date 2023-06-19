import { UserConfig, defineConfig, loadEnv } from "vite";
import fs from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { responseInterceptor } from "http-proxy-middleware";
import { JSDOM } from "jsdom";

interface LivePageProxyOptions {
  livePageOrigin: string;
  appContainerId?: string;
  mountNextTo?: string;
  https?: UserConfig["server"]["https"];
  ignorePathRegex?: string;
}

const DEFAULT_ROOT_ID = "root";
const DEFAULT_MAIN_APP_SRC = "src/main.tsx";

const livePageProxy = async (userOptions: LivePageProxyOptions) => {
  const ignoreProxyPaths = [
    "node_modules", // node_modules/vite/dist/client/env.mjs
    "@vite/client", // HMR stuff
    "@react-refresh",
    "src",
    ...(await fs.readdir("./public")),
  ]
    .map((fileName) => `(?!/${fileName})`)
    .join("");
  return {
    name: "live-page-proxy",
    config: async ({ build }) => {
      return {
        server: {
          https: userOptions.https,
          proxy: {
            [`^${ignoreProxyPaths}.*`]: {
              target: userOptions.livePageOrigin,
              changeOrigin: true,
              cookieDomainRewrite: {
                "*": "",
              },
              selfHandleResponse: true,
              configure: (proxy, options) => {
                proxy.on("proxyReq", (proxyReq, req, res) => {
                  try {
                    proxyReq.setHeader("referer", options.target + new URL(req.headers.referer).pathname);
                  } catch (error) {
                    proxyReq.setHeader("referer", options.target + '/');
                  }
                });
                proxy.on(
                  "proxyRes",
                  responseInterceptor(
                    async (responseBuffer, proxyRes, req, res) => {
                      if (
                        !/^text\/html/.test(proxyRes.headers["content-type"])
                      ) {
                        return responseBuffer;
                      }

                      if (
                        new RegExp(userOptions.ignorePathRegex).test(req.url)
                      ) {
                        return responseBuffer;
                      }

                      const {
                        window: { document },
                      } = new JSDOM(responseBuffer, {
                        url: options.target as string,
                        referrer: options.target as string,
                      });

                      const rootNode = document.getElementById(
                        userOptions.appContainerId || DEFAULT_ROOT_ID
                      );

                      if (
                        typeof userOptions.appContainerId === "undefined" ||
                        rootNode === null
                      ) {
                        console.warn(
                          "You should set `appContainerId` option to inject React app or default is " + DEFAULT_ROOT_ID
                        );
                        console.warn(
                          "If this message shows multiple times, server's response might be malformed."
                        );
                        console.warn(
                          "This plugin does not support html ajax response."
                        );
                        console.warn(
                          "You may need to manually ignore next ajax path with ignorePathRegex option."
                        );
                        console.warn("- " + req.url);

                        const targetNode = document.querySelector(
                          userOptions.mountNextTo || "body > *:first-child"
                        );
                        if (targetNode === null) {
                          console.log(
                            "This request does not seem to be html request."
                          );
                          return responseBuffer;
                        }
                        const appRoot = document.createElement("div");
                        appRoot.id = userOptions.appContainerId || DEFAULT_ROOT_ID;
                        targetNode.parentElement.insertBefore(
                          appRoot,
                          targetNode.nextSibling
                        );
                      }

                      const warnMsg =
                        "==================== vite script injected ====================";

                      return (
                        "<!DOCTYPE html>\n" +
                        document.documentElement.outerHTML.replace(
                          "</body>",
                          `<script>console.warn('${warnMsg}')</script>
  <script type="module">  
    import RefreshRuntime from 'https://localhost:5173/@react-refresh'
    RefreshRuntime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
  </script>
  <script type="module" src="https://localhost:5173/@vite/client"></script>
  <script type="module">
    const container = document.getElementById('${
      userOptions.appContainerId || DEFAULT_ROOT_ID
    }');
    if (container instanceof HTMLElement) {
      import("/${
        build.rollupOptions.input || DEFAULT_MAIN_APP_SRC
      }").catch(console.error);
    } else {
      console.error('Container element not found: ', '${
        userOptions.appContainerId || DEFAULT_ROOT_ID
      }');
    }
  </script>
</body>`
                        )
                      );
                    }
                  )
                );
              },
            },
          },
        },
      };
    },
  };
};

// https://vitejs.dev/config/
export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  return {
    plugins: [
      react(),
      livePageProxy({
        livePageOrigin: env.VITE_TARGET_ORIGIN,
        appContainerId: env.VITE_APP_CONTAINER_ID,
        ignorePathRegex: env.VITE_PROXY_IGNORE_PATHS,
        mountNextTo: env.VITE_APP_INJECT_SELECTOR,
        https: {
          key: await fs.readFile("./certs/localhost-key.pem"),
          cert: await fs.readFile("./certs/localhost.pem"),
        },
      }),
    ],
    build: {
      manifest: true,
      rollupOptions: {
        input: "src/main.tsx",
      },
    },
  };
});
