# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## The stack: Astro

This repo runs Astro, not the template's default plain HTML/CSS/TypeScript on
Vite — carried forward from last week. Pages live in `src/pages/`, and
`astro.config.mjs` sets `base: "/comp4020-crit5-jaz0502/"` to match this repo's
Pages URL, since Astro's `base` prefixes every generated asset URL with it and
getting it wrong looks fine locally while everything 404s live. `typecheck`
runs `astro check` instead of a bare `tsc`.

Astro only prefixes `base` onto what it generates itself (styles, scripts,
`astro:assets`) — a hand-written `<a href="/foo">` in markup won't get it, so
internal links stay relative (`href="./"`) rather than root-absolute. If a page
nests under a subpath, the relative link back to `./` or `../` has to change
per page — see how `Layout.astro` does it.

The links check only runs in CI, but run it locally against a fresh `pnpm build`
first, mirroring `dist/` under that same `base` subpath so it matches what Pages
actually serves:

```
mkdir -p /tmp/link-check/comp4020-crit5-jaz0502 && cp -r dist/. /tmp/link-check/comp4020-crit5-jaz0502/ && pnpm dlx linkinator comp4020-crit5-jaz0502/index.html --server-root /tmp/link-check --silent
```

`public/card.png` (1200x630) is the image a shared link shows; `Layout.astro`'s
head points at it. Replace it and the `description` prop passed into `Layout`
— every page that uses `Layout` picks up the same head block automatically.

## The checks

`pnpm check` runs them, and `pnpm check:evidence` is the extra gate before you
ship. CI runs the same plus links, secrets and the deploy.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## This file is yours

A starting point, not a rulebook: what you add to it is the harness, and the
harness is assessed. This file and the sensors you wire into `check` carry
across the course --- both come with you into next week's repo. The prototype
doesn't: source, and the tests answering this week's published spec, stay
behind. `spec/README.md` draws the line.
