/* Responsive interaction gate against the local seeded preview (never production).
   AGORA_BASE + AGORA_TOKEN select the server; PW_WS optionally reuses a browser.
   Set PW_ENGINE=webkit with its matching PW_WS endpoint for WebKit checks.
   Run after building web/dist and seeding the preview with parity.mjs.
   No messages are sent and no membership/settings changes are made. */
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
const browserType = process.env.PW_ENGINE === "webkit" ? webkit : chromium;

const base = process.env.AGORA_BASE;
const token = process.env.AGORA_TOKEN;
if (!base || !token) throw new Error("Set AGORA_BASE and AGORA_TOKEN to the seeded local preview");
const browser = process.env.PW_WS
  ? await browserType.connect(process.env.PW_WS)
  : await browserType.launch({ headless: true });

try {
  for (const width of [320, 390, 768, 1440]) {
    const mobile = width <= 820;
    const context = await browser.newContext({
      viewport: { width, height: mobile ? 640 : 900 }, isMobile: mobile, hasTouch: mobile,
    });
    try {
      const page = await context.newPage();
      const fits = async (locator, label) => {
        const box = await locator.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1, `${label} exceeds ${width}px viewport`);
      };
      await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
      await page.locator(".agora-main .ago-head").waitFor();
      const back = page.locator(".agora-main .ago-back").first();
      if (await back.isVisible()) await back.click();
      await page.locator('.ago-chan:has-text("general")').first().click();
      const message = page.locator(".bubble").first();
      await message.hover();
      if (mobile) await message.getByRole("button", { name: "More message actions" }).click();
      await message.getByRole("button", { name: "Add reaction", exact: true }).click();
      await page.locator("#ago-emoji-search").waitFor({ state: "visible" });
      await fits(page.locator(".ago-emoji-pop"), "Reaction picker");
      if (mobile) {
        // Emulate the visual-only shrink used by on-screen keyboards. Changing
        // the layout viewport alone does not exercise this browser behavior.
        await page.evaluate(() => {
          Object.defineProperty(visualViewport, "height", { configurable: true, value: 430 });
          visualViewport.dispatchEvent(new Event("resize"));
        });
        await page.waitForFunction(() =>
          document.querySelector("main").getBoundingClientRect().height <= 431 &&
          document.querySelector(".ago-emoji-pop").getBoundingClientRect().bottom <= 431);
        await page.evaluate(() => {
          delete visualViewport.height;
          visualViewport.dispatchEvent(new Event("resize"));
        });
      }
      await page.locator(".brand").click();
      await page.locator(".ago-emoji-pop").waitFor({ state: "hidden" });

      const input = page.locator(".agora-main textarea").last();
      await input.fill("Responsive preview draft");
      if (mobile) {
        await page.getByLabel("More composer tools").click();
        await fits(page.locator(".ago-composer-extra-options"), "Composer tools");
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width, height: 430 });
        await input.focus();
        const send = page.locator(".agora-main .chat-input").getByRole("button", { name: "Send", exact: true });
        await fits(send, "Send");
        assert((await send.boundingBox()).y + (await send.boundingBox()).height <= 430, "Send is below the viewport");
      }
      await page.goto(`${base}/threads`);
      await page.getByRole("button", { name: "Thread options" }).first().click();
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await fits(page.getByRole("dialog"), "Rename dialog");
      await page.keyboard.press("Escape");
      console.log(`PASS ${width}px: reactions, composer tools, Send, inbox rename`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
