import { expect, test } from "@playwright/test";
import { fitsScreen, startReader } from "./harness.ts";

for (const [width, height] of [[320, 568], [360, 640], [390, 844], [600, 960], [740, 360], [1024, 768]]) {
    test(`Android layout at ${width}×${height}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height });
        await startReader(page);
        await expect(page.locator("#close")).toBeHidden();
        await expect(page.locator(".hotkey-bar")).toBeHidden();
        await fitsScreen(page);
        // Playback and settings belong to the outer page, not an overlay on the text.
        await page.mouse.move(3, height / 2);
        await page.mouse.wheel(0, 10000);
        await expect(page.locator("#play")).toBeInViewport();
        await page.evaluate(() => scrollTo(0, 0));
        const readerHeight = await page.locator("#reader-area").evaluate((node) => node.clientHeight);
        expect(readerHeight).toBeGreaterThanOrEqual(width <= 680 ? 320 : 280);
        const smallTargets = await page.locator("button:visible, select:visible, input[type=range]:visible")
            .evaluateAll((nodes) => nodes.filter((node) =>
                node.getBoundingClientRect().height < 48,
            ).map((node) => node.id));
        expect(smallTargets).toEqual([]);

        await page.locator("#content").fill(
            "Welcome to Edge Speak.\n\nPaste a document or open a text file, choose a voice, and tap Play.\n\nChange the speed, pitch, or volume to suit you.",
        );
        await page.screenshot({ path: testInfo.outputPath("initial.png") });
        await page.locator("#open-file").setInputFiles({
            name: "reader.md",
            mimeType: "text/markdown",
            buffer: Buffer.from("# Reader\n\n" + "A long sentence and a URL https://example.com/" + "path".repeat(80)),
        });
        await expect(page.locator("#content")).toHaveValue(/# Reader/);
        await page.locator("#markdown-toggle").click();
        await expect(page.locator("#markdown-preview")).toContainText("Reader");
        await expect(page.locator("#markdown-preview")).not.toHaveAttribute("contenteditable");
        await fitsScreen(page);
        await page.locator("#save").click();
        await expect(page.locator("#status")).toContainText("Saved:");
        await fitsScreen(page);
        await page.locator("#play").click();
        await expect(page.locator("#play")).toHaveText("Pause");
        await page.locator("#stop").click();
        await expect(page.locator("#play")).toHaveText("Play");
        await page.screenshot({ path: testInfo.outputPath("reader.png"), fullPage: true });
    });
}

test("large text and a keyboard-height viewport stay scrollable", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 300 });
    await startReader(page);
    await page.addStyleTag({ content: ":root { font-size: 20px; }" });
    await fitsScreen(page);
    await page.locator("#content").fill("Text entered with the keyboard open.");
    await page.locator("#play").click();
    await expect(page.locator("#stop")).toBeEnabled();
    await page.locator("#stop").click();
    await fitsScreen(page);
});

test("desktop retains Close and shortcuts", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 740, height: 580 }, hasTouch: false });
    const page = await context.newPage();
    await startReader(page, "desktop");
    await expect(page.locator("#close")).toBeVisible();
    await expect(page.locator(".hotkey-bar")).toBeHidden();
    await page.locator("#settings-toggle").click();
    await expect(page.locator(".hotkey-bar")).toBeVisible();
    await fitsScreen(page);
    await context.close();
});

test("Voice & sound opens as a panel, applies presets and closes with Escape", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startReader(page);
    const panel = page.locator("#settings-panel");
    await expect(panel).toBeHidden();
    await expect(page.locator("#settings-summary")).toHaveText("Ava Multilingual · 1×");
    await page.locator("#settings-toggle").click();
    await expect(panel).toBeVisible();
    await expect(page.locator("#settings-toggle")).toHaveAttribute("aria-expanded", "true");
    await fitsScreen(page);
    await page.screenshot({ path: testInfo.outputPath("settings-sheet.png") });
    await page.locator(".preset", { hasText: "1.5×" }).click();
    await expect(page.locator("#speed")).toHaveValue("1.5");
    await expect(page.locator("#speed-val")).toHaveText("1.5x");
    await expect(page.locator(".preset", { hasText: "1.5×" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#settings-summary")).toHaveText("Ava Multilingual · 1.5×");
    await page.locator("#pitch").fill("20");
    await page.locator("#pitch-reset").click();
    await expect(page.locator("#pitch-val")).toHaveText("+0Hz");
    await page.locator("#mute-btn").click();
    await expect(page.locator("#mute-btn")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await page.locator("#settings-toggle").click();
    await page.locator("#settings-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(panel).toBeHidden();
});

test("wide windows keep Voice & sound docked beside the text", async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false });
    const page = await context.newPage();
    await startReader(page, "desktop");
    await expect(page.locator("#settings-panel")).toBeVisible();
    await expect(page.locator("#settings-toggle")).toBeHidden();
    await expect(page.locator(".empty-hint")).toBeVisible();
    await page.locator("#content").fill("Some text.");
    await expect(page.locator(".empty-hint")).toBeHidden();
    await fitsScreen(page);
    await page.screenshot({ path: testInfo.outputPath("wide.png") });
    await context.close();
});
