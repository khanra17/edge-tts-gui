export interface Voice {
    language: string;
    name: string;
    code: string;
}

export interface SpeechSettings {
    voice: string;
    pitch: number;
}

export interface SpeechRequest extends SpeechSettings {
    text: string;
    rate: number;
}

export interface WordBoundary {
    text: string;
    offsetMs: number;
    durationMs: number;
}

export interface SynthesizedSpeech {
    audioBase64: string;
    wordBoundaries: WordBoundary[];
}

export interface TextRange {
    start: number;
    end: number;
}

export interface Sentence extends TextRange {
    index: number;
    text: string;
}

export interface SpokenWord extends TextRange, WordBoundary {}

export type SynthesisUpdate =
    { type: "audio"; data: string } | { type: "words"; boundaries: WordBoundary[] };

export interface SpeechService {
    synthesize(
        request: SpeechRequest,
        jobId: number,
        onUpdate?: (update: SynthesisUpdate) => void,
    ): Promise<SynthesizedSpeech>;
    cancel(jobId: number): Promise<void>;
}

export interface AudioResource {
    element: HTMLAudioElement;
    dispose(): void;
}

export interface StreamingAudioResource extends AudioResource {
    append(bytes: Uint8Array<ArrayBuffer>): void;
    finish(): void;
}

export type PlaybackStatus = "idle" | "buffering" | "playing" | "paused";

export interface PlaybackView {
    status: PlaybackStatus;
    message: string;
    sentences: readonly Sentence[];
    sentenceIndex: number;
    word: SpokenWord | null;
    position: number;
    duration: number;
}
