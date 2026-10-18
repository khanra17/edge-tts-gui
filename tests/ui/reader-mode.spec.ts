import { expect, test } from "@playwright/test";
import { fitsScreen, startReader } from "./harness.ts";

for (const markdown of [false, true]) {
    test(`fullscreen ${markdown ? "Markdown" : "text"} hides controls and keeps Auto Scroll available`, async ({ page }, testInfo) => {
        await page.clock.install();
        await page.setViewportSize({ width: 360, height: 640 });
        await startReader(page);
        await page.locator("#content").fill("A readable first sentence.\n\n" + "Another paragraph to read.\n\n".repeat(100));
        if (markdown) await page.locator("#markdown-toggle").click();
        await page.locator("#reader-fullscreen").click();
        const surface = page.locator(markdown ? "#markdown-preview" : "#content");
        const toolbar = page.locator("#reader-toolbar");
        await expect(page.locator("#reader-area")).toHaveAttribute("aria-modal", "true");
        await expect(page.locator("#content")).toHaveJSProperty("readOnly", true);
        expect(await surface.evaluate((node) => node.clientHeight)).toBeGreaterThan(580);
        await fitsScreen(page);
        await expect(toolbar).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("fullscreen-controls.png") });
        await page.clock.runFor(3200);
        await expect(toolbar).toBeHidden();
        await surface.dispatchEvent("touchmove");
        await expect(toolbar).toBeVisible();

        await page.locator("#reader-play").click();
        await expect(page.locator("#reader-play")).toHaveText("Pause");
        await surface.dispatchEvent("wheel", { deltaY: 200 });
        await surface.evaluate((node) => { node.scrollTop += 200; });
        await expect(page.locator("#auto-scroll-btn")).toBeVisible();
        await page.clock.runFor(3200);
        await expect(toolbar).toBeHidden();
        await expect(page.locator("#auto-scroll-btn")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("fullscreen-follow-paused.png") });
        await page.locator("#auto-scroll-btn").click();
        await expect(page.locator("#auto-scroll-btn")).toBeHidden();
        await expect(toolbar).toBeVisible();
        await page.locator("#reader-play").click();
        await expect(page.locator("#reader-play")).toHaveText("Resume");
        await page.keyboard.press("Escape");
        await expect(page.locator("#reader-overlay")).toBeHidden();
        await expect(page.locator("#content")).toHaveJSProperty("readOnly", false);
        await expect(page.locator("#play")).toHaveText("Resume");
        await expect(page.locator(".controls")).toHaveJSProperty("inert", false);
    });
}

test("fullscreen controls wake on scroll but not automatic following", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 320, height: 568 });
    await startReader(page);
    await page.locator("#content").fill("A sentence.\n\n".repeat(100));
    await page.locator("#reader-fullscreen").click();
    await page.locator("#reader-play").click();
    await page.clock.runFor(3200);
    const toolbar = page.locator("#reader-toolbar");
    await expect(toolbar).toBeHidden();
    await page.locator("#content").evaluate((node) => { node.scrollTop += 200; });
    await expect(toolbar).toBeHidden();
    await page.locator("#content").dispatchEvent("wheel", { deltaY: 200 });
    await expect(toolbar).toBeVisible();
    await fitsScreen(page);
    await page.locator("#reader-exit").click();
    await expect(page.locator("#reader-overlay")).toBeHidden();
    await page.locator("#reader-fullscreen").click();
    await page.clock.runFor(3200);
    await expect(toolbar).toBeHidden();
});

test("fullscreen adapts to rotation and tablets without sideways scrolling", async ({ page }, testInfo) => {
    await page.clock.install();
    await startReader(page);
    await page.locator("#content").fill("A document to read.\n\n".repeat(80));
    await page.locator("#markdown-toggle").click();
    await page.locator("#reader-fullscreen").click();
    for (const [width, height] of [[320, 568], [740, 360], [1024, 768]]) {
        await page.setViewportSize({ width, height });
        await page.locator("#markdown-preview").dispatchEvent("touchmove");
        const rect = await page.locator("#reader-area").boundingBox();
        expect(rect?.width).toBe(width);
        expect(rect?.height).toBe(height);
        await expect(page.locator("#reader-exit")).toBeInViewport();
        await fitsScreen(page);
        await page.screenshot({ path: testInfo.outputPath(`fullscreen-${width}.png`) });
    }
});

test("fullscreen keyboard navigation stays within the reader and stays visible", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 740, height: 580 });
    await startReader(page);
    await page.locator("#reader-fullscreen").click();
    await page.keyboard.press("Tab");
    await expect(page.locator("#content")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#reader-play")).toBeFocused();
    await page.clock.runFor(3500);
    await expect(page.locator("#reader-toolbar")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.locator("#reader-exit")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#content")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#reader-exit")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#reader-fullscreen")).toBeFocused();
});

for (const markdown of [false, true]) {
    test(`fullscreen surface taps toggle controls in ${markdown ? "Markdown" : "plain text"}`, async ({ page }) => {
        await page.clock.install();
        await page.setViewportSize({ width: 360, height: 640 });
        await startReader(page);
        await page.locator("#content").fill("Tap to hide controls.\n\n".repeat(40));
        if (markdown) await page.locator("#markdown-toggle").click();
        await page.locator("#reader-fullscreen").click();
        const surface = page.locator(markdown ? "#markdown-preview" : "#content");
        const toolbar = page.locator("#reader-toolbar");
        // Use taps rather than synthetic click: pointerdown must not undo the toggle.
        await surface.tap({ position: { x: 80, y: 160 } });
        await expect(toolbar).toBeHidden();
        await surface.tap({ position: { x: 80, y: 160 } });
        await expect(toolbar).toBeVisible();
        await page.locator("#reader-play").tap();
        await expect(toolbar).toBeVisible();
        await expect(page.locator("#reader-play")).toHaveText("Pause");
        await page.locator("#reader-play").tap();
        await expect(toolbar).toBeVisible();
        await expect(page.locator("#reader-play")).toHaveText("Resume");
        await surface.tap({ position: { x: 80, y: 160 } });
        await expect(toolbar).toBeHidden();
        await surface.dispatchEvent("touchmove");
        await expect(toolbar).toBeVisible();
        await page.clock.runFor(3200);
        await expect(toolbar).toBeHidden();
    });
}
