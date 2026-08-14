/* Regression harness: drives the Agora web UI (served from web/dist)
   through its core flows with selector-only Playwright.

   Usage:
     AGORA_TOKEN=<admin key> node web/e2e/parity.mjs [appPath]
   Env:
     AGORA_BASE   server origin      (default http://127.0.0.1:4470)
     AGORA_TOKEN  admin key          (required)
     PW_DIR       dir containing node_modules/playwright (default: resolve normally)
   The server must be fresh-ish; seeding is idempotent by group name. */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pwPath = process.env.PW_DIR
  ? `${process.env.PW_DIR}/node_modules/playwright`
  : "playwright";
const { chromium } = require(pwPath);

const BASE = process.env.AGORA_BASE || "http://127.0.0.1:4470";
const TOKEN = process.env.AGORA_TOKEN;
const APP_PATH = process.argv[2] || "/";
if (!TOKEN) { console.error("AGORA_TOKEN required"); process.exit(2); }

const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const api = async (path, body, method) => {
  const res = await fetch(BASE + path, {
    method: method || (body ? "POST" : "GET"),
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

/* ---------- seed (idempotent by group name) ---------- */
const SEED = {};
async function seed() {
  const groups = (await api("/api/groups")).groups;
  let g = groups.find(x => x.name === "Parity");
  if (!g) {
    g = await api("/api/groups", { name: "Parity" });
    const c = await api(`/api/groups/${g.id}/channels`, { name: "general" });
    await api(`/api/groups/${g.id}/channels`, { name: "second", topic: "the second channel" });
    SEED.channel = c.id;
    // plain + markdown messages
    await api(`/api/channels/${c.id}/messages`, { text: "seed plain message one" });
    await api(`/api/channels/${c.id}/messages`, {
      text: "seed **bold** and `code` and a [link](https://example.com/x)",
    });
    // a thread with replies
    const root = await api(`/api/channels/${c.id}/messages`, { text: "seed thread root alpha" });
    SEED.threadRoot = root.id;
    for (let i = 1; i <= 3; i++) {
      const reply = await api(`/api/channels/${c.id}/messages`, {
        text: `seed reply ${i}`, thread_id: root.id,
      });
      if (i === 2) SEED.threadReply = reply.id;
    }
    // several more threads so the inbox has rows
    for (let i = 2; i <= 6; i++) {
      const r = await api(`/api/channels/${c.id}/messages`, { text: `seed thread root ${i}` });
      await api(`/api/channels/${c.id}/messages`, { text: "one reply", thread_id: r.id });
    }
    // searchable needle
    await api(`/api/channels/${c.id}/messages`, { text: "xyzzy-needle for search parity" });
  } else {
    const c = g.channels.find(x => x.name === "general");
    SEED.channel = c.id;
    const threads = (await api("/api/threads")).threads;
    const t = threads.find(t => t.root.text === "seed thread root alpha");
    SEED.threadRoot = t ? t.root.id : null;
    if (SEED.threadRoot) {
      const replies = (await api(
        `/api/channels/${c.id}/messages?thread_id=${SEED.threadRoot}&limit=100`,
      )).messages;
      SEED.threadReply = replies.find(m => m.text === "seed reply 2")?.id;
    }
  }
  SEED.group = g.id;
}

/* ---------- check runner ---------- */
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
  }
}

const appUrl = q => BASE + APP_PATH + (q || "");

async function main() {
  await seed();
  const browser = await chromium.launch();

  /* -- 1. auth gate + manual key submit (fresh context, no token) -- */
  await check("auth: gate shows without token and accepts the admin key", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(appUrl());
    await page.waitForSelector(".auth-card #auth-token", { timeout: 10000 });
    await page.fill("#auth-token", TOKEN);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => (document.getElementById("topbar-me")?.textContent || "").trim().length > 0,
      { timeout: 10000 });
    await ctx.close();
  });

  /* -- main context: token via URL -- */
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  await check("auth: ?token= is consumed and stripped from the URL", async () => {
    await page.goto(appUrl(`?token=${TOKEN}`));
    await page.waitForFunction(
      () => (document.getElementById("topbar-me")?.textContent || "").trim().length > 0,
      { timeout: 10000 });
    if (page.url().includes("token=")) throw new Error(`token still in URL: ${page.url()}`);
    const stored = await page.evaluate(() => localStorage.getItem("agora_token"));
    if (stored !== TOKEN) throw new Error("token not in localStorage");
  });

  await check("sidebar: group renders, expands, channel selects", async () => {
    await page.waitForSelector(".ago-group-head", { timeout: 10000 });
    const group = page.locator(".ago-group", { hasText: "Parity" }).first();
    // expand if collapsed
    if (!(await group.locator(".ago-chan").count())) {
      await group.locator(".ago-caret").click();
    }
    await page.waitForSelector(".ago-chan", { timeout: 5000 });
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.waitForSelector(".ago-chan.active", { timeout: 5000 });
    await page.waitForSelector("#ago-log .bubble", { timeout: 5000 });

    const channel = page.locator(".ago-chan", { hasText: "general" }).first();
    const caret = channel.locator(".ago-chan-caret");
    const channelThreads = page.locator(`#ago-channel-threads-${SEED.channel} .ago-side-thread`);
    await channelThreads.first().waitFor({ timeout: 5000 });
    await caret.click();
    if (!(await channel.evaluate(el => el.classList.contains("active")))) {
      throw new Error("thread disclosure navigated away from the active channel");
    }
    if (await channelThreads.count()) throw new Error("collapsed channel still shows threads");
    await page.reload();
    await page.waitForSelector(".ago-chan.active", { timeout: 10000 });
    if (await page.locator(`#ago-channel-threads-${SEED.channel} .ago-side-thread`).count()) {
      throw new Error("collapsed channel state did not survive reload");
    }
    const restoredChannel = page.locator(".ago-chan", { hasText: "general" }).first();
    await restoredChannel.locator(".ago-chan-caret").click();
    await page.locator(`#ago-channel-threads-${SEED.channel} .ago-side-thread`).first().waitFor({ timeout: 5000 });

    // The sidebar surfaces at most 5 threads, newest first.
    const sideThread = page.locator(`#ago-channel-threads-${SEED.channel} .ago-side-thread`).first();
    await sideThread.hover();
    await sideThread.locator('button[title="Rename this thread"]').click();
    const rename = page.getByRole("dialog", { name: "Rename thread" });
    // Saving blank exercises the mutation while preserving the seed name for
    // later inbox checks (blank resets the alias to the root's first line).
    await rename.getByLabel("Thread name").fill("");
    await rename.getByRole("button", { name: "Save" }).click();
    await rename.waitFor({ state: "detached" });
  });

  await check("agent DMs: admin publishes an agent, opens a private conversation, and posts", async () => {
    const pairing = await api("/api/pairing", { name: "parity-dm", kind: "codex" });
    await page.evaluate(({ base, token }) => new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace(/^http/, "ws") + `/agent/ws?token=${encodeURIComponent(token)}`);
      window.__parityAgent = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "hello", agents: [{ id: "parity-agent", name: "Parity Agent", requires_mention: true }] }));
        resolve();
      };
      ws.onerror = () => reject(new Error("agent websocket failed"));
    }), { base: BASE, token: pairing.token });
    await page.waitForFunction(async () => {
      const token = localStorage.getItem("agora_token");
      const res = await fetch("/api/agents", { headers: { Authorization: `Bearer ${token}` } });
      return res.ok && (await res.json()).agents.some(a => a.id === "parity-agent");
    });
    await api("/api/admin/agents/parity-agent/dm-policy", { is_public: true, grants: [] }, "PUT");
    await page.reload();
    const dmGroup = page.locator(".ago-group", { hasText: "Direct messages" }).first();
    const visibleGroups = page.locator(".ago-groups > .ago-group");
    if ((await visibleGroups.last().innerText()).includes("Direct messages") === false) throw new Error("Direct messages was not pinned as the last group");
    if (!(await dmGroup.locator(".ago-add").count())) await dmGroup.locator(".ago-caret").click();
    await dmGroup.locator(".ago-add", { hasText: "Agent" }).click();
    await page.locator(".ago-dm-agent", { hasText: "Parity Agent" }).click();
    await page.waitForSelector('.ago-chan.active:has-text("Parity Agent")');
    await page.fill("#ago-msg", "private parity hello");
    await page.keyboard.press("Enter");
    await page.locator("#ago-log .bubble", { hasText: "private parity hello" }).waitFor();
    await dmGroup.locator(".ago-add", { hasText: "Agent" }).click();
    if (await page.locator(".ago-dm-agent", { hasText: "Parity Agent" }).count()) throw new Error("existing DM agent remained in picker");
    await page.locator(".ago-dm-popover button", { hasText: "Close" }).click();
    await page.locator("#btn-connections").click();
    const sourceRow=page.locator("#conn-panel .conn-row",{hasText:"parity-dm"});
    await sourceRow.locator("button",{hasText:"Manage access"}).click();
    await page.locator("#conn-panel",{hasText:"Everyone on this Agora can start a direct message"}).waitFor();
    const publicSwitch = page.locator('#conn-panel [role="switch"][aria-label="Public agent direct messages"]');
    if (await publicSwitch.count() !== 1) throw new Error("Public DM policy is not exposed as a switch");
    await page.locator("#conn-panel .conn-head button").last().click();
    await page.evaluate(() => window.__parityAgent?.close());
    await api(`/api/pairing/${pairing.token}`, undefined, "DELETE");
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.waitForSelector("#ago-log .bubble");
  });

  await check("messages: seeded texts and markdown render", async () => {
    const log = page.locator("#ago-log");
    await log.locator(".bubble", { hasText: "seed plain message one" }).first().waitFor();
    const b = log.locator(".bubble", { hasText: "seed" }).filter({ has: page.locator("b", { hasText: "bold" }) }).first();
    await b.waitFor({ timeout: 5000 });
    const code = await log.locator("code", { hasText: "code" }).count();
    if (!code) throw new Error("inline code not rendered");
    const link = log.locator('a[href="https://example.com/x"]');
    if (!(await link.count())) throw new Error("md link not rendered");
    if ((await link.first().getAttribute("target")) !== "_blank") throw new Error("link target");
  });

  await check("composer: Enter posts; log sticks to bottom", async () => {
    const text = `posted from parity ${APP_PATH}`;
    await page.fill("#ago-msg", text);
    await page.keyboard.press("Enter");
    await page.locator("#ago-log .bubble", { hasText: text }).first().waitFor({ timeout: 8000 });
    const atBottom = await page.$eval("#ago-log",
      el => el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    if (!atBottom) throw new Error("log not at bottom after send");
  });

  await check("templates: create, insert at the caret, delete", async () => {
    const label = "Parity template";
    const body = "reusable parity template body";
    const openPicker = async () => {
      await page.click(".ago-template-btn");
      await page.waitForSelector(".ago-template-pop", { timeout: 5000 });
    };
    // Create one through the manage dialog.
    await openPicker();
    await page.click(".ago-template-pop .ago-template-add");
    await page.waitForSelector(".ago-template-dialog", { timeout: 5000 });
    await page.fill(".ago-template-dialog input", label);
    await page.fill(".ago-template-dialog textarea", body);
    await page.locator(".ago-template-actions .btn.primary").click();
    await page.locator(".ago-template-manage-row", { hasText: label })
      .first().waitFor({ timeout: 8000 });
    await page.locator(".ago-template-dialog button[aria-label='Close']").click();

    // Choosing it inserts at the caret without dropping the typed draft.
    await page.fill("#ago-msg", "Draft: ");
    await openPicker();
    await page.locator(".ago-template-pop .ago-template-opt", { hasText: label }).first().click();
    await page.waitForFunction(
      expected => document.getElementById("ago-msg")?.value === expected,
      `Draft: ${body}`,
      { timeout: 8000 });
    await page.fill("#ago-msg", "");

    // Delete is a two-step armed click, like the rest of the UI.
    await openPicker();
    await page.locator(".ago-template-pop .ago-template-head button").click();
    const row = page.locator(".ago-template-manage-row", { hasText: label }).first();
    await row.locator("button.danger").click();
    await row.locator("button.danger", { hasText: "Sure?" }).click();
    await page.locator(".ago-template-dialog .ago-template-manage-row", { hasText: label })
      .waitFor({ state: "detached", timeout: 8000 });
    await page.locator(".ago-template-dialog button[aria-label='Close']").click();
  });

  await check("live: message posted via API appears without reload", async () => {
    const text = `live echo ${Date.now() % 100000}`;
    await api(`/api/channels/${SEED.channel}/messages`, { text });
    await page.locator("#ago-log .bubble", { hasText: text }).first().waitFor({ timeout: 8000 });
  });

  await check("mermaid: fence renders to svg", async () => {
    await page.fill("#ago-msg", "```mermaid\ngraph TD; A-->B;\n```");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#ago-log .md-mermaid svg", { timeout: 20000 });
  });

  await check("echarts: responsive canvas opens and closes expanded viewer", async () => {
    const chart = JSON.stringify({
      title: { text: "Parity chart" }, tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: ["A", "B", "C"] }, yAxis: { type: "value" },
      series: [{ type: "bar", data: [3, 7, 5] }],
    });
    await page.fill("#ago-msg", `\`\`\`echarts\n${chart}\n\`\`\``);
    await page.keyboard.press("Enter");
    const block = page.locator("#ago-log .ago-chart-block", { hasText: "Parity chart" }).last();
    await block.locator("canvas").waitFor({ timeout: 20000 });
    await block.locator("button", { hasText: "expand" }).click();
    await page.locator(".ago-chart-overlay canvas").waitFor({ timeout: 20000 });
    await page.locator(".ago-chart-modal button[aria-label='Close chart']").click();
    await page.locator(".ago-chart-overlay").waitFor({ state: "detached", timeout: 5000 });
  });

  await check("reactions: pick emoji, chip appears, toggle off", async () => {
    const bubble = page.locator("#ago-log .bubble", { hasText: "seed plain message one" }).first();
    await bubble.hover();
    await bubble.locator(".ago-react-btn").click();
    await page.waitForSelector("#ago-emoji-pop", { timeout: 5000 });
    await page.locator("#ago-emoji-pop button").filter({ hasText: "👍" }).first().click();
    await bubble.locator(".ago-reacts .ago-react", { hasText: "👍" }).waitFor({ timeout: 8000 });
    const reaction = bubble.locator(".ago-reacts .ago-react", { hasText: "👍" });
    await reaction.hover();
    const popover = page.locator(".ago-react-pop", { hasText: "reactions" });
    await popover.waitFor({ timeout: 5000 });
    const me = await api("/api/me");
    await popover.locator("b", { hasText: me.display_name || me.username }).waitFor({ timeout: 5000 });
    await reaction.click(); // toggle off
    await page.waitForFunction(
      sel => !document.querySelector(sel),
      undefined, { timeout: 8000, polling: 200 }
    ).catch(() => {});
  });

  await check("threads: inbox lists, opens, reply works", async () => {
    await page.locator(".ago-inbox-item", { hasText: "Threads" }).click();
    await page.waitForSelector(".ago-inbox-list .ago-inbox-row", { timeout: 5000 });
    await page.locator(".ago-inbox-row", { hasText: "seed thread root alpha" }).first().click();
    await page.waitForSelector("#ago-thread-log .bubble", { timeout: 5000 });
    await page.locator("#ago-thread-log .bubble", { hasText: "seed reply 3" }).waitFor();
    await page.fill("#ago-thread-msg", "parity thread reply");
    await page.keyboard.press("Enter");
    await page.locator("#ago-thread-log .bubble", { hasText: "parity thread reply" })
      .waitFor({ timeout: 8000 });
  });

  await check("deep links: reload opens and highlights an exact thread reply", async () => {
    if (!SEED.threadRoot || !SEED.threadReply) throw new Error("seed thread unavailable");
    const path = `/g/${encodeURIComponent(SEED.group)}/c/${encodeURIComponent(SEED.channel)}` +
      `/t/${SEED.threadRoot}/m/${SEED.threadReply}`;
    await page.goto(BASE + path);
    const target = page.locator(`#ago-thread-log [data-mid="${SEED.threadReply}"]`);
    await target.waitFor({ timeout: 10000 });
    await page.waitForFunction(
      mid => document.querySelector(`#ago-thread-log [data-mid="${mid}"]`)?.classList.contains("ago-flash"),
      SEED.threadReply,
      { timeout: 5000 },
    );
    if (new URL(page.url()).pathname !== path) throw new Error(`path changed: ${page.url()}`);
    await page.waitForTimeout(1900);
    await api(`/api/channels/${SEED.channel}/messages`, { text: `deep-link latch ${Date.now()}` });
    await page.waitForTimeout(500);
    if (await target.evaluate(el => el.classList.contains("ago-flash"))) {
      throw new Error("deep-link target flashed again after a live group update");
    }
  });

  await check("history: Back restores the threads inbox", async () => {
    await page.locator(".ago-inbox-item", { hasText: "Threads" }).click();
    await page.waitForURL(/\/threads$/);
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.goBack();
    await page.waitForURL(/\/threads$/);
    await page.waitForSelector(".ago-inbox-list .ago-inbox-row", { timeout: 5000 });
  });

  await check("navigation: live updates do not close the narrow sidebar", async () => {
    await page.setViewportSize({ width: 500, height: 800 });
    await page.locator(".agora-main .ago-back").click();
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.locator(".agora-main .ago-back").click();
    await page.waitForFunction(
      () => document.getElementById("agora-layout")?.classList.contains("view-side"),
    );
    await api(`/api/channels/${SEED.channel}/messages`, {
      text: `sidebar latch ${Date.now()}`,
    });
    await page.waitForTimeout(500);
    const sideOpen = await page.$eval(
      "#agora-layout",
      el => el.classList.contains("view-side"),
    );
    if (!sideOpen) throw new Error("live update closed the narrow sidebar");
    await page.setViewportSize({ width: 1400, height: 800 });
  });

  await check("threads: pin from pane; pin bar appears in channel", async () => {
    // Be independent of the preceding history check, which intentionally
    // leaves the UI in the inbox after navigating Back.
    await page.locator(".ago-inbox-item", { hasText: "Threads" }).click();
    await page.locator(".ago-inbox-row", { hasText: "seed thread root alpha" }).first().click();
    await page.waitForSelector("#ago-thread-log .bubble", { timeout: 5000 });
    await page.locator('button[title="Pin this thread for quick access"]').first().click();
    await page.locator('.ago-pinbar .ago-pin-count', { hasText: "pinned" }).waitFor({ timeout: 8000 })
      .catch(async () => {
        // pin bar lives in the channel pane — navigate back to the channel
        await page.locator(".ago-chan", { hasText: "general" }).first().click();
        await page.locator(".ago-pinbar .ago-pin-count", { hasText: "pinned" }).waitFor({ timeout: 8000 });
      });
  });

  await check("threads: hide is two-step and preserves inbox scroll", async () => {
    await page.locator(".ago-inbox-item", { hasText: "Threads" }).click();
    await page.waitForSelector(".ago-inbox-list .ago-inbox-row", { timeout: 5000 });
    await page.$eval(".ago-inbox-list", el => { el.scrollTop = 120; });
    const before = await page.$eval(".ago-inbox-list", el => el.scrollTop);
    const row = page.locator(".ago-inbox-row", { hasText: "seed thread root 6" }).first();
    await row.hover();
    await row.locator('button.ago-x[title^="Remove"]').click();
    await page.waitForSelector(".ago-inbox-list button.ago-x.armed", { timeout: 5000 });
    const mid = await page.$eval(".ago-inbox-list", el => el.scrollTop);
    if (Math.abs(mid - before) > 2 && before > 0) throw new Error(`scroll moved on arm: ${before}->${mid}`);
    await page.locator(".ago-inbox-list button.ago-x.armed").click();
    await page.locator(".ago-inbox-row", { hasText: "seed thread root 6" })
      .waitFor({ state: "detached", timeout: 8000 });
  });

  await check("search: needle found, Escape closes", async () => {
    await page.locator(".ago-side-toggle.search").click();
    await page.waitForSelector("#ago-search-input", { timeout: 5000 });
    await page.fill("#ago-search-input", "xyzzy-needle");
    await page.locator("#ago-search-body", { hasText: "xyzzy-needle" }).waitFor({ timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const el = document.getElementById("ago-search-overlay");
      return !el || el.style.display === "none" || !el.isConnected;
    }, { timeout: 5000 });
  });

  await check("group page: channel cards + eye toggle", async () => {
    await page.locator(".ago-group-head", { hasText: "Parity" }).click();
    await page.waitForSelector(".ago-gp-chan", { timeout: 5000 });
    const card = page.locator(".ago-gp-chan", { hasText: "second" }).first();
    await card.hover();
    await card.locator("button.ago-x.show").click();
    await page.locator(".toast", { hasText: "hidden for you" }).waitFor({ timeout: 8000 });
    // restore it
    const again = page.locator(".ago-gp-chan", { hasText: "second" }).first();
    await again.hover();
    await again.locator("button.ago-x.show").click();
  });

  await check("members: panel lists me", async () => {
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.locator(".ago-head-actions button", { hasText: "Members" }).click();
    await page.waitForSelector("#agora-members-pane .ago-member", { timeout: 5000 });
    await page.locator(".ago-head-actions button", { hasText: "Members" }).click();
  });

  await check("people: invite create + revoke", async () => {
    await page.locator("#btn-people").click();
    await page.waitForSelector("#users-panel .conn-body", { timeout: 5000 });
    await page.fill("#invite-email", "parity@example.com");
    await page.locator("#users-panel button", { hasText: "Invite" }).first().click();
    await page.locator("#users-panel .conn-row", { hasText: "parity@example.com" })
      .waitFor({ timeout: 8000 });
    await page.locator("#users-panel .conn-row", { hasText: "parity@example.com" })
      .locator("button", { hasText: "Revoke" }).click();
    await page.locator("#users-panel .conn-row", { hasText: "parity@example.com" })
      .waitFor({ state: "detached", timeout: 8000 });
    await page.locator("#users-panel .conn-head button").last().click();
  });

  await check("connections: pairing token create + revoke", async () => {
    await page.locator("#btn-connections").click();
    await page.waitForSelector("#conn-panel .conn-body", { timeout: 5000 });
    // Coding CLIs live under their own category and link to complete bundled
    // guides rather than squeezing setup instructions into this modal.
    await page.locator('#conn-panel [role="tab"]', { hasText: "Add agent" }).click();
    await page.locator("#conn-panel .conn-card-select", { hasText: "Coding agents" }).click();
    await page.locator('#conn-panel a[href="/docs/coding-agents/codex.html"]')
      .waitFor({ timeout: 5000 });
    const codingCards = page.locator("#conn-panel .conn-card");
    if (await codingCards.count() !== 3) throw new Error("coding-agent picker should show three CLIs");
    for (const kind of ["codex", "cursor", "claude"]) {
      const href = await page.locator(`#conn-panel a[href="/docs/coding-agents/${kind}.html"]`).getAttribute("href");
      if (!href) throw new Error(`missing ${kind} setup guide link`);
    }
    const guidePage = await page.context().newPage();
    const guideResponse = await guidePage.goto(`${BASE}/docs/coding-agents/codex.html`);
    if (!guideResponse?.ok()) throw new Error(`Codex setup guide returned ${guideResponse?.status()}`);
    await guidePage.locator("#docs-root h1", { hasText: "Codex CLI" }).waitFor({ timeout: 5000 });
    await guidePage.close();
    await page.locator("#conn-panel button", { hasText: "All connection types" }).click();

    // Non-coding integrations still use the same access/revoke lifecycle.
    await page.locator("#conn-panel .conn-card-select", { hasText: "OpenClaw" }).click();
    await page.fill("#pair-name", "parity-tok");
    await page.locator("#conn-panel button", { hasText: "Create access" }).click();
    await page.locator("#conn-panel .conn-issued").waitFor({ timeout: 8000 });
    await page.locator("#conn-panel button", { hasText: "View connections" }).click();
    // Back on the list tab the freshly issued token is listed and revocable.
    const row = page.locator("#conn-panel .conn-row", { hasText: "parity-tok" });
    await row.waitFor({ timeout: 8000 });
    await row.locator("button", { hasText: "Revoke" }).click();
    await page.locator("#conn-panel .conn-head button").last().click();
  });

  await check("stars: hidden while pins remain available", async () => {
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    const bubble = page.locator("#ago-log .bubble", { hasText: "seed plain message one" }).first();
    await bubble.hover();
    if (await bubble.locator(".ago-star-btn").count()) throw new Error("star action should be hidden");
    if (await page.locator(".ago-head-actions .ago-star-toggle").count()) throw new Error("star list should be hidden");
    if (!(await bubble.locator(".ago-pin-btn").count())) throw new Error("pin action should remain visible");
  });

  await check("search: message hit jump-flashes the exact message", async () => {
    await page.locator(".ago-side-toggle.search").click();
    await page.fill("#ago-search-input", "xyzzy-needle");
    await page.locator(".ago-search-row.msg", { hasText: "xyzzy-needle" }).first()
      .waitFor({ timeout: 8000 });
    await page.locator(".ago-search-row.msg", { hasText: "xyzzy-needle" }).first().click();
    await page.waitForSelector("#ago-log .bubble.ago-flash", { timeout: 8000 });
  });

  await check("sidebar: drag-reorder of channels persists", async () => {
    // ensure both channel rows are visible in the sidebar
    await page.waitForSelector(".ago-chan", { timeout: 5000 });
    const before = (await api("/api/groups")).groups
      .find(g => g.name === "Parity").channels.map(c => c.name);
    await page.dragAndDrop(
      '.ago-chan:has-text("second")',
      '.ago-chan:has-text("general")',
    );
    await page.waitForTimeout(800);
    const after = (await api("/api/groups")).groups
      .find(g => g.name === "Parity").channels.map(c => c.name);
    if (JSON.stringify(after) === JSON.stringify(before)) {
      throw new Error(`order unchanged: ${after.join(",")}`);
    }
    if (after[0] !== "second") throw new Error(`expected second first, got ${after.join(",")}`);
  });

  await check("no unexpected page errors during the run", async () => {
    if (errors.length) throw new Error(errors.join(" | "));
  });

  await browser.close();
  console.log(results.join("\n"));
  console.log(failures ? `\n${failures} FAILURES` : "\nALL GREEN");
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error("HARNESS ERROR:", e); process.exit(2); });
