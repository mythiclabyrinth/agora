/* Non-destructive visual smoke review against a populated local preview.
   AGORA_BASE=http://127.0.0.1:5193 AGORA_TOKEN=… node web/e2e/appearance.mjs
   No messages, memberships, credentials, or connections are written. */
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const base = process.env.AGORA_BASE || "http://127.0.0.1:5193";
const token = process.env.AGORA_TOKEN;
if (!token) throw new Error("AGORA_TOKEN is required");
const output = mkdtempSync(join(tmpdir(), "agora-web-appearance-"));
console.log(`Review artifacts: ${output}`);
const browser = await chromium.launch();
const failures = [];
let checked = 0;
const sizes = [[1440, 960], [1024, 768], [834, 1194], [768, 1024], [390, 844], [320, 568]];

async function review(theme, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light", hasTouch: width <= 1024 });
  await context.addInitScript(theme => localStorage.setItem("agora_appearance", theme), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const capture = async name => {
    await page.waitForTimeout(180);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, `${name}: page overflows at ${width}px`);
    for (const panel of await page.locator('.conn-panel:visible, .ago-search-panel:visible, .ago-access-popover:visible, #agora-members-pane:visible').all()) {
      const box = await panel.boundingBox();
      assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `${name}: panel outside viewport`);
      assert.ok(box.y >= -1 && box.y + box.height <= height + 1, `${name}: panel exceeds available height`);
    }
    if ([1440, 834, 390].includes(width)) await page.screenshot({ path: join(output, `${theme}-${width}-${name}.png`) });
    checked++;
  };
  const toolbar = async id => {
    if (width <= 820) await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
    await page.locator(id).click();
  };
  const side = async () => {
    if (width <= 820 && !await page.locator("#agora-side").isVisible()) {
      const threadBack = page.locator("#agora-thread:visible .ago-back");
      if (await threadBack.count()) await threadBack.click();
      await page.locator("#agora-main:visible .ago-back").click();
    }
  };
  try {
    await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
    await page.locator(".ago-chan-name").first().waitFor();
    await capture("channel");
    if (width <= 820) await page.getByRole("button", { name: "Channel actions", exact: true }).click();
    await page.getByRole("button", { name: "Members", exact: true }).click();
    await capture("participants-channel");
    await page.getByRole("tab", { name: "Whole group", exact: true }).click();
    await capture("participants-group");
    await page.getByRole("button", { name: "＋ Add person", exact: true }).click();
    const person = page.locator(".ago-member-add-flow .ago-add-option").first();
    if (await person.count()) {
      await person.click();
      const form = page.locator(".ago-membership-form");
      const before = await form.boundingBox();
      await page.getByRole("button", { name: "Choose access", exact: true }).click();
      await capture("participant-access-select");
      const after = await form.boundingBox();
      assert.equal(Math.round(before.height), Math.round(after.height), "Access selector changed form height");
      await page.getByRole("button", { name: "Done", exact: true }).click();
    }
    await page.getByTitle("Close members", { exact: true }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await capture("attachments");
    await page.getByTitle("Close attachments", { exact: true }).click();
    await side();
    for (const name of ["Platform Infra", "Book Club"]) {
      const button = page.getByRole("button", { name: `Expand ${name}`, exact: true });
      if (await button.count()) await button.click();
    }
    assert.ok(await page.locator(".ago-group.open").count() >= 3, "Multiple groups cannot stay expanded");
    await capture("multiple-groups");
    await page.locator(".ago-inbox-item").click();
    await capture("inbox-unreads");
    await page.getByRole("tab", { name: "Threads", exact: true }).click();
    await capture("inbox-threads");
    const thread = page.locator(".ago-inbox-main").first();
    if (await thread.count()) { await thread.click(); await capture("thread"); }
    await toolbar("#btn-settings");
    await capture("settings-appearance");
    await page.getByRole("tab", { name: "Workspace", exact: true }).click();
    await capture("settings-workspace");
    await page.getByRole("tab", { name: "Features", exact: true }).click();
    await capture("settings-features");
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    await capture("settings-credentials");
    await page.keyboard.press("Escape");
    await toolbar("#btn-people");
    await capture("people");
    await page.locator("#users-panel .conn-body").evaluate(element => element.scrollTop = element.scrollHeight);
    await capture("people-invites");
    await page.keyboard.press("Escape");
    await toolbar("#btn-connections");
    await capture("connections");
    await page.locator(".agent-directory-card").first().waitFor();
    await capture("agents");
    await page.locator(".agent-directory-card").first().click();
    await page.getByRole("dialog", { name: "Agent profile", exact: true }).waitFor();
    await capture("agent-profile");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#conn-panel").isVisible(), true, "Closing profile also closed Connections");
    const manage = page.getByRole("button", { name: "Manage access", exact: true }).first();
    if (await manage.count()) { await manage.click(); await capture("connection-access"); }
    await page.getByRole("tab", { name: "Add agent", exact: true }).click();
    await capture("add-agent");
    for (const kind of ["Pantheo instance", "Hermes", "OpenClaw", "Coding agents"]) {
      await page.getByRole("button", { name: new RegExp(kind) }).first().click();
      await capture(`add-${kind.toLowerCase().replaceAll(" ", "-")}`);
      if (kind === "Coding agents") {
        for (const name of ["Codex CLI", "Cursor CLI", "Claude Code"]) {
          await page.getByRole("button", { name: new RegExp(name) }).first().click();
          await capture(`setup-${name.toLowerCase().replaceAll(" ", "-")}`);
          await page.getByRole("tab", { name: "Add agent", exact: true }).click();
          await page.getByRole("button", { name: /Coding agents/ }).first().click();
        }
      }
      await page.getByRole("tab", { name: "Add agent", exact: true }).click();
    }
    await page.getByRole("button", { name: "Close agents", exact: true }).click();
    await page.getByRole("button", { name: "Search conversations", exact: true }).click();
    await page.locator("#ago-search-input").fill("roadmap");
    await page.waitForTimeout(400);
    await capture("search");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, [], "Browser runtime errors");
    console.log(`PASS ${theme} ${width}×${height}`);
  } finally { await context.close(); }
}

try {
  for (const theme of ["light", "dark"]) for (const [width, height] of sizes) {
    try { await review(theme, width, height); }
    catch (error) { const failure = `${theme} ${width}: ${String(error.message).replaceAll(token, "[redacted]")}`; failures.push(failure); console.error(failure); }
  }
} finally { await browser.close(); }
console.log(`${checked} screen checks; screenshots: ${output}`);
for (const failure of failures) console.error(failure);
if (failures.length) process.exitCode = 1;
