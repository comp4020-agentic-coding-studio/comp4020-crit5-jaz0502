import { defineConfig } from "astro/config";

// Deployed under username.github.io/comp4020-crit5-jaz0502/, so Astro needs
// the repo name as its base --- get this wrong and every asset 404s on the
// live URL while looking fine in `astro dev`. Internal links in markup still
// need to be relative (or use import.meta.env.BASE_URL) since `base` only
// prefixes what Astro itself generates (styles, scripts, `astro:assets`).
export default defineConfig({
  base: "/comp4020-crit5-jaz0502/",
});
