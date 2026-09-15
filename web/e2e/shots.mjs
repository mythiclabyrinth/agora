/* Screenshot harness: gives a terminal-only agent eyes on the web UI.

   Drives the real app (served from web/dist by a local agora-server) or the
   Storybook catalog with Playwright and writes PNGs to a directory the agent
   can open. Every flow is a named recipe below, so a run is reproducible and
   the file names stay stable across before/after comparisons.

   Usage:
     node web/e2e/shots.mjs app                      # every app flow, every viewport
     node web/e2e/shots.mjs app --only=thread,search --viewport=phone
     node web/e2e/shots.mjs stories                  # every Storybook story, desktop
     node web/e2e/shots.mjs stories --only=sidebar --viewport=phone,desktop
     node web/e2e/shots.mjs url http://127.0.0.1:4470/threads --name=inbox
     node web/e2e/shots.mjs list                     # print flow + story ids, take nothing

   Env:
     AGORA_BASE   app origin        (default http://127.0.0.1:4470)
     AGORA_TOKEN  admin key         (required for `app`; signs the session in)
     AGORA_SB     Storybook origin  (default http://127.0.0.1:6006)
     SHOTS_DIR    output directory  (default /tmp/agora-ui-shots)
     SHOTS_TAG    subdirectory under SHOTS_DIR, e.g. `before` / `after`
     PW_ENGINE    chromium (default) or webkit
     PW_WS        optional matching Playwright server WebSocket endpoint
     PW_DIR       dir containing node_modules/playwright (default: resolve normally)
*/

import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pwPath = process.env.PW_DIR ? `${process.env.PW_DIR}/node_modules/playwright` : "playwright";
const { chromium, webkit } = require(pwPath);
const browserType = process.env.PW_ENGINE === "webkit" ? webkit : chromium;

const BASE = process.env.AGORA_BASE || "http://127.0.0.1:4470";
const SB = process.env.AGORA_SB || "http://127.0.0.1:6006";
const TOKEN = process.env.AGORA_TOKEN || "";
const PW_WS = process.env.PW_WS || "";
const OUT_ROOT = process.env.SHOTS_DIR || "/tmp/agora-ui-shots";
const OUT = process.env.SHOTS_TAG ? join(OUT_ROOT, process.env.SHOTS_TAG) : OUT_ROOT;

/* Playwright context options — the viewport must be nested, and `isMobile`
   is what makes the narrow CSS behave like a real phone (touch, no hover). */
const VIEWPORTS = {
  narrow: { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  short: { viewport: { width: 390, height: 430 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  landscape: { viewport: { width: 740, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  },
  tablet: {
    viewport: { width: 834, height: 1112 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
};

const args = process.argv.slice(2);
const mode = args[0] || "app";
const positional = args.slice(1).filter(a => !a.startsWith("--"));
const flag = (name, fallback = "") => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const only = flag("only").split(",").map(s => s.trim()).filter(Boolean);
const viewportNames = (flag("viewport") || (mode === "stories" ? "desktop" : "phone,desktop"))
  .split(",").map(s => s.trim()).filter(Boolean);
const fullPage = args.includes("--full-page");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

/* ---------- app flows ----------
   Each flow gets a fresh page already signed in at `/`. `wide` flows are
   skipped on phone-sized viewports where the UI has no such surface. */
const FLOWS = [
  {
    id: "channel-tools",
    what: "expanded channel toolbar on compact screens",
    async run(page) { await settle(page); await revealChannelTools(page); },
  },
  {
    id: "channel",
    what: "channel view: sidebar, message log, composer",
    async run(page) { await settle(page); },
  },
  {
    id: "channel-hover",
    what: "message row with its action disclosure revealed",
    async run(page) {
      await settle(page);
      const row = page.locator(".ago-msg, .bubble").first();
      if (await row.count()) await row.hover();
      await sleep(250);
    },
  },
  {
    id: "message-actions",
    what: "message More menu, with primary actions included on touch screens",
    async run(page) {
      await settle(page);
      const bubble = page.locator(".bubble").first();
      await bubble.hover();
      await bubble.getByRole("button", { name: "More message actions", exact: true }).click();
    },
  },
  {
    id: "thread",
    what: "thread pane open beside the channel",
    async run(page) {
      await settle(page);
      const bubble = page.locator(".bubble").first();
      await bubble.hover();
      if ((page.viewportSize()?.width || 1440) <= 820) await bubble.getByRole("button", { name: "More message actions" }).click();
      const opener = bubble.getByRole("button", { name: "Reply in thread", exact: true });
      if (await opener.count()) { await opener.click(); await sleep(600); }
    },
  },
  {
    id: "inbox",
    what: "threads inbox",
    async run(page) { await page.goto(`${BASE}/threads`); await settle(page); },
  },
  {
    id: "search",
    what: "search overlay with results",
    async run(page) {
      await settle(page);
      await ensureSidebar(page);
      await page.locator(".ago-side-toggle.search").click();
      await page.waitForSelector("#ago-search-input", { timeout: 8000 });
      await page.fill("#ago-search-input", "seed");
      await sleep(1200);
    },
  },
  {
    id: "group",
    what: "group overview page",
    async run(page) {
      await settle(page);
      await ensureSidebar(page);
      const head = page.locator(".ago-group-head .ago-group-name, .ago-group-head").first();
      if (await head.count()) { await head.click(); await sleep(600); }
    },
  },
  {
    id: "members",
    what: "members panel",
    async run(page) {
      await settle(page);
      await revealChannelTools(page);
      const btn = page.locator(".ago-channel-tools").getByRole("button", { name: "Members", exact: true });
      if (await btn.count()) { await btn.click(); await sleep(500); }
    },
  },
  {
    id: "files",
    what: "attachment browser",
    async run(page) {
      await settle(page);
      await revealChannelTools(page);
      const btn = page.locator(".ago-channel-tools").getByRole("button", { name: "Files", exact: true });
      if (await btn.count()) { await btn.click(); await sleep(500); }
    },
  },
  {
    id: "composer-typing",
    what: "composer with text, mention autocomplete range",
    async run(page) {
      await settle(page);
      const box = page.locator(".chat-input textarea").first();
      if (await box.count()) {
        await box.click();
        await box.type("A longer draft message that wraps onto a second line so the composer grows", { delay: 4 });
        await sleep(300);
      }
    },
  },
  {
    id: "emoji",
    what: "emoji picker anchored to a message",
    async run(page) {
      await settle(page);
      const row = page.locator(".bubble").first();
      await row.hover();
      if ((page.viewportSize()?.width || 1440) <= 820) await row.getByRole("button", { name: "More message actions" }).click();
      await row.getByRole("button", { name: "Add reaction", exact: true }).click();
      await page.locator("#ago-emoji-search").waitFor({ state: "visible" });
    },
  },
  {
    id: "sidebar",
    what: "phone drill-down: the group/channel list column",
    async run(page) {
      await settle(page);
      // `.ago-back` only exists on narrow viewports; desktop already shows it.
      const back = page.locator(".agora-main .ago-back").first();
      if (await back.count() && await back.isVisible()) { await back.click(); await sleep(500); }
    },
  },
  {
    id: "people",
    what: "people / invites panel",
    async run(page) { await settle(page); await openTopbarPanel(page, "#btn-people"); },
  },
  {
    id: "connections",
    what: "agent connections panel",
    async run(page) { await settle(page); await openTopbarPanel(page, "#btn-connections"); },
  },
  {
    id: "settings",
    what: "AI settings panel",
    async run(page) { await settle(page); await openTopbarPanel(page, "#btn-settings"); },
  },
  {
    id: "rename",
    what: "display-name prompt dialog",
    async run(page) { await settle(page); await openTopbarPanel(page, "#topbar-me"); },
  },
  {
    id: "signed-out",
    what: "auth gate as a signed-out visitor sees it",
    signedOut: true,
    async run(page) { await sleep(600); },
  },
];

/* The operator buttons live directly in the topbar, so click them by id —
   clicking through a menu first opens an overlay that swallows the pointer. */
async function revealChannelTools(page) {
  const toggle = page.getByRole("button", { name: "Channel actions", exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
}

async function openTopbarPanel(page, selector) {
  const btn = page.locator(selector).first();
  if (!(await btn.count())) return false;
  if (!(await btn.isVisible())) await page.getByRole("button", { name: "Manage", exact: true }).click();
  await btn.click();
  await sleep(700);
  return true;
}

/* Narrow viewports show one column at a time; anything that lives in the
   sidebar needs the drill-down stepped back first. */
async function ensureSidebar(page) {
  const side = page.locator(".agora-side").first();
  if (await side.isVisible().catch(() => false)) return;
  const back = page.locator(".agora-main .ago-back").first();
  if (await back.count() && await back.isVisible()) { await back.click(); await sleep(500); }
}

async function settle(page) {
  await page.waitForSelector(".agora-layout, #auth-gate", { timeout: 15000 }).catch(() => {});
  await sleep(700);
}

async function shoot(page, name, viewport) {
  const file = join(OUT, `${slug(name)}--${viewport}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log(`  ${file}`);
  return file;
}

async function storyIds() {
  const res = await fetch(`${SB}/index.json`);
  if (!res.ok) throw new Error(`Storybook index: ${res.status} — is it running on ${SB}?`);
  const index = await res.json();
  return Object.values(index.entries || {})
    .filter(e => e.type === "story")
    .map(e => ({ id: e.id, title: e.title, name: e.name }));
}

async function main() {
  if (mode === "list") {
    console.log("app flows:");
    for (const f of FLOWS) console.log(`  ${f.id.padEnd(16)} ${f.what}`);
    console.log(`\nstories on ${SB}:`);
    for (const s of await storyIds()) console.log(`  ${s.id.padEnd(48)} ${s.title} / ${s.name}`);
    return;
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // A sandbox that forbids spawning Chromium can still drive a browser that
  // someone else started: point PW_WS at a `playwright run-server` endpoint
  // and the browser runs there while the screenshots are written here.
  const browser = PW_WS ? await browserType.connect(PW_WS) : await browserType.launch();
  const taken = [];

  try {
    for (const vpName of viewportNames) {
      const vp = VIEWPORTS[vpName];
      if (!vp) throw new Error(`unknown viewport: ${vpName} (have ${Object.keys(VIEWPORTS)})`);
      const context = await browser.newContext({ ...vp, colorScheme: "dark" });

      if (mode === "app") {
        if (!TOKEN) throw new Error("AGORA_TOKEN required for app shots");
        const flows = FLOWS.filter(f => !only.length || only.some(o => f.id.includes(o)));
        // Sign in once per context, and land on a channel that actually has
        // history — the remembered selection is localStorage, so every later
        // page in this context opens there.
        const warm = await context.newPage();
        await warm.goto(`${BASE}/?token=${TOKEN}`);
        await settle(warm);
        // A phone auto-drills into the first channel on load, so step back to
        // the list column before picking the seeded channel.
        const back = warm.locator(".agora-main .ago-back").first();
        if (await back.count() && await back.isVisible()) { await back.click(); await sleep(400); }
        const seeded = warm.locator(`.ago-chan:has-text("${flag("channel", "general")}")`).first();
        if (await seeded.count() && await seeded.isVisible()) { await seeded.click(); await sleep(900); }
        else console.error("  !! could not select the seeded channel; using the default selection");
        await warm.close();
        for (const flow of flows) {
          const page = await context.newPage();
          if (flow.signedOut) await page.context().clearCookies();
          await page.goto(flow.signedOut ? `${BASE}/?signout=1` : BASE);
          if (flow.signedOut) await page.evaluate(() => localStorage.clear()).catch(() => {});
          if (flow.signedOut) await page.goto(BASE);
          const errors = [];
          page.on("pageerror", e => errors.push(String(e)));
          try {
            await flow.run(page);
            taken.push({ file: await shoot(page, `app-${flow.id}`, vpName), what: flow.what, errors });
          } catch (e) {
            console.error(`  !! ${flow.id}: ${e.message}`);
          }
          await page.close();
        }
      } else if (mode === "stories") {
        const stories = (await storyIds())
          .filter(s => !only.length || only.some(o => s.id.includes(o.toLowerCase())));
        const page = await context.newPage();
        for (const s of stories) {
          await page.goto(`${SB}/iframe.html?id=${s.id}&viewMode=story`);
          await page.waitForSelector("#storybook-root > *", { timeout: 15000 }).catch(() => {});
          await sleep(500);
          taken.push({ file: await shoot(page, `story-${s.id}`, vpName), what: `${s.title} / ${s.name}` });
        }
        await page.close();
      } else if (mode === "url") {
        const target = positional[0];
        if (!target) throw new Error("url mode needs a URL");
        const page = await context.newPage();
        await page.goto(target);
        await sleep(Number(flag("wait", "1500")));
        taken.push({ file: await shoot(page, flag("name", "url"), vpName), what: target });
        await page.close();
      } else {
        throw new Error(`unknown mode: ${mode}`);
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  writeFileSync(join(OUT, "index.json"), JSON.stringify(taken, null, 2));
  const errored = taken.filter(t => t.errors && t.errors.length);
  if (errored.length) {
    console.log("\npage errors:");
    for (const t of errored) console.log(`  ${t.file}: ${t.errors.join(" | ")}`);
  }
  console.log(`\n${taken.length} shots in ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
