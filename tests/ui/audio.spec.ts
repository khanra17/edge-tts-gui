import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startReader } from "./harness.ts";

test("prefetched MP3s allocate no players or MediaSources until attached", async ({ page }) => {
    await startReader(page);
    const counts = await page.evaluate(async () => {
        const path = "/src/audio.ts";
        const { browserAudio, streamingAudio } = await import(/* @vite-ignore */ path);
        const OriginalAudio = window.Audio;
        const OriginalMediaSource = window.MediaSource;
        const originalCreateURL = URL.createObjectURL;
        const originalRevokeURL = URL.revokeObjectURL;
        let elements = 0;
        let sources = 0;
        let urls = 0;
        let revocations = 0;
        window.Audio = class extends OriginalAudio {
            constructor(url?: string) { super(url); elements++; }
        };
        window.MediaSource = class extends OriginalMediaSource {
            constructor() { super(); sources++; }
        };
        URL.createObjectURL = (blob) => { urls++; return originalCreateURL(blob); };
        URL.revokeObjectURL = (url) => { revocations++; originalRevokeURL(url); };
        try {
            const resources = Array.from({ length: 4 }, () => browserAudio(btoa("MP3")));
            const stream = streamingAudio(() => {});
            stream?.append(new Uint8Array([1, 2, 3]));
            const before = { elements, sources, urls };
            void resources[0].element;
            const afterFirst = { elements, sources, urls };
            resources[0].release?.();
            void resources[1].element;
            const afterSwitch = { elements, sources, urls, revocations };
            for (const resource of resources) resource.dispose();
            stream?.dispose();
            return { before, afterFirst, afterSwitch, revocations };
        } finally {
            window.Audio = OriginalAudio;
            window.MediaSource = OriginalMediaSource;
            URL.createObjectURL = originalCreateURL;
            URL.revokeObjectURL = originalRevokeURL;
        }
    });
    expect(counts.before).toEqual({ elements: 0, sources: 0, urls: 0 });
    expect(counts.afterFirst).toEqual({ elements: 1, sources: 0, urls: 1 });
    expect(counts.afterSwitch).toEqual({ elements: 2, sources: 0, urls: 2, revocations: 1 });
    expect(counts.revocations).toBe(2);
});

test("completed prefetched streams use a lazy Blob and can be released and replayed", async ({ page }) => {
    await startReader(page);
    const result = await page.evaluate(async () => {
        const path = "/src/audio.ts";
        const { streamingAudio } = await import(/* @vite-ignore */ path);
        const resource = streamingAudio(() => {});
        if (!resource) return null;
        resource.append(new Uint8Array([1, 2, 3]));
        resource.finish();
        const first = resource.element;
        const originalUrl = first.src;
        resource.release();
        const unloaded = !first.getAttribute("src");
        const second = resource.element;
        resource.dispose();
        return { unloaded, recreated: first !== second, differentUrl: originalUrl !== second.src };
    });
    test.skip(result === null, "WebView does not support streaming MP3");
    expect(result).toEqual({ unloaded: true, recreated: true, differentUrl: true });
});


test("live MP3 streaming releases its decoder and replays complete cached audio", async ({ page }) => {
    const encoded = (await readFile(new URL("../fixtures/tone.mp3", import.meta.url))).toString("base64");
    await startReader(page);
    const result = await page.evaluate(async (encoded) => {
        const path = "/src/audio.ts";
        const { decodeAudio, streamingAudio } = await import(/* @vite-ignore */ path);
        const errors: string[] = [];
        const resource = streamingAudio((error: string) => errors.push(error));
        if (!resource) return null;
        try {
            const bytes = decodeAudio(encoded);
            const split = Math.floor(bytes.length / 2);
            resource.append(bytes.subarray(0, split));
            const first = resource.element;
            first.muted = true;
            await first.play();
            resource.release();
            const unloaded = !first.getAttribute("src");
            // Re-enter a still-in-flight stream before completion, as cached seeking can do.
            const resumed = resource.element;
            resumed.muted = true;
            await resumed.play();
            resource.append(bytes.subarray(split));
            resource.finish();
            resource.release();
            const second = resource.element;
            second.muted = true;
            await second.play();
            return { errors, unloaded: unloaded && !resumed.getAttribute("src"), recreated: first !== second, duration: second.duration };
        } finally {
            resource.dispose();
        }
    }, encoded);
    test.skip(result === null, "WebView does not support streaming MP3");
    expect(result?.errors).toEqual([]);
    expect(result?.unloaded).toBe(true);
    expect(result?.recreated).toBe(true);
    expect(result?.duration).toBeGreaterThan(1);
});
