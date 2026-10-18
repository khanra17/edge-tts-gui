import { expect, test } from "@playwright/test";
import { startReader } from "./harness.ts";

test("touch highlighting does not focus the editor or scroll the page", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await startReader(page);
    const result = await page.evaluate(async () => {
        const modulePath = "/src/editor.ts";
        const { Editor } = await import(/* @vite-ignore */ modulePath);
        const input = document.querySelector<HTMLTextAreaElement>("#content")!;
        const preview = document.querySelector<HTMLDivElement>("#markdown-preview")!;
        const editor = new Editor(input, preview, document.querySelector("#auto-scroll-btn")!);
        input.value = "First sentence.\n\n" + "Another sentence.\n\n".repeat(80);
        editor.refresh(false, true);
        input.blur();
        editor.highlight({
            status: "playing", message: "", sentences: [{ start: 0, end: 15, text: "First sentence.", index: 0 }],
            sentenceIndex: 0, word: null, position: 0, duration: 10,
        });
        const focused = document.activeElement === input;
        editor.refresh(true, true);
        const before = scrollY;
        const start = editor.text.lastIndexOf("Another");
        editor.highlight({
            status: "playing", message: "", sentences: [{ start, end: start + 17, text: "Another sentence.", index: 0 }],
            sentenceIndex: 0, word: null, position: 0, duration: 10,
        });
        return { focused, pageMoved: before !== scrollY, previewScrolled: preview.scrollTop > 0 };
    });
    expect(result).toEqual({ focused: false, pageMoved: false, previewScrolled: true });
});

test("Copy is removed and code controls and preview data follow Markdown mode", async ({ page }) => {
    await startReader(page);
    await expect(page.locator("#copy-text")).toHaveCount(0);
    await expect(page.locator("#code-toggle")).toBeHidden();
    await page.locator("#content").fill("# Document\n\nRead `code` too.");
    await page.locator("#markdown-toggle").click();
    await expect(page.locator("#code-toggle")).toBeVisible();
    await page.locator("#code-toggle").click();
    await expect(page.locator("#code-toggle")).toHaveText("Code: Skip");
    await expect(page.locator("#markdown-preview")).toContainText("Document");
    await page.locator("#markdown-toggle").click();
    await expect(page.locator("#code-toggle")).toBeHidden();
    await expect(page.locator("#markdown-preview")).toBeEmpty();
    await page.locator("#markdown-toggle").click();
    await expect(page.locator("#code-toggle")).toHaveText("Code: Skip");
});
