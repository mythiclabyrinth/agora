/* Non-destructive docked-thread resizing and responsive header checks. */
import { chromium, webkit } from "playwright";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const base = process.env.AGORA_BASE || "http://127.0.0.1:5193";
const token = process.env.AGORA_TOKEN;
if (!token) throw new Error("AGORA_TOKEN is required");
const output = mkdtempSync(join(tmpdir(), "agora-thread-resize-"));
console.log(`Review artifacts: ${output}`);
for (const engine of [chromium, webkit]) {
  if (!existsSync(engine.executablePath())) continue;
  const browser = await engine.launch();
  try {
    for (const color of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: color });
      await context.addInitScript(color => localStorage.setItem("agora_appearance", color), color);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
      await page.locator(".ago-side-thread").first().click();
      const pane = page.locator("#agora-thread");
      const divider = page.getByRole("separator", { name: "Resize thread panel" });
      await divider.waitFor();
      const input = page.locator("#ago-thread-msg");
      await input.fill("Keep this unsent reply while resizing");
      const originalInput = await input.elementHandle();
      const oldWidth = (await pane.boundingBox()).width;
      const rect = await divider.boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 150);
      await page.mouse.down();
      await page.mouse.move(rect.x - 100, rect.y + 150, { steps: 16 });
      await page.mouse.up();
      const wider = (await pane.boundingBox()).width;
      assert.ok(wider > oldWidth + 90, "Dragging did not widen thread");
      assert.equal(await originalInput.evaluate(node => node.isConnected), true, "Resizing remounted composer");
      assert.equal(await input.inputValue(), "Keep this unsent reply while resizing");
      assert.equal(Number(await page.evaluate(() => localStorage.getItem("agora_thread_width"))), Math.round(wider));
      await divider.focus();
      await page.keyboard.press("Home");
      assert.equal(Math.round((await pane.boundingBox()).width), 320);
      const head = pane.locator(".ago-head");
      const title = await head.locator(".ago-head-text").boundingBox();
      const actions = await head.locator(".ago-head-actions").boundingBox();
      assert.ok(actions.y < title.y + title.height && title.y < actions.y + actions.height, "Header actions wrapped below title");
      assert.equal(await head.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, "Minimum-width header overflows");
      await page.screenshot({ path: join(output, `${engine.name()}-${color}-minimum.png`) });
      await page.keyboard.press("ArrowLeft");
      assert.equal(Math.round((await pane.boundingBox()).width), 344);
      await page.reload();
      await divider.waitFor();
      assert.equal(Math.round((await pane.boundingBox()).width), 344, "Width not restored after reload");
      await page.getByTitle("Expand thread to full width", { exact: true }).click();
      assert.equal(await divider.count(), 0);
      await page.getByTitle("Shrink thread back to the side panel", { exact: true }).click();
      await divider.waitFor();
      assert.equal(Math.round((await pane.boundingBox()).width), 344);
      await divider.dblclick();
      assert.equal(await page.evaluate(() => localStorage.getItem("agora_thread_width")), null);
      for (const width of [1101, 1024, 834, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (width <= 1100) assert.equal(await divider.isVisible(), false, "Touch/narrow layout offers resizing");
        if (width <= 820) {
          assert.equal(Math.round((await pane.boundingBox()).width), width);
          assert.equal(await page.locator("#agora-main").isVisible(), false);
          assert.equal(await page.getByTitle("Expand thread to full width", { exact: true }).isVisible(), false);
        }
      }
      await page.screenshot({ path: join(output, `${engine.name()}-${color}-phone.png`) });
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${engine.name()} ${color}: drag, keyboard, persistence, draft preservation, reset, compact header, expanded/mobile widths`);
    }
  } catch (error) {
    console.error(`${engine.name()}: ${String(error.message).replaceAll(token, "[redacted]")}`);
    process.exitCode = 1;
  } finally { await browser.close(); }
}
