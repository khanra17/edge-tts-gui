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

test("Markdown preview offers Paste from the context menu without becoming editable", async ({ page }) => {
    await startReader(page, "desktop");
    await page.locator("#content").fill("# Title\n\nBody.");
    await page.locator("#markdown-toggle").click();
    const preview = page.locator("#markdown-preview");
    await preview.click({ button: "right" });
    await expect(preview).toHaveAttribute("contenteditable", "true");
    await expect(preview).toHaveAttribute("inputmode", "none");
    await page.keyboard.type("typed");
    await expect(preview).not.toContainText("typed");
    await page.keyboard.press("Escape");
    await preview.click({ button: "right" });
    await preview.evaluate((node) => {
        const data = new DataTransfer();
        data.setData("text/plain", "## Pasted\n\nMore text.");
        node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("#content")).toHaveValue("# Title\n\nBody.\n## Pasted\n\nMore text.");
    await expect(preview.locator("h2")).toHaveText("Pasted");
    await page.locator("#markdown-toggle").focus();
    await expect(preview).not.toHaveAttribute("contenteditable");
    await preview.click();
    await page.keyboard.press("Space");
    await expect(page.locator("#reader-play")).not.toHaveText("Play");
});

test("auto-scroll brings an offscreen highlight to the top of the view", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await startReader(page, "desktop");
    const result = await page.evaluate(async () => {
        const modulePath = "/src/editor.ts";
        const { Editor } = await import(/* @vite-ignore */ modulePath);
        const input = document.querySelector<HTMLTextAreaElement>("#content")!;
        const preview = document.querySelector<HTMLDivElement>("#markdown-preview")!;
        const editor = new Editor(input, preview, document.querySelector("#auto-scroll-btn")!);
        input.value = Array.from({ length: 120 }, (_, i) => `Sentence number ${i}.`).join("\n\n");
        const speak = (start: number) => editor.highlight({
            status: "playing", message: "", sentences: [{ start, end: start + 8, text: "Sentence", index: 0 }],
            sentenceIndex: 0, word: null, position: 0, duration: 10,
        });
        const placement = (element: HTMLElement, top: number) => (top - element.scrollTop) / element.clientHeight;

        editor.refresh(false, true);
        const textStart = input.value.indexOf("Sentence number 80.");
        speak(textStart);
        const mirror = [...document.body.children].at(-1) as HTMLElement;
        const range = document.createRange();
        range.setStart(mirror.firstChild!, textStart);
        const textTop = range.getClientRects()[0].top - mirror.getBoundingClientRect().top;
        const textScroll = input.scrollTop;
        speak(input.value.indexOf("Sentence number 81."));
        const textStayed = input.scrollTop === textScroll;
        const text = placement(input, textTop);

        editor.refresh(true, true);
        preview.style.height = preview.style.maxHeight = "400px";
        preview.style.flex = "none";
        const start = editor.text.indexOf("Sentence number 80.");
        speak(start);
        const paragraph = [...preview.querySelectorAll("p")][80];
        const previewTop = paragraph.getBoundingClientRect().top - preview.getBoundingClientRect().top
            - preview.clientTop + preview.scrollTop;
        return {
            text,
            textStayed,
            preview: placement(preview, previewTop),
        };
    });
    expect(result.textStayed).toBe(true);
    for (const value of [result.text, result.preview]) {
        expect(value).toBeGreaterThan(0.05);
        expect(value).toBeLessThan(0.2);
    }
});
