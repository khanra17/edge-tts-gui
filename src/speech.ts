import type { Sentence, SpokenWord, WordBoundary } from "./types.ts";

let generation = Date.now() * 1000;

// Shared by playback and export. Also survives WebView reloads without reusing IDs.
export function nextJobId(): number {
    generation = Math.max(generation + 1, Date.now() * 1000);
    return generation;
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export function sentencesFrom(text: string): Sentence[] {
    // Keep offsets unchanged while shielding punctuation that belongs to code or URLs.
    // Intl handles quotes and multilingual boundaries; token masks also cover
    // filenames, dotted identifiers, decimals, and versions across ICU versions.
    const mask = (value: string) => value.replace(/[.!?。！？…]/gu, "a");
    const protectedText = text
        .replace(/`[^`\r\n]+`/gu, mask)
        .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/giu, (url) => {
            const body = url.replace(/[.!?,;:)\]}'"’”]+$/u, "");
            return mask(body) + url.slice(body.length);
        })
        .replace(/[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu, mask)
        .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St)\./giu, mask);
    const sentences: Sentence[] = [];
    for (const segment of sentenceSegmenter.segment(protectedText)) {
        const value = segment.segment.trim();
        if (!value) continue;
        const start = segment.index + segment.segment.indexOf(value);
        const end = start + value.length;
        sentences.push({ index: sentences.length, text: text.slice(start, end), start, end });
    }
    return sentences;
}

export function chunkSentences(start: number, total: number): number[][] {
    if (start >= total) return [];
    // A short bridge avoids waiting for a large batch after a very short first sentence.
    const chunks = [[start]];
    if (start + 1 < total) chunks.push([start + 1]);
    for (let index = start + 2; index < total; index += 3) {
        chunks.push(
            Array.from({ length: Math.min(3, total - index) }, (_, offset) => index + offset),
        );
    }
    return chunks;
}

export function alignWords(text: string, boundaries: WordBoundary[], start = 0): SpokenWord[] {
    const lower = text.toLocaleLowerCase();
    let cursor = 0;
    const words: SpokenWord[] = [];
    for (const boundary of boundaries) {
        let word = boundary.text.trim();
        if (!word) continue;
        let position = lower.indexOf(word.toLocaleLowerCase(), cursor);
        if (position < 0) {
            word = word.replace(/[^\p{L}\p{N}]/gu, "");
            position = word ? lower.indexOf(word.toLocaleLowerCase(), cursor) : -1;
        }
        if (position < 0) continue;
        cursor = position + word.length;
        words.push({ ...boundary, start: start + position, end: start + cursor });
    }
    return words;
}

export function continuationIndex(
    previous: Sentence,
    oldCount: number,
    sentences: Sentence[],
): number {
    const approximate = Math.round(
        (previous.index / Math.max(1, oldCount - 1)) * (sentences.length - 1),
    );
    const tokens = (text: string) =>
        new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const oldWords = tokens(previous.text);
    let best = 0;
    let bestScore = -Infinity;
    sentences.forEach((sentence, index) => {
        const words = tokens(sentence.text);
        const shared = [...oldWords].filter((word) => words.has(word)).length;
        const score =
            (5 * shared) / Math.max(1, oldWords.size) -
            Math.abs(index - approximate) / Math.max(1, sentences.length);
        if (score > bestScore) {
            bestScore = score;
            best = index;
        }
    });
    return best;
}
