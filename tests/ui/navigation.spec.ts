import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { startReader } from "./harness.ts";

const doc = Array.from({ length: 120 }, (_, index) => `Sentence number ${index}.`).join("\n\n");

/** Texts of synthesis requests made so far. */
const requested = (page: Page) => page.evaluate(() =>
    (window as unknown as { __calls: { command: string; args: { request: { text: string } } }[] }).__calls
        .filter((call) => call.command === "synthesize")
        .map((call) => call.args.request.text),
);

const number = (text: string) => Number(/Sentence number (\d+)\./u.exec(text)?.[1]);

for (const markdown of [false, true]) {
    test(`Read here jumps ahead and back to the sentence in view (${markdown ? "Markdown" : "text"})`, async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 700 });
        await startReader(page, "desktop");
        await page.locator("#content").fill(doc);
        if (markdown) await page.locator("#markdown-toggle").click();
        const surface = page.locator(markdown ? "#markdown-preview" : "#content");
        await page.locator("#play").click();
        expect((await requested(page))[0]).toBe("Sentence number 0.");

        await expect(page.locator("#read-here-btn")).toBeHidden();
        await surface.dispatchEvent("wheel", { deltaY: 400 });
        await surface.evaluate((node) => { node.scrollTop = node.scrollHeight / 2; });
        await expect(page.locator("#read-here-btn")).toBeVisible();
        await expect(page.locator("#auto-scroll-btn")).toBeVisible();

        let before = (await requested(page)).length;
        await page.locator("#read-here-btn").click();
        const ahead = (await requested(page))[before];
        expect(ahead).toMatch(/^Sentence number \d+\.$/u);
        expect(number(ahead)).toBeGreaterThan(40);
        expect(number(ahead)).toBeLessThan(80);
        await expect(page.locator("#scroll-actions")).toBeHidden();

        // And all the way back.
        await surface.dispatchEvent("wheel", { deltaY: -400 });
        await surface.evaluate((node) => { node.scrollTop = 0; });
        before = (await requested(page)).length;
        await page.locator("#read-here-btn").click();
        expect((await requested(page))[before]).toBe("Sentence number 0.");
    });
}

test("Alt+click reads from the clicked sentence; a plain double click only selects", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await startReader(page, "desktop");
    await page.locator("#content").fill(doc);
    await page.locator("#markdown-toggle").click();
    const paragraph = page.locator("#markdown-preview p").nth(5);
    await paragraph.dblclick({ position: { x: 30, y: 8 } });
    expect(await requested(page)).toEqual([]);
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBeTruthy();
    await paragraph.click({ modifiers: ["Alt"], position: { x: 30, y: 8 } });
    expect((await requested(page))[0]).toBe("Sentence number 5.");
    await expect(page.locator("#play")).toHaveAttribute("data-state", "pause");
});

test("plain arrows seek during playback but still move the caret while editing", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await startReader(page, "desktop");
    await page.locator("#content").fill(doc);
    await page.evaluate(() => {
        (window as unknown as { __prevented: string[] }).__prevented = [];
        document.addEventListener("keydown", (event) => {
            if (event.defaultPrevented) (window as unknown as { __prevented: string[] }).__prevented.push(
                `${event.key}@${(event.target as HTMLElement).id || "body"}`,
            );
        });
    });
    const prevented = () => page.evaluate(() => (window as unknown as { __prevented: string[] }).__prevented);
    await page.locator("#play").click();
    await page.locator("#content").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await prevented()).toEqual([]);
    await page.locator("#play").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    expect(await prevented()).toEqual(["ArrowRight@play", "ArrowLeft@play"]);
    await page.locator("#content").focus();
    await page.keyboard.press("Alt+ArrowRight");
    expect(await prevented()).toContain("ArrowRight@content");
});
