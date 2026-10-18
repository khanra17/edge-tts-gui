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
    ready: boolean;
    words: SpokenWord[];
    timing: { index: number; startMs: number }[];
}

interface Anchor {
    word: string;
    progress: number;
}

const MAX_IN_FLIGHT = 3;
const LOOKAHEAD_CHUNKS = 3;
const HISTORY_CHUNKS = 1;

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
    private chunks: number[][] = [];
    private active = 0;
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

    start(text: string, settings: SpeechSettings): void {
        this.begin(text, settings, 0, false, null);
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

    private invalidate(): void {
        this.job = nextJobId();
        // A delayed cancellation must not interfere with a later generation on the server.
        void this.service.cancel(this.job).catch((error) => {
            if (String(error) !== "Stopped") console.warn("Cannot cancel synthesis:", error);
        });
        this.detach();
        for (const chunk of this.cache.values()) chunk.resource.dispose();
        this.cache.clear();
        this.fetching.clear();
        this.word = null;
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
        this.chunks = chunkSentences(start, this.sentences.length);
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
        if (this.cache.get(this.active)?.ready) this.attach(this.audio?.currentTime ?? 0);
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
        if (index < 0 || index >= this.sentences.length) return;
        for (const [chunkIndex, chunk] of this.cache) {
            if (!chunk.ready) continue;
            const timing = chunk.timing.find((item) => item.index === index);
            if (timing) {
                this.detach(true);
                this.active = chunkIndex;
                this.currentIndex = index;
                this.attach(timing.startMs / 1000);
                this.fill();
                return;
            }
        }
        this.begin(this.text, this.settings, index, this.status === "paused", null);
    }

    tick(): void {
        const chunk = this.cache.get(this.active);
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
        this.evict();
        const job = this.job;
        // Start the first sentence and its short bridge together. Larger batches only
        // start once current audio is ready; paused restarts prime just the current chunk.
        const ahead =
            this.status === "paused"
                ? 0
                : this.cache.get(this.active)?.ready
                  ? LOOKAHEAD_CHUNKS
                  : 1;
        const limit = Math.min(this.active + ahead, this.chunks.length - 1);
        for (let target = this.active; target <= limit && job === this.job; target++) {
            if (this.fetching.size >= MAX_IN_FLIGHT) break;
            if (this.cache.has(target) || this.fetching.has(target)) continue;
            this.fetching.add(target);
            void this.fetchChunk(target, job);
        }
    }

    private async fetchChunk(target: number, job: number): Promise<void> {
        try {
            const indices = this.chunks[target];
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
                    ready: false,
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
                          if (target === this.active && chunk.ready && !this.audio && !this.anchor)
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
            if (job !== this.job || target < this.active - HISTORY_CHUNKS) return;
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
                    ready: true,
                    words,
                    timing: timing(words),
                });
            } else {
                this.cache.set(target, {
                    resource: this.createAudio(result.audioBase64),
                    ready: true,
                    words,
                    timing: timing(words),
                });
            }
            if (target === this.active && !this.audio) this.attach();
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
        const chunk = this.cache.get(this.active);
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
            if (this.cache.get(this.active)?.ready) this.attach();
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
        if (release) this.cache.get(this.active)?.resource.release?.();
    }

    private evict(): void {
        for (const [index, chunk] of this.cache) {
            if (index < this.active - HISTORY_CHUNKS) {
                chunk.resource.dispose();
                this.cache.delete(index);
            }
        }
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
