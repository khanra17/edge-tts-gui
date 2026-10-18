import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export async function startReader(page: Page, platform = "android"): Promise<void> {
    await page.addInitScript((platform) => {
        let callback = 0;
        Object.assign(window, {
            __TAURI_INTERNALS__: {
                metadata: {
                    currentWindow: { label: "main" },
                    currentWebview: { label: "main", windowLabel: "main" },
                },
                transformCallback: () => ++callback,
                invoke: async (command: string) => {
                    if (command === "get_platform") return platform;
                    if (command === "get_voices") return [
                        { language: "English (United States)", name: "Ava Multilingual, a long voice name", code: "en-US, AvaNeural" },
                        { language: "Chinese (Mandarin, Simplified)", name: "Xiaoxiao", code: "zh-CN, XiaoxiaoNeural" },
                    ];
                    if (command === "synthesize") return new Promise(() => {});
                    if (command === "save_audio") return "content://documents/" + "long-name/".repeat(30) + "speech.mp3";
                    return null;
                },
            },
        });
    }, platform);
    await page.goto("/");
    await expect(page.locator("#play")).toBeEnabled();
}

export async function fitsScreen(page: Page): Promise<void> {
    expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth,
    )).toBe(true);
    const overflow = await page.locator("button:visible, select:visible, input[type=range]:visible").evaluateAll(
        (nodes) => nodes.filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left < 0 || rect.right > innerWidth + 1 || rect.width < 1;
        }).map((node) => node.id),
    );
    expect(overflow).toEqual([]);
}
