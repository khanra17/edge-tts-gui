import type { AudioResource, StreamingAudioResource } from "./types.ts";

export function decodeAudio(base64: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function browserAudio(base64: string): AudioResource {
    const url = URL.createObjectURL(new Blob([decodeAudio(base64)], { type: "audio/mpeg" }));
    const element = new Audio(url);
    element.preload = "auto";
    element.load();
    return {
        element,
        dispose() {
            element.pause();
            element.removeAttribute("src");
            element.load();
            URL.revokeObjectURL(url);
        },
    };
}

/** Append MP3 frames as they arrive, rather than waiting for the complete utterance. */
export function streamingAudio(onError: (message: string) => void): StreamingAudioResource | null {
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported("audio/mpeg"))
        return null;
    const source = new MediaSource();
    const url = URL.createObjectURL(source);
    const element = new Audio(url);
    element.preload = "auto";
    let buffer: SourceBuffer | null = null;
    const queue: Uint8Array<ArrayBuffer>[] = [];
    let finished = false;
    let disposed = false;
    let failed = false;

    const fail = (message: string) => {
        if (disposed || failed) return;
        failed = true;
        onError(message);
    };
    const pump = () => {
        if (disposed || failed || !buffer || buffer.updating) return;
        try {
            const next = queue.shift();
            if (next) buffer.appendBuffer(next);
            else if (finished && source.readyState === "open") source.endOfStream();
        } catch (error) {
            fail(`Cannot decode streamed audio: ${error}`);
        }
    };
    source.addEventListener(
        "sourceopen",
        () => {
            if (disposed) return;
            try {
                buffer = source.addSourceBuffer("audio/mpeg");
                buffer.mode = "sequence";
                buffer.addEventListener("updateend", pump);
                buffer.addEventListener("error", () => fail("Cannot decode streamed audio"));
                pump();
            } catch (error) {
                fail(`Cannot open audio stream: ${error}`);
            }
        },
        { once: true },
    );
    return {
        element,
        append(bytes) {
            if (disposed || failed || finished || !bytes.length) return;
            queue.push(bytes);
            pump();
        },
        finish() {
            finished = true;
            pump();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            queue.length = 0;
            element.pause();
            element.removeAttribute("src");
            element.load();
            URL.revokeObjectURL(url);
        },
    };
}
