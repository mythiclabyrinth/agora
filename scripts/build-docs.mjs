#!/usr/bin/env node
// Renders the user-facing docs site from docs/site/*.md, unified with the
// coding-agent guides that live at web/public/docs/coding-agents/.
//
// This is the *product* documentation (setup and everyday use); the repo's
// contributor docs (docs/ARCHITECTURE.md, PROTOCOL.md, AUTH.md,
// DEPLOYMENT.md) stay on GitHub and are not part of the site.
//
// Used in two places, producing identical output:
//   - the web build (web/package.json) emits into web/dist/docs, so the
//     headless server, the Docker image, and the desktop bundle all serve
//     the docs at /docs/ (the coding-agent guides arrive there via Vite's
//     public-dir copy);
//   - the GitHub Pages workflow emits into _site (and copies the
//     coding-agent guides in), published at
//     https://tomjose92.github.io/agora/.
//
// Guide pages get pretty URLs (getting-started/, self-hosting/, ...);
// support.html and privacy.html stay flat because the App Store listing and
// the mobile app link them directly. The two hosts differ only in the
// Storybook/footer links, selected by --flavor.
//
// Usage: node scripts/build-docs.mjs --out <dir> [--flavor server|pages]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(repoRoot, "docs", "site");
const assetsDir = path.join(repoRoot, "scripts", "docs-site");
const REPO_URL = "https://github.com/tomjose92/agora";
const PAGES_URL = "https://tomjose92.github.io/agora/";

const { guides } = await import(
  pathToFileURL(path.join(repoRoot, "web/public/docs/coding-agents/guide-data.js")).href
);

const outFlag = process.argv.indexOf("--out");
if (outFlag === -1 || !process.argv[outFlag + 1]) {
  console.error("usage: node scripts/build-docs.mjs --out <dir> [--flavor server|pages]");
  process.exit(1);
}
const outDir = path.resolve(process.cwd(), process.argv[outFlag + 1]);
const flavorFlag = process.argv.indexOf("--flavor");
const flavor = flavorFlag === -1 ? "server" : process.argv[flavorFlag + 1];
if (flavor !== "server" && flavor !== "pages") {
  console.error(`unknown --flavor: ${flavor} (expected server or pages)`);
  process.exit(1);
}
const isPages = flavor === "pages";

// ---------------------------------------------------------------------------
// Site manifest: nav groups and reading order both derive from this.
// ---------------------------------------------------------------------------

// Guide pages: <slug>.md in docs/site -> <slug>/index.html, linked as <slug>/.
const GUIDE_GROUPS = [
  { label: "Getting started", slugs: ["getting-started"] },
  { label: "Using Agora", slugs: ["groups-and-channels", "people", "agents"] },
  { label: "Self-hosting", slugs: ["self-hosting", "configuration"] },
];
// Flat pages: rendered with the same chrome, emitted at the site root under
// their load-bearing URLs; kept out of the guide nav group and the pager.
const FLAT_PAGES = ["support", "privacy"];

const guideSlugs = GUIDE_GROUPS.flatMap((g) => g.slugs);

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);

// ---------------------------------------------------------------------------
// Markdown processing
// ---------------------------------------------------------------------------

// Relative links in the sources are written as if from the site root
// (agents.md, support.html, coding-agents/index.html). Rewrite .md targets to
// their published URLs and mark every site-relative link with a __ROOT__
// placeholder, substituted per page depth at emit time. Links reaching
// outside docs/site point at GitHub.
function rewriteLinks(md) {
  return md.replace(
    /\]\((?!(?:[a-z][a-z0-9+.-]*:)|\/\/|#)([^)\s]+?)(#[^)\s]*)?\)/g,
    (_match, target, anchor = "") => {
      const clean = target.replace(/^\.\//, "");
      const slug = clean.replace(/\.md$/, "");
      if (clean.endsWith(".md") && guideSlugs.includes(slug)) {
        return `](__ROOT__${slug}/${anchor})`;
      }
      if (clean.endsWith(".md") && FLAT_PAGES.includes(slug)) {
        return `](__ROOT__${slug}.html${anchor})`;
      }
      if (clean.startsWith("../../")) {
        return `](${REPO_URL}/blob/main/${clean.slice(6)}${anchor})`;
      }
      if (clean.startsWith("../")) {
        return `](${REPO_URL}/blob/main/docs/${clean.slice(3)}${anchor})`;
      }
      return `](__ROOT__${clean}${anchor})`;
    },
  );
}

// GitHub-compatible heading slugs so #anchors are predictable.
function slugify(headingHtml) {
  return headingHtml
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w -]/g, "")
    .replace(/ /g, "-");
}

// TOC/search text is plain text, so undo marked's entity escaping (it gets
// re-escaped once at render time).
const unescapeHtml = (value) =>
  value.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
  })[e]);

// Adds ids + hover anchors to headings and collects the h2/h3 outline.
function addHeadingAnchors(html) {
  const seen = new Map();
  const toc = [];
  const out = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    let slug = slugify(inner);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    const text = unescapeHtml(inner.replace(/<[^>]+>/g, ""));
    if (level === "2" || level === "3") toc.push({ level: Number(level), id: slug, text });
    return `<h${level} id="${slug}">${inner}<a class="anchor" href="#${slug}" aria-label="Link to this section">#</a></h${level}>`;
  });
  return { html: out, toc };
}

// Wrap fenced code in .code-block (lang label + copy-button mount point) and
// tables in a horizontal scroll container.
function wrapBlocks(html) {
  return html
    .replace(
      /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
      (_m, lang = "", body) =>
        `<div class="code-block" data-lang="${escapeHtml(lang)}"><pre><code>${body}</code></pre></div>`,
    )
    .replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-wrap"><table>$1</table></div>');
}

function firstParagraph(md) {
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const para = [];
  while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#")) {
    para.push(lines[i].trim());
    i++;
  }
  return para
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "");
}

marked.setOptions({ gfm: true });

function loadDoc(slug) {
  const md = fs.readFileSync(path.join(siteDir, `${slug}.md`), "utf8");
  const title = (md.match(/^# (.+)$/m)?.[1] ?? slug).trim();
  const rendered = addHeadingAnchors(marked.parse(rewriteLinks(md)));
  return {
    slug,
    title,
    intro: firstParagraph(md),
    body: wrapBlocks(rendered.html),
    toc: rendered.toc,
  };
}

const guideDocs = new Map(guideSlugs.map((slug) => [slug, loadDoc(slug)]));
const flatDocs = FLAT_PAGES.map(loadDoc);

// ---------------------------------------------------------------------------
// Chrome (all hrefs site-root-relative; prefixed with root per page)
// ---------------------------------------------------------------------------

const agentEntries = Object.entries(guides).map(([key, guide]) => ({
  key,
  href: `coding-agents/${key}.html`,
  title: guide.name,
  description: guide.description,
  logo: `coding-agents/${guide.logo}`,
}));

const guideItems = (label) =>
  GUIDE_GROUPS.find((g) => g.label === label).slugs.map((slug) => ({
    title: guideDocs.get(slug).title,
    href: `${slug}/`,
    key: slug,
  }));

const NAV_GROUPS = [
  {
    label: "Getting started",
    items: [{ title: "Overview", href: "index.html", key: "index" }, ...guideItems("Getting started")],
  },
  { label: "Using Agora", items: guideItems("Using Agora") },
  {
    label: "Agent integrations",
    items: [{ title: "Hermes Agent", href: "agents/hermes.html" }],
  },
  {
    label: "Coding agents",
    items: [
      { title: "Overview", href: "coding-agents/index.html" },
      ...agentEntries.map(({ title, href }) => ({ title, href })),
    ],
  },
  { label: "Self-hosting", items: guideItems("Self-hosting") },
  {
    label: "Project",
    items: [
      { title: "Support", href: "support.html", key: "support" },
      { title: "Privacy policy", href: "privacy.html", key: "privacy" },
      // Storybook is deployed with the Pages site, not bundled into web/dist.
      { title: "Storybook", href: isPages ? "storybook/" : `${PAGES_URL}storybook/` },
      { title: "GitHub", href: REPO_URL },
    ],
  },
];

const href = (root, target) => (/^[a-z][a-z0-9+.-]*:/.test(target) ? target : root + target);

function navHtml(currentKey, root) {
  return NAV_GROUPS.map(
    (group) =>
      `<div class="nav-group">${group.label}</div>\n` +
      group.items
        .map(
          (item) =>
            `<a class="nav-item${item.key === currentKey ? " active" : ""}" href="${href(root, item.href)}">${escapeHtml(item.title)}</a>`,
        )
        .join("\n"),
  ).join("\n");
}

const topbar = (root) => `
<header class="topbar">
  <button class="menu-btn" id="menu-btn" aria-label="Toggle navigation">&#9776;</button>
  <a class="brand" href="${root}index.html"><span class="logo">A</span><span>Agora</span><span class="brand-sub">Docs</span></a>
  <div class="topbar-spacer"></div>
  <div class="search">
    <input id="search-input" type="search" placeholder="Search docs" autocomplete="off" spellcheck="false" />
    <kbd class="search-kbd">/</kbd>
    <div id="search-results" hidden></div>
  </div>
  <a class="topbar-link" href="${REPO_URL}">GitHub</a>
</header>`;

function head(title, description, root) {
  return `<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Agora docs</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="icon" href="${root}icon.png" />
  <link rel="stylesheet" href="${root}docs.css" />
</head>`;
}

// pager is {prev, next} ({title, href} site-root-relative) or null.
function contentPage(doc, { pager, root, currentKey }) {
  const pagerHtml = pager
    ? `    <nav class="pager">
      <a href="${href(root, pager.prev.href)}"><span class="label">&larr; Previous</span><span class="title">${escapeHtml(pager.prev.title)}</span></a>
      <a class="next" href="${href(root, pager.next.href)}"><span class="label">Next &rarr;</span><span class="title">${escapeHtml(pager.next.title)}</span></a>
    </nav>
`
    : "";
  const tocHtml = doc.toc
    .map(
      (h) =>
        `<a class="${h.level === 3 ? "lvl3" : "lvl2"}" href="#${h.id}">${escapeHtml(h.text)}</a>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
${head(doc.title, doc.intro.slice(0, 155), root)}
<body data-root="${root}">
<div class="scrim" id="scrim"></div>
${topbar(root)}
<div class="layout">
  <aside class="sidebar" id="sidebar"><nav>
${navHtml(currentKey, root)}
  </nav></aside>
  <main class="main">
    <nav class="crumbs"><a href="${root}index.html">Docs</a><span class="sep">/</span><span>${escapeHtml(doc.title)}</span></nav>
    <article class="prose">
${doc.body.replaceAll("__ROOT__", root)}
    </article>
${pagerHtml}  </main>
  <aside class="toc-rail">
    <div class="toc-title">On this page</div>
    <nav class="toc">
${tocHtml}
    </nav>
  </aside>
</div>
<script src="${root}docs.js" defer></script>
</body>
</html>
`;
}

function landingPage() {
  const sections = GUIDE_GROUPS.map((group) => {
    const cards = group.slugs
      .map((slug) => {
        const d = guideDocs.get(slug);
        return `<a class="card" href="${slug}/"><h3>${escapeHtml(d.title)}</h3><p>${escapeHtml(d.intro)}</p></a>`;
      })
      .join("\n");
    return `  <section>
    <div class="section-head"><h2>${escapeHtml(group.label)}</h2></div>
    <div class="cards">
${cards}
    </div>
  </section>`;
  });
  const agentCards = agentEntries
    .map(
      (a) =>
        `<a class="card agent" href="${a.href}"><img src="${a.logo}" alt="" /><span><h3>${escapeHtml(a.title)}</h3><p>${escapeHtml(a.description)}</p></span></a>`,
    )
    .join("\n");
  sections.splice(2, 0, `  <section>
    <div class="section-head"><h2>Coding agents</h2><a href="coding-agents/index.html">Overview &rarr;</a></div>
    <div class="cards">
${agentCards}
    </div>
  </section>`);
  return `<!doctype html>
<html lang="en">
${head("Documentation", "How to set up and use Agora, the self-hosted chat app where people and AI agents share rooms.", "")}
<body class="landing" data-root="">
<div class="scrim" id="scrim"></div>
${topbar("")}
<main class="landing-main">
  <header class="hero">
    <span class="kicker">Agora documentation</span>
    <h1>People and AI agents, sharing rooms</h1>
    <p>Everything you need to set up and use Agora: install the apps, create
    rooms and invite people, connect AI agents, and run your own server.</p>
  </header>
${sections.join("\n")}
  <footer class="landing-footer">
    <a href="support.html">Support</a> &middot;
    <a href="privacy.html">Privacy policy</a> &middot;
    <a href="${isPages ? "storybook/" : `${PAGES_URL}storybook/`}">Storybook</a> &middot;
    <a href="${REPO_URL}">GitHub</a>${
      isPages
        ? ""
        : ` &middot;
    <a href="../">Open Agora</a>`
    }
  </footer>
</main>
<script src="docs.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

// {t: page title, p: site-root-relative href, h: heading text ("" for the
//  page itself), id: anchor id ("" for the page itself)}
const AGENT_SECTIONS = [
  ["Setup", "setup"],
  ["Commands in Agora", "commands"],
  ["Environment variables", "configuration"],
  ["Security model", "security"],
  ["Troubleshooting", "troubleshooting"],
];
const searchIndex = [
  ...guideSlugs.flatMap((slug) => {
    const d = guideDocs.get(slug);
    return [
      { t: d.title, p: `${slug}/`, h: "", id: "" },
      ...d.toc.map((h) => ({ t: d.title, p: `${slug}/`, h: h.text, id: h.id })),
    ];
  }),
  ...flatDocs.flatMap((d) => [
    { t: d.title, p: `${d.slug}.html`, h: "", id: "" },
    ...d.toc.map((h) => ({ t: d.title, p: `${d.slug}.html`, h: h.text, id: h.id })),
  ]),
  { t: "Coding agents", p: "coding-agents/index.html", h: "", id: "" },
  ...agentEntries.flatMap((a) => [
    { t: a.title, p: a.href, h: "", id: "" },
    ...AGENT_SECTIONS.map(([h, id]) => ({ t: a.title, p: a.href, h, id })),
  ]),
];

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });
guideSlugs.forEach((slug, i) => {
  const doc = guideDocs.get(slug);
  const prev =
    i === 0
      ? { title: "Overview", href: "index.html" }
      : { title: guideDocs.get(guideSlugs[i - 1]).title, href: `${guideSlugs[i - 1]}/` };
  const next =
    i === guideSlugs.length - 1
      ? { title: "Coding agents", href: "coding-agents/index.html" }
      : { title: guideDocs.get(guideSlugs[i + 1]).title, href: `${guideSlugs[i + 1]}/` };
  fs.mkdirSync(path.join(outDir, slug), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, slug, "index.html"),
    contentPage(doc, { pager: { prev, next }, root: "../", currentKey: slug }),
  );
});
flatDocs.forEach((doc) =>
  fs.writeFileSync(
    path.join(outDir, `${doc.slug}.html`),
    contentPage(doc, { pager: null, root: "", currentKey: doc.slug }),
  ),
);
fs.writeFileSync(path.join(outDir, "index.html"), landingPage());
fs.writeFileSync(path.join(outDir, "search-index.json"), JSON.stringify(searchIndex));
for (const asset of ["docs.css", "docs.js"]) {
  fs.copyFileSync(path.join(assetsDir, asset), path.join(outDir, asset));
}
// Favicon + the agent guides' brand mark (they reference ../icon.png).
fs.copyFileSync(path.join(repoRoot, "web/public/icon.png"), path.join(outDir, "icon.png"));

console.log(
  `docs: rendered ${guideSlugs.length + flatDocs.length + 1} pages into ${outDir}`,
);
