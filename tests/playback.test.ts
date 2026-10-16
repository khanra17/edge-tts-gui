import assert from "node:assert/strict";
import test from "node:test";
import { Playback } from "../src/playback.ts";
import type {
    AudioResource,
    SpeechRequest,
    SynthesizedSpeech,
    SynthesisUpdate,
    WordBoundary,
} from "../src/types.ts";

class FakeAudio extends EventTarget {
    requestIndex: number;
    currentTime = 0;
    duration = 10;
    playbackRate = 1;
    volume = 1;
    preservesPitch = true;
    paused = true;
    disposed = false;
    received = "";
    finished = false;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeupdate: (() => void) | null = null;

    constructor(requestIndex: number) {
        super();
        this.requestIndex = requestIndex;
    }

    play(): Promise<void> {
        this.paused = false;
        return Promise.resolve();
    }
    pause(): void {
        this.paused = true;
    }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const settings = { voice: "en-US, AvaNeural", pitch: 0 };
const sentence = (index: number) => `Sentence number ${index + 1}.`;
const text = Array.from({ length: 20 }, (_, index) => sentence(index)).join(" ");

function harness(streaming = false) {
    const requests: {
        request: SpeechRequest;
        job: number;
        pending: boolean;
        update?: (update: SynthesisUpdate) => void;
        resolve: (speech: SynthesizedSpeech) => void;
        reject: (error: unknown) => void;
    }[] = [];
    const resources: FakeAudio[] = [];
    const cancelled: number[] = [];
    const player = new Playback(
        {
            synthesize: (request, job, onUpdate) =>
                new Promise((resolve, reject) => {
                    const entry = {
                        request,
                        job,
                        pending: true,
                        update: onUpdate,
                        resolve(speech: SynthesizedSpeech) {
                            entry.pending = false;
                            resolve(speech);
                        },
                        reject(error: unknown) {
                            entry.pending = false;
                            reject(error);
                        },
                    };
                    requests.push(entry);
                }),
            cancel: async (job) => {
                cancelled.push(job);
            },
        },
        (base64) => {
            const audio = new FakeAudio(Number(base64));
            resources.push(audio);
            return {
                element: audio as unknown as HTMLAudioElement,
                dispose() {
                    audio.pause();
                    audio.disposed = true;
                },
            } satisfies AudioResource;
        },
        () => {
            if (!streaming) return null;
            const audio = new FakeAudio(requests.length);
            resources.push(audio);
            return {
                element: audio as unknown as HTMLAudioElement,
                append(bytes: Uint8Array) {
                    audio.received += new TextDecoder().decode(bytes);
                },
                finish() {
                    audio.finished = true;
                },
                dispose() {
                    audio.pause();
                    audio.disposed = true;
                },
            };
        },
    );
    const audio = (index: number) => {
        const resource = resources.find((item) => item.requestIndex === index);
        assert.ok(resource, `request ${index} has no audio`);
        return resource;
    };
    const complete = async (index: number, boundaries?: WordBoundary[]) => {
        requests[index].resolve({
            audioBase64: streaming ? btoa("audio") : String(index),
            wordBoundaries:
                boundaries ??
                [...requests[index].request.text.matchAll(/[\p{L}\p{N}]+/gu)].map(
                    (match, word) => ({ text: match[0], offsetMs: word * 200, durationMs: 100 }),
                ),
        });
        await flush();
    };
    const pending = () =>
        requests.filter((request) => request.pending && request.job === cancelled.at(-1));
    return { player, requests, resources, cancelled, audio, complete, pending };
}

test("audio starts on streamed packets before the complete synthesis response", async () => {
    const { player, requests, audio, complete } = harness(true);
    player.start(text, settings);
    requests[0].update?.({
        type: "words",
        boundaries: [{ text: "Sentence", offsetMs: 0, durationMs: 100 }],
    });
    requests[0].update?.({ type: "audio", data: btoa("au") });
    assert.equal(player.view.status, "playing");
    assert.equal(player.view.word?.text, "Sentence");
    assert.equal(audio(0).paused, false);
    assert.equal(requests[0].pending, true);
    assert.equal(requests.length, 3);
    requests[1].update?.({ type: "audio", data: btoa("au") });
    assert.equal(audio(1).paused, true);
    await complete(0);
    assert.equal(audio(0).received, "audio");
    assert.equal(audio(0).finished, true);
    audio(0).onended?.();
    assert.equal(audio(1).paused, false);
    assert.equal(requests[1].pending, true);
    assert.equal(player.view.status, "playing");
});

test("stream completion repairs queued IPC tails and ignores late duplicate packets", async () => {
    const { player, requests, audio, complete } = harness(true);
    player.start(text, settings);
    requests[0].update?.({ type: "audio", data: btoa("au") });
    await complete(0);
    requests[0].update?.({ type: "audio", data: btoa("dio") });
    assert.equal(audio(0).received, "audio");
    assert.equal(audio(0).finished, true);
});

test("cancelled streams cannot append audio or revive a replacement generation", async () => {
    const { player, requests, audio } = harness(true);
    player.start(text, settings);
    player.reconfigure(text, { ...settings, pitch: 2 });
    requests[0].update?.({ type: "audio", data: btoa("old") });
    assert.equal(audio(0).disposed, true);
    assert.equal(audio(0).received, "");
    assert.equal(player.view.status, "buffering");
    requests[2].update?.({ type: "audio", data: btoa("au") });
    assert.equal(audio(2).paused, false);
});

test("paused streaming primes audio without playing or launching lookahead", async () => {
    const { player, requests, audio, complete } = harness(true);
    player.start(text, settings);
    player.pause();
    player.reconfigure(text, { ...settings, pitch: 2 });
    requests[2].update?.({ type: "audio", data: btoa("au") });
    await complete(2);
    assert.equal(audio(2).paused, true);
    assert.equal(player.view.status, "paused");
    assert.equal(requests.length, 3);
});

test("streamed continuations wait for the complete word anchor before seeking", async () => {
    const { player, requests, audio, complete } = harness(true);
    player.start(text, settings);
    requests[0].update?.({
        type: "words",
        boundaries: [
            { text: "Sentence", offsetMs: 0, durationMs: 100 },
            { text: "number", offsetMs: 200, durationMs: 100 },
        ],
    });
    requests[0].update?.({ type: "audio", data: btoa("au") });
    audio(0).currentTime = 0.25;
    player.tick();
    const replacement = requests.length;
    player.reconfigure(text, { ...settings, pitch: 2 });
    requests[replacement].update?.({ type: "audio", data: btoa("au") });
    assert.equal(audio(replacement).paused, true);
    assert.equal(player.view.status, "buffering");
    await complete(replacement);
    assert.equal(audio(replacement).currentTime, 0.2);
    assert.equal(audio(replacement).paused, false);
});

test("a stream placeholder cannot play before its first packet arrives", async () => {
    const { player, requests, audio, complete } = harness(true);
    player.start(text, settings);
    requests[0].update?.({ type: "audio", data: btoa("au") });
    await complete(0);
    audio(0).onended?.();
    assert.equal(player.view.status, "buffering");
    assert.equal(audio(1).paused, true);
    requests[1].update?.({ type: "audio", data: btoa("au") });
    assert.equal(player.view.status, "playing");
    assert.equal(audio(1).paused, false);
});

test("seeking to a pending stream restarts at that sentence instead of using a placeholder", () => {
    const { player, requests, audio } = harness(true);
    player.start(text, settings);
    player.jump(1);
    assert.equal(requests[2].request.text, sentence(1));
    assert.ok(requests[2].job > requests[1].job);
    assert.equal(audio(0).disposed, true);
    assert.equal(audio(1).disposed, true);
});

test("startup overlaps two short sentences, keeping large batches out of the first request", async () => {
    const { player, requests, audio, complete, pending } = harness();
    player.start(text, settings);
    assert.deepEqual(
        requests.map((item) => item.request.text),
        [sentence(0), sentence(1)],
    );
    await complete(0);
    assert.equal(audio(0).paused, false);
    assert.equal(requests[2].request.text, [2, 3, 4].map(sentence).join(" "));
    assert.equal(requests[3].request.text, [5, 6, 7].map(sentence).join(" "));
    assert.equal(pending().length, 3);
});

test("an early bridge response cannot play before the first sentence", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(1);
    assert.equal(player.view.status, "buffering");
    assert.equal(audio(1).paused, true);
    assert.equal(requests.length, 2);
    await complete(0);
    assert.equal(audio(0).paused, false);
    assert.equal(audio(1).paused, true);
    audio(0).onended?.();
    assert.equal(player.view.sentenceIndex, 1);
    assert.equal(player.view.status, "playing");
    assert.equal(audio(1).paused, false);
});

test("the first handoff uses prefetched audio without awaiting a large batch", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    await complete(1);
    // Both large batches are still waiting for the server.
    assert.ok(requests[2].pending && requests[3].pending);
    audio(0).onended?.();
    assert.equal(player.view.status, "playing");
    assert.equal(audio(1).paused, false);
    assert.equal(requests[4].request.text, [8, 9, 10].map(sentence).join(" "));
});

test("each playing batch immediately refills lookahead despite a slower pending request", async () => {
    const { player, requests, audio, complete, pending } = harness();
    player.start(text, settings);
    await complete(0);
    await complete(1);
    await complete(2);
    audio(0).onended?.();
    audio(1).onended?.();
    assert.equal(player.view.status, "playing");
    assert.equal(audio(2).paused, false);
    // Requests 3 and 4 may still be slow; they must not block request 5.
    assert.equal(requests[5].request.text, [11, 12, 13].map(sentence).join(" "));
    assert.ok(requests[3].pending && requests[4].pending);
    assert.equal(pending().length, 3);
});

test("out-of-order lookahead is cached, bounded, and played in document order", async () => {
    const { player, requests, audio, complete, pending } = harness();
    player.start(text, settings);
    await complete(0);
    await complete(3);
    await complete(2);
    await complete(1);
    assert.equal(requests.length, 4);
    assert.equal(pending().length, 0);
    audio(0).onended?.();
    assert.equal(audio(1).paused, false);
    assert.equal(audio(3).paused, true);
    assert.equal(requests.length, 5);
    audio(1).onended?.();
    assert.equal(audio(2).paused, false);
    assert.equal(requests.length, 6);
    audio(2).onended?.();
    assert.equal(audio(3).paused, false);
    assert.equal(pending().length, 3);
});

test("prefetch stays bounded and evicts audio behind playback", async () => {
    const { player, requests, resources, audio, complete, pending } = harness();
    player.start(text, settings);
    let current = 0;
    while (player.view.status !== "idle") {
        for (let index = 0; index < requests.length; index++) {
            if (requests[index].pending) await complete(index);
            assert.ok(pending().length <= 3);
        }
        assert.ok(resources.filter((resource) => !resource.disposed).length <= 6);
        audio(current++).onended?.();
    }
    assert.equal(player.view.status, "idle");
    assert.ok(resources.every((resource) => resource.disposed));
});

test("voice and pitch replacements immediately stop and dispose previous audio", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    const replacement = requests.length;
    player.reconfigure(text, { voice: "fr-FR, DeniseNeural", pitch: 5 });
    assert.ok(audio(0).paused && audio(0).disposed);
    assert.equal(requests[replacement].request.text, sentence(0));
    assert.equal(requests[replacement + 1].request.text, sentence(1));
    assert.equal(requests[replacement].request.voice, "fr-FR, DeniseNeural");
    assert.equal(requests[replacement].request.pitch, 5);
    assert.ok(requests[replacement].job > requests[0].job);
});

test("stale concurrent successes and failures cannot release replacement slots", async () => {
    const { player, requests, resources, complete, pending } = harness();
    player.start(text, settings);
    player.reconfigure(text, { ...settings, pitch: 5 });
    await complete(0);
    requests[1].reject("Stopped");
    await flush();
    assert.equal(resources.length, 0);
    assert.equal(player.view.status, "buffering");
    assert.equal(requests.length, 4);
    assert.equal(pending().length, 2);
    await complete(2);
    assert.equal(player.view.status, "playing");
    assert.equal(requests.length, 6);
    assert.equal(pending().length, 3);
});

test("paused replacements prime only the current sentence, including rapid changes", async () => {
    const { player, requests, resources, audio, complete } = harness();
    player.start(text, settings);
    player.pause();
    player.reconfigure(text, { ...settings, pitch: 1 });
    player.reconfigure(text, { ...settings, pitch: 2 });
    assert.equal(requests.length, 4);
    await complete(2);
    assert.equal(resources.length, 0);
    await complete(3);
    assert.equal(player.view.status, "paused");
    assert.equal(audio(3).paused, true);
    assert.equal(requests.length, 4);
    player.resume();
    assert.equal(player.view.status, "playing");
    assert.equal(requests.length, 7);
});

test("pause does not launch new lookahead as pending requests complete", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    player.pause();
    await complete(1);
    await complete(2);
    await complete(3);
    assert.equal(requests.length, 4);
    assert.equal(player.view.status, "paused");
    assert.equal(audio(0).paused, true);
});

test("resume during a paused replacement request does not duplicate it", async () => {
    const { player, requests, complete } = harness();
    player.start(text, settings);
    player.pause();
    player.reconfigure(text, { ...settings, pitch: 5 });
    player.resume();
    assert.equal(requests.length, 4);
    assert.equal(requests[2].request.text, sentence(0));
    assert.equal(requests[3].request.text, sentence(1));
    await complete(2);
    assert.equal(player.view.status, "playing");
    assert.equal(requests.length, 6);
});

test("pause and resume keep the current audio position without duplicate requests", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    audio(0).currentTime = 4.25;
    player.pause();
    player.resume();
    assert.equal(audio(0).currentTime, 4.25);
    assert.equal(audio(0).paused, false);
    assert.equal(requests.length, 4);
});

test("batch word timings select the correct sentence and cached seeks preserve order", async () => {
    const { player, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    await complete(1);
    await complete(2);
    audio(0).onended?.();
    audio(1).onended?.();
    audio(2).currentTime = 1.25;
    player.tick();
    assert.equal(player.view.sentenceIndex, 4);
    assert.equal(player.view.word?.text, "Sentence");
    player.jump(3);
    assert.equal(audio(2).currentTime, 0.6);
    assert.equal(player.view.sentenceIndex, 3);
});

test("local speed and zero volume do not refetch speech", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    const count = requests.length;
    player.setLocal(2, 0);
    assert.equal(audio(0).volume, 0);
    assert.equal(audio(0).playbackRate, 2);
    assert.equal(requests.length, count);
});

test("reconfiguration preserves the word anchor through rapid concurrent changes", async () => {
    const { player, requests, audio, complete } = harness();
    player.start(text, settings);
    await complete(0);
    audio(0).currentTime = 0.25;
    player.tick();
    assert.equal(player.view.word?.text, "number");
    player.reconfigure(text, { ...settings, pitch: 1 });
    const replacement = requests.length;
    player.reconfigure(text, { ...settings, pitch: 2 });
    await complete(replacement);
    assert.equal(audio(replacement).currentTime, 0.2);
});

test("an uncached seek prioritizes the target and invalidates old lookahead", async () => {
    const { player, requests, complete } = harness();
    player.start(text, settings);
    player.jump(5);
    assert.equal(requests[2].request.text, sentence(5));
    await complete(0);
    await complete(1);
    assert.equal(player.view.sentenceIndex, 5);
    assert.equal(player.view.status, "buffering");
    assert.equal(requests.length, 4);
});

test("stop cancels all concurrent synthesis and releases cached audio", async () => {
    const { player, requests, resources, cancelled, complete } = harness();
    player.start(text, settings);
    await complete(0);
    player.stop();
    assert.equal(player.view.status, "idle");
    assert.ok(resources.every((resource) => resource.disposed));
    assert.ok(cancelled.at(-1)! > cancelled[0]);
    await complete(1);
    await complete(2);
    await complete(3);
    assert.equal(resources.length, 1);
    assert.equal(requests.length, 4);
});

test("network and empty audio errors remain visible instead of skipping text", async () => {
    for (const empty of [true, false]) {
        const { player, requests, resources, complete } = harness();
        player.start(text, settings);
        if (empty) requests[0].resolve({ audioBase64: "", wordBoundaries: [] });
        else requests[0].reject("403 Forbidden");
        await flush();
        assert.equal(player.view.status, "idle");
        assert.match(player.view.message, /Synthesis failed/);
        await complete(1);
        assert.equal(resources.length, 0);
        assert.equal(requests.length, 2);
    }
});
