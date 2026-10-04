/* Read-only theme, draft, navigation, and tooltip regression checks.
   AGORA_BASE=http://127.0.0.1:5193 AGORA_TOKEN=… node web/e2e/appearance-state.mjs */
import { chromium, webkit } from "playwright";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";

const base = process.env.AGORA_BASE || "http://127.0.0.1:5193";
const token = process.env.AGORA_TOKEN;
if (!token) throw new Error("AGORA_TOKEN is required");
for (const engine of [chromium, webkit]) {
  if (!existsSync(engine.executablePath())) { console.log(`SKIP ${engine.name()}: browser is not installed`); continue; }
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const theme = (target, mode) => target.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode);
  const choose = (target, mode) => target.locator(`.appearance-option:has(input[value="${mode}"])`).click();
  try {
    await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
    await page.locator(".ago-chan").first().click();
    await theme(page, "dark");
    const composer = page.locator("#agora-main textarea");
    const draft = "Unsent appearance test — do not send";
    await composer.fill(draft);
    await page.locator("#btn-settings").click();
    for (const mode of ["light", "dark", "system"]) {
      await choose(page, mode);
      await theme(page, mode === "system" ? "light" : mode);
      assert.equal(await composer.inputValue(), draft, "Theme switching lost the draft");
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await theme(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await theme(page, "light");
    await page.keyboard.press("Control+k");
    await page.locator("#ago-search-input").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#settings-panel").isVisible(), true, "Search Escape closed underlying Settings");
    await page.keyboard.press("Escape");
    assert.equal(await composer.inputValue(), draft);

    const thread = page.locator(".ago-side-thread").first();
    if (await thread.count()) {
      const metrics = await thread.evaluate(node => {
        const css = getComputedStyle(node);
        return { padding: parseFloat(css.paddingLeft), title: node.querySelector(".nm")?.getAttribute("title") };
      });
      assert.ok(metrics.padding <= 12, "Sidebar thread indentation regressed");
      assert.ok(metrics.title, "Sidebar thread lacks a full-text tooltip");
      await thread.hover();
      assert.equal(await thread.getByTitle("Rename this thread").count(), 1, "Action tooltip was replaced");
    }

    const second = await context.newPage();
    await second.goto(base);
    await theme(second, "light");
    assert.equal(await second.evaluate(() => localStorage.getItem("agora_appearance")), "system");
    await second.locator("#btn-settings").click();
    await choose(second, "dark");
    await theme(page, "dark");
    assert.equal(await composer.inputValue(), draft, "Cross-tab appearance update lost the draft");
    await second.reload();
    await theme(second, "dark");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#agora-main .ago-back").click();
    assert.equal(await page.locator("#agora-side").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator(".ago-chan.active").click();
    assert.equal(await composer.inputValue(), draft, "Responsive navigation lost the draft");
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine.name()}: Light/Dark/System, live system changes, persistence, cross-tab sync, drafts, stacked dialogs, sidebar spacing/tooltips, mobile navigation`);
  } catch (error) {
    console.error(`${engine.name()}: ${String(error.message).replaceAll(token, "[redacted]")}`);
    process.exitCode = 1;
  } finally { await browser.close(); }
}
