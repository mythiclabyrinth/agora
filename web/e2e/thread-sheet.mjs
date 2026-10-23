/* Opt-in WebKit/Chromium visual evidence script; not run in CI.
   Built-app regression and visual evidence for the phone sheet. Run against an
   isolated server: AGORA_BASE=... AGORA_TOKEN=... node web/e2e/thread-sheet.mjs
   Requires `npx playwright install chromium webkit`. */
import { colorAlpha } from "../src/stories/colorAlpha.mjs";

import { chromium, webkit } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const base = process.env.AGORA_BASE;
assert(base, "AGORA_BASE required (source .worktree-env)");
const token = process.env.AGORA_TOKEN;
assert(token, "AGORA_TOKEN required");
const output = process.env.SHEETFIX_DIR || "/tmp/sheetfix";
await mkdir(output, { recursive: true });
const api = async (path, body) => {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const groupName = "Sheet opacity regression";
let group = (await api("/api/groups")).groups.find(item => item.name === groupName);
if (!group) group = await api("/api/groups", { name: groupName });
let channel = group.channels?.find(item => item.name === "launch-planning");
if (!channel) channel = await api(`/api/groups/${group.id}/channels`, { name: "launch-planning" });
const existing = (await api("/api/threads?limit=100")).threads.filter(thread => thread.channel_id === channel.id);
for (let index = existing.length + 1; index <= 16; index++) {
  const root = await api(`/api/channels/${channel.id}/messages`, {
    text: `Conversation ${index}: launch planning and design review`,
  });
  await api(`/api/channels/${channel.id}/messages`, { text: "Review the release checklist and discuss next steps.", thread_id: root.id });
}
const results = [];
for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
  const browser = await browserType.launch();
  try {
    for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme });
      await context.addInitScript(({ theme, groupId }) => {
        localStorage.setItem("agora_appearance", theme);
        localStorage.setItem("agora_threads_group", groupId);
      }, { theme, groupId: group.id });
      const page = await context.newPage();
      await page.goto(`${base}/inbox/threads?token=${encodeURIComponent(token)}`);
      await page.locator(".ago-inbox-row").nth(15).waitFor({ state: "attached" });
      assert(await page.locator(".ago-inbox-row").count() >= 16);
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await page.screenshot({ path: `${output}/${engine}-${theme}-list.png` });
      await page.getByRole("button", { name: /Thread filters/ }).click();
      const sheet = page.getByRole("dialog", { name: "Thread view" });
      await sheet.waitFor();
      const geometry = await sheet.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return {
          background: getComputedStyle(element).backgroundColor,
          bottom: bounds.bottom,
          width: bounds.width,
          overlappingRows: [...document.querySelectorAll(".ago-inbox-row")].filter(row => {
            const rect = row.getBoundingClientRect();
            return rect.top < bounds.bottom && rect.bottom > bounds.top;
          }).length,
          selectWidths: [...element.querySelectorAll("select")].map(select => select.getBoundingClientRect().width),
        };
      });
      assert.equal(colorAlpha(geometry.background), 1, "the sheet must be fully opaque");
      assert(geometry.overlappingRows > 0, "thread text must lie beneath the sheet");
      assert(geometry.bottom <= 845 && geometry.width <= 390);
      assert(geometry.selectWidths.length === 3 && geometry.selectWidths.every(width => width > 340));
      const screenshot = `${output}/${engine}-${theme}-sheet.png`;
      await page.screenshot({ path: screenshot });
      await sheet.getByRole("button", { name: "Done" }).click();
      await sheet.waitFor({ state: "detached" });
      results.push({ engine, theme, ...geometry, screenshot });
      await context.close();
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
