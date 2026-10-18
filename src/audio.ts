import type { AudioResource, StreamingAudioResource } from "./types.ts";

export function decodeAudio(base64: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function audioByteLength(base64: string): number {
    return Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

function unload(element: HTMLAudioElement | null, url: string | null): void {
    if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
    }
    if (url) URL.revokeObjectURL(url);
}

/** Cached audio is compressed data, not a live decoder or a preloading media element. */
function blobAudio(data: Blob): AudioResource {
    let blob: Blob | null = data;
    let element: HTMLAudioElement | null = null;
    let url: string | null = null;
    const release = () => {
        unload(element, url);
        element = null;
        url = null;
    };
    return {
        get element() {
            if (!blob) throw new Error("Audio resource was disposed");
            if (!element) {
                url = URL.createObjectURL(blob);
                element = new Audio(url);
                element.preload = "metadata";
            }
            return element;
        },
        release,
        dispose() {
            release();
            blob = null;
        },
    };
}

export function browserAudio(base64: string): AudioResource {
    return blobAudio(new Blob([decodeAudio(base64)], { type: "audio/mpeg" }));
}

/** Only the active chunk opens MediaSource; lookahead retains compressed packets. */
export function streamingAudio(onError: (message: string) => void): StreamingAudioResource | null {
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg"))
        return null;
    let source: MediaSource | null = null;
    let url: string | null = null;
    let element: HTMLAudioElement | null = null;
    let buffer: SourceBuffer | null = null;
    let fallback: AudioResource | null = null;
    let packets: Uint8Array<ArrayBuffer>[] = [];
    let nextPacket = 0;
    let finished = false;
    let disposed = false;
    let failed = false;
    let removeListeners: (() => void) | null = null;

    const fail = () => {
        if (disposed || failed) return;
        failed = true;
        onError("Cannot decode streamed audio");
    };
    const pump = () => {
        if (disposed || failed || !buffer || buffer.updating) return;
        try {
            const next = packets[nextPacket];
            if (next) {
                nextPacket++;
                buffer.appendBuffer(next);
            } else if (finished && source?.readyState === "open") source.endOfStream();
        } catch {
            fail();
        }
    };
    const release = () => {
        removeListeners?.();
        removeListeners = null;
        fallback?.release?.();
        unload(element, url);
        element = null;
        url = null;
        buffer = null;
        source = null;
        nextPacket = 0;
        if (finished && !disposed && !fallback) {
            fallback = blobAudio(new Blob(packets, { type: "audio/mpeg" }));
            packets = [];
        }
    };
    const open = (): HTMLAudioElement => {
        if (disposed) throw new Error("Audio resource was disposed");
        if (fallback) return fallback.element;
        if (element) return element;
        // A completed prefetched chunk needs no streaming machinery.
        if (finished) {
            fallback = blobAudio(new Blob(packets, { type: "audio/mpeg" }));
            packets = [];
            return fallback.element;
        }
        const current = new MediaSource();
        source = current;
        url = URL.createObjectURL(current);
        element = new Audio(url);
        element.preload = "auto";
        const onOpen = () => {
            if (disposed || source !== current) return;
            try {
                const currentBuffer = current.addSourceBuffer("audio/mpeg");
                buffer = currentBuffer;
                currentBuffer.mode = "sequence";
                currentBuffer.addEventListener("updateend", pump);
                currentBuffer.addEventListener("error", fail);
                removeListeners = () => {
                    currentBuffer.removeEventListener("updateend", pump);
                    currentBuffer.removeEventListener("error", fail);
                };
                pump();
            } catch {
                fail();
            }
        };
        current.addEventListener("sourceopen", onOpen, { once: true });
        removeListeners = () => current.removeEventListener("sourceopen", onOpen);
        return element;
    };
    return {
        get element() { return open(); },
        append(bytes) {
            if (disposed || failed || finished || !bytes.length) return;
            packets.push(bytes);
            pump();
        },
        finish() {
            finished = true;
            pump();
            if (!element) release();
        },
        release,
        dispose() {
            if (disposed) return;
            disposed = true;
            release();
            fallback?.dispose();
            fallback = null;
            packets = [];
        },
    };
}
