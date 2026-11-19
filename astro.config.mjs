// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from "@astrojs/sitemap";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
    trailingSlash: "never",
    site: 'https://friendsoflakehenry.com',
    integrations: [
        sitemap({
            filter: (page) => !page.includes("/admin") && !page.includes("/api/"),
        }),
    ],
    output: "server",
    adapter: cloudflare({
        imageService: "passthrough",
        routes: { extend: { exclude: [{ pattern: "/_image" }, { pattern: "/_image/*" }] } },
    }),
    // Astro 5 registers an image route for server output even in passthrough mode.
    image: {
        endpoint: { route: "/_image", entrypoint: "./src/lib/server/disabled-image-endpoint.ts" },
    },
});
