import { audioByteLength, browserAudio, decodeAudio, streamingAudio } from "./audio.ts";
import {
    alignWords,
    chunkSentences,
    continuationIndex,
    nextJobId,
    sentencesFrom,
} from "./speech.ts";
import type {
    AudioResource,
    PlaybackStatus,
    PlaybackView,
    Sentence,
    SpeechService,
    SpeechSettings,
    SpokenWord,
    StreamingAudioResource,
    SynthesisUpdate,
    WordBoundary,
} from "./types.ts";

interface Chunk {
    resource: AudioResource;
    /** Sentence indices this audio covers; the first one is its cache key. */
    indices: number[];
    ready: boolean;
    /** The full response arrived. Complete audio survives seeks for the whole session. */
    complete: boolean;
    words: SpokenWord[];
    timing: { index: number; startMs: number }[];
}

interface Anchor {
    word: string;
    progress: number;
}

const MAX_IN_FLIGHT = 3;
const LOOKAHEAD_CHUNKS = 3;

/** Owns audio, buffering, cancellation, and seeking. It has no DOM or Tauri dependency. */
export class Playback {
    onChange: (view: PlaybackView) => void = () => {};
    private service: SpeechService;
    private createAudio: (base64: string) => AudioResource;
    private createStream: (onError: (message: string) => void) => StreamingAudioResource | null;
    private job = 0;
    private text = "";
    private settings: SpeechSettings = { voice: "", pitch: 0 };
    private status: PlaybackStatus = "idle";
    private error = "";
    private sentences: Sentence[] = [];
    private currentIndex = 0;
    /** Playback plan from the current starting point; positions index into it. */
    private chunks: number[][] = [];
    private active = 0;
    /** Keyed by a chunk's first sentence, so cached audio outlives plan changes. */
    private cache = new Map<number, Chunk>();
    private fetching = new Set<number>();
    private audio: HTMLAudioElement | null = null;
    private removeMetadataListener: (() => void) | null = null;
    private word: SpokenWord | null = null;
    private anchor: Anchor | null = null;
    private speed = 1;
    private volume = 1;

    constructor(service: SpeechService, createAudio = browserAudio, createStream = streamingAudio) {
        this.service = service;
        this.createAudio = createAudio;
        this.createStream = createStream;
    }

    get view(): PlaybackView {
        const message =
            this.error ||
            (this.status === "idle"
                ? "Ready"
                : `${this.status === "buffering" ? "Buffering" : this.status === "paused" ? "Paused at" : "Reading"} sentence ${this.currentIndex + 1}/${this.sentences.length}`);
        return {
            status: this.status,
            message,
            sentences: this.sentences,
            sentenceIndex: this.currentIndex,
            word: this.word,
            position: this.audio?.currentTime ?? 0,
            duration: Number.isFinite(this.audio?.duration) ? this.audio!.duration : 0,
        };
    }

    start(text: string, settings: SpeechSettings, index = 0): void {
        this.begin(text, settings, index, false, null);
    }

    reconfigure(text: string, settings: SpeechSettings): void {
        if (this.status === "idle") return;
        const old = this.sentences[this.currentIndex];
        const next = sentencesFrom(text);
        const target = old && next.length ? continuationIndex(old, this.sentences.length, next) : 0;
        const anchor =
            this.word && old
                ? {
                      word: this.word.text,
                      progress: (this.word.start - old.start) / Math.max(1, old.text.length),
                  }
                : this.anchor;
        this.begin(text, settings, target, this.status === "paused", anchor);
    }

    private key(position = this.active): number | undefined {
        return this.chunks[position]?.[0];
    }

    private get current(): Chunk | undefined {
        const key = this.key();
        return key === undefined ? undefined : this.cache.get(key);
    }

    /** Cancels every in-flight request. With `keepComplete`, fully fetched audio stays cached. */
    private invalidate(keepComplete = false): void {
        this.job = nextJobId();
        // A delayed cancellation must not interfere with a later generation on the server.
        void this.service.cancel(this.job).catch((error) => {
            if (String(error) !== "Stopped") console.warn("Cannot cancel synthesis:", error);
        });
        this.detach(keepComplete);
        for (const [key, chunk] of this.cache) {
            if (keepComplete && chunk.complete) continue;
            chunk.resource.dispose();
            this.cache.delete(key);
        }
        this.fetching.clear();
        this.word = null;
    }

    /**
     * Plans playback from `start`, reusing complete cached chunks as they are and
     * filling only the gaps between them. The gap after `start` begins with a single
     * sentence, so an uncached target keeps first-sentence priority.
     */
    private plan(start: number): number[][] {
        const kept = [...this.cache.values()]
            .filter((chunk) => chunk.complete && chunk.indices[0] >= start)
            .sort((a, b) => a.indices[0] - b.indices[0]);
        const plan: number[][] = [];
        let next = start;
        for (const chunk of kept) {
            const first = chunk.indices[0];
            if (first < next) continue;
            plan.push(...chunkSentences(next, first), chunk.indices);
            next = chunk.indices[chunk.indices.length - 1] + 1;
        }
        plan.push(...chunkSentences(next, this.sentences.length));
        return plan;
    }

    private begin(
        text: string,
        settings: SpeechSettings,
        start: number,
        paused: boolean,
        anchor: Anchor | null,
    ): void {
        this.invalidate();
        this.text = text;
        this.settings = { ...settings };
        this.sentences = sentencesFrom(text);
        this.currentIndex = start;
        this.chunks = this.plan(start);
        this.active = 0;
        this.anchor = anchor;
        this.error = "";
        this.status = this.chunks.length ? (paused ? "paused" : "buffering") : "idle";
        this.emit();
        this.fill();
    }

    stop(): void {
        this.invalidate();
        this.text = "";
        this.sentences = [];
        this.chunks = [];
        this.anchor = null;
        this.currentIndex = 0;
        this.status = "idle";
        this.error = "";
        this.emit();
    }

    pause(): void {
        if (this.status === "idle") return;
        this.status = "paused";
        this.audio?.pause();
        this.emit();
    }

    resume(): void {
        if (this.status !== "paused") return;
        this.status = "buffering";
        if (this.current?.ready) this.attach(this.audio?.currentTime ?? 0);
        else this.emit();
        this.fill();
    }

    setLocal(speed: number, volume: number): void {
        this.speed = Math.max(0.5, Math.min(3, speed));
        this.volume = Math.max(0, Math.min(1, volume));
        if (this.audio) {
            this.audio.playbackRate = this.speed;
            this.audio.volume = this.volume;
        }
    }

    seek(seconds: number): void {
        if (!this.audio) return;
        const target = this.audio.currentTime + seconds;
        if (target < 0 && this.currentIndex > 0) this.jump(this.currentIndex - 1);
        else if (target >= this.audio.duration && this.currentIndex + 1 < this.sentences.length)
            this.jump(this.currentIndex + 1);
        else {
            this.audio.currentTime = Math.max(0, Math.min(this.audio.duration || 0, target));
            this.tick();
        }
    }

    jump(index: number): void {
        if (index < 0 || index >= this.sentences.length || this.status === "idle") return;
        for (const chunk of this.cache.values()) {
            if (!chunk.ready) continue;
            const timing = chunk.timing.find((item) => item.index === index);
            if (!timing) continue;
            const position = this.chunks.findIndex((item) => item[0] === chunk.indices[0]);
            if (position >= 0) {
                this.detach(true);
                this.active = position;
            } else {
                // Audio from before the current plan: re-plan from it, keeping the cache.
                this.replan(chunk.indices[0]);
            }
            this.currentIndex = index;
            this.attach(timing.startMs / 1000);
            this.fill();
            return;
        }
        this.replan(index);
        this.currentIndex = index;
        this.emit();
        this.fill();
    }

    /** Restarts the plan at `start` without discarding audio that was already fetched. */
    private replan(start: number): void {
        this.invalidate(true);
        this.chunks = this.plan(start);
        this.active = 0;
        this.anchor = null;
        this.error = "";
        if (this.status !== "paused") this.status = "buffering";
    }

    tick(): void {
        const chunk = this.current;
        if (!this.audio || !chunk) return;
        const ms = this.audio.currentTime * 1000;
        for (const timing of chunk.timing) {
            if (timing.startMs <= ms) this.currentIndex = timing.index;
        }
        this.word = null;
        for (const word of chunk.words) {
            if (word.offsetMs > ms + 60) break;
            this.word = word;
        }
        this.emit();
    }

    private fill(): void {
        if (this.status === "idle") return;
        const job = this.job;
        // Start the first sentence and its short bridge together. Larger batches only
        // start once current audio is ready; paused restarts prime just the current chunk.
        const ahead =
            this.status === "paused"
                ? 0
                : this.current?.ready
                  ? LOOKAHEAD_CHUNKS
                  : 1;
        const limit = Math.min(this.active + ahead, this.chunks.length - 1);
        for (let position = this.active; position <= limit && job === this.job; position++) {
            if (this.fetching.size >= MAX_IN_FLIGHT) break;
            const indices = this.chunks[position];
            if (this.cache.has(indices[0]) || this.fetching.has(indices[0])) continue;
            this.fetching.add(indices[0]);
            void this.fetchChunk(indices, job);
        }
    }

    private async fetchChunk(indices: number[], job: number): Promise<void> {
        const target = indices[0];
        try {
            const first = this.sentences[indices[0]];
            const last = this.sentences[indices[indices.length - 1]];
            const text = this.text.slice(first.start, last.end);
            const timing = (words: SpokenWord[]) =>
                indices.map((index, position) => ({
                    index,
                    startMs:
                        position === 0
                            ? 0
                            : (words.find((word) => word.start >= this.sentences[index].start)
                                  ?.offsetMs ?? position * 500),
                }));
            const stream = this.createStream((message) => {
                if (job === this.job) this.fail(message);
            });
            let receivedBytes = 0;
            let completed = false;
            const boundaries: WordBoundary[] = [];
            if (stream)
                this.cache.set(target, {
                    resource: stream,
                    indices,
                    ready: false,
                    complete: false,
                    words: [],
                    timing: timing([]),
                });
            const onUpdate = stream
                ? (update: SynthesisUpdate) => {
                      if (
                          completed ||
                          job !== this.job ||
                          this.cache.get(target)?.resource !== stream
                      )
                          return;
                      try {
                          const chunk = this.cache.get(target)!;
                          if (update.type === "audio") {
                              const bytes = decodeAudio(update.data);
                              receivedBytes += bytes.length;
                              stream.append(bytes);
                              chunk.ready ||= bytes.length > 0;
                          } else {
                              boundaries.push(...update.boundaries);
                              chunk.words = alignWords(text, boundaries, first.start);
                              chunk.timing = timing(chunk.words);
                          }
                          // A continuation seek needs its word anchor before starting playback.
                          if (target === this.key() && chunk.ready && !this.audio && !this.anchor)
                              this.attach();
                          this.fill();
                      } catch (error) {
                          if (job === this.job) this.fail(`Audio streaming failed: ${error}`);
                      }
                  }
                : undefined;
            const result = await this.service.synthesize(
                { ...this.settings, text, rate: 0 },
                job,
                onUpdate,
            );
            if (job !== this.job) return;
            completed = true;
            if (!result.audioBase64) throw new Error("The speech service returned no audio");
            const words = alignWords(text, result.wordBoundaries, first.start);
            if (stream) {
                // Completion can overtake queued IPC updates. Reconcile the missing tail
                // from the authoritative result, and ignore any later duplicate updates.
                if (receivedBytes < audioByteLength(result.audioBase64)) {
                    const bytes = decodeAudio(result.audioBase64);
                    stream.append(bytes.subarray(receivedBytes));
                }
                stream.finish();
                this.cache.set(target, {
                    resource: stream,
                    indices,
                    ready: true,
                    complete: true,
                    words,
                    timing: timing(words),
                });
            } else {
                this.cache.set(target, {
                    resource: this.createAudio(result.audioBase64),
                    indices,
                    ready: true,
                    complete: true,
                    words,
                    timing: timing(words),
                });
            }
            if (target === this.key() && !this.audio) this.attach();
        } catch (error) {
            if (job === this.job) this.fail(`Synthesis failed: ${error}`);
        } finally {
            if (job === this.job) {
                this.fetching.delete(target);
                this.fill();
            }
        }
    }

    private attach(seekTime = 0): void {
        const chunk = this.current;
        if (!chunk?.ready) return;
        const job = this.job;
        this.detach();
        const audio = chunk.resource.element;
        this.audio = audio;
        audio.playbackRate = this.speed;
        audio.volume = this.volume;
        audio.preservesPitch = true;
        if (this.anchor) {
            const anchor = this.anchor;
            const sentence = this.sentences[this.currentIndex];
            const expected = sentence.start + anchor.progress * sentence.text.length;
            const matches = chunk.words.filter(
                (word) => word.text.toLocaleLowerCase() === anchor.word.toLocaleLowerCase(),
            );
            const nearest = matches.sort(
                (a, b) => Math.abs(a.start - expected) - Math.abs(b.start - expected),
            )[0];
            if (nearest) seekTime = nearest.offsetMs / 1000;
            this.anchor = null;
        }
        const applySeek = () => {
            if (job === this.job && this.audio === audio) audio.currentTime = seekTime;
        };
        applySeek();
        audio.addEventListener("loadedmetadata", applySeek, { once: true });
        this.removeMetadataListener = () => audio.removeEventListener("loadedmetadata", applySeek);
        audio.ontimeupdate = () => this.tick();
        audio.onended = () => {
            if (job !== this.job || this.audio !== audio) return;
            this.detach(true);
            this.word = null;
            this.active++;
            if (this.active >= this.chunks.length) {
                this.stop();
                return;
            }
            this.currentIndex = this.chunks[this.active][0];
            this.status = "buffering";
            if (this.current?.ready) this.attach();
            else this.emit();
            this.fill();
        };
        audio.onerror = () => {
            if (job === this.job && this.audio === audio) this.fail("Audio playback failed");
        };
        if (this.status !== "paused") {
            this.status = "playing";
            void audio.play().catch((error) => {
                if (job === this.job && this.audio === audio)
                    this.fail(`Audio playback failed: ${error}`);
            });
        }
        this.tick();
    }

    private detach(release = false): void {
        this.removeMetadataListener?.();
        this.removeMetadataListener = null;
        if (this.audio) {
            this.audio.onended = null;
            this.audio.onerror = null;
            this.audio.ontimeupdate = null;
            this.audio.pause();
            this.audio = null;
        }
        // Released audio keeps only its compressed bytes; no decoder or media element.
        if (release) this.current?.resource.release?.();
    }

    private fail(message: string): void {
        this.stop();
        this.error = message;
        this.emit();
    }

    private emit(): void {
        this.onChange(this.view);
    }
}
