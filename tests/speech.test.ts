import assert from "node:assert/strict";
import test from "node:test";
import {
    alignWords,
    chunkSentences,
    continuationIndex,
    nextJobId,
    sentencesFrom,
} from "../src/speech.ts";
import { loadPreferences } from "../src/settings.ts";

test("sentence offsets preserve whitespace, Unicode, and repeated text", () => {
    const text = "  Hello world.\n你好世界！ Again? ";
    const sentences = sentencesFrom(text);
    assert.deepEqual(
        sentences.map((sentence) => sentence.text),
        ["Hello world.", "你好世界！", "Again?"],
    );
    for (const sentence of sentences)
        assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
});

test("filenames and dotted identifiers do not become sentence boundaries", () => {
    const example =
        "Draft stack-aware AGENTS.md guidance in a consistent format, with your approval";
    assert.deepEqual(
        sentencesFrom(example).map((sentence) => sentence.text),
        [example],
    );
    for (const token of [
        "AGENTS.md",
        "AGENTS.MD",
        "src/main.ts",
        "config.json",
        "node.js",
        "v1.2.3",
        "3.14",
        "a.b@example.com",
    ]) {
        const input = `Read ${token} before continuing. Then stop.`;
        assert.deepEqual(
            sentencesFrom(input).map((sentence) => sentence.text),
            [`Read ${token} before continuing.`, "Then stop."],
        );
    }
});

test("URLs, inline code, and titles retain their internal punctuation and source offsets", () => {
    for (const [input, expected] of [
        ["Dr. Smith reads AGENTS.md. Next task.", ["Dr. Smith reads AGENTS.md.", "Next task."]],
        [
            "Read https://example.com/file.md?q=1.5&next=yes now. Done!",
            ["Read https://example.com/file.md?q=1.5&next=yes now.", "Done!"],
        ],
        [
            "Open https://example.com/file.md?x=1.5. Next task.",
            ["Open https://example.com/file.md?x=1.5.", "Next task."],
        ],
        [
            'Open "https://example.com/file.md?x=1.5." Next task.',
            ['Open "https://example.com/file.md?x=1.5."', "Next task."],
        ],
        [
            "Run `foo.bar(); baz()` first. Next step.",
            ["Run `foo.bar(); baz()` first.", "Next step."],
        ],
        ["Use e.g. this example. It works.", ["Use e.g. this example.", "It works."]],
    ] as const) {
        const sentences = sentencesFrom(input);
        assert.deepEqual(
            sentences.map((sentence) => sentence.text),
            [...expected],
        );
        for (const sentence of sentences)
            assert.equal(input.slice(sentence.start, sentence.end), sentence.text);
    }
});

test("sentence boundaries preserve quotes, CJK punctuation, and paragraph breaks", () => {
    const input = '“你好！”下一句。\nA heading\n"Really?" Yes!';
    assert.deepEqual(
        sentencesFrom(input).map((sentence) => sentence.text),
        ["“你好！”", "下一句。", "A heading", '"Really?"', "Yes!"],
    );
    assert.deepEqual(sentencesFrom("  \n\t"), []);
});

test("chunks use a one-sentence bridge followed by three-sentence batches", () => {
    assert.deepEqual(chunkSentences(2, 8), [[2], [3], [4, 5, 6], [7]]);
    assert.deepEqual(chunkSentences(0, 1), [[0]]);
    assert.deepEqual(chunkSentences(0, 2), [[0], [1]]);
    assert.deepEqual(chunkSentences(8, 8), []);
    assert.deepEqual(chunkSentences(2, 8).flat(), [2, 3, 4, 5, 6, 7]);
});

test("word alignment walks repeated words in order and accepts service punctuation", () => {
    const words = alignWords(
        "Go, go now.",
        [
            { text: "Go", offsetMs: 0, durationMs: 100 },
            { text: "go", offsetMs: 100, durationMs: 100 },
            { text: "now.", offsetMs: 200, durationMs: 100 },
        ],
        10,
    );
    assert.deepEqual(
        words.map(({ start, end }) => [start, end]),
        [
            [10, 12],
            [14, 16],
            [17, 21],
        ],
    );
});

test("mode changes find the corresponding sentence instead of restarting the document", () => {
    const old = sentencesFrom("Header. Code example. Continue reading here.");
    const next = sentencesFrom("Header. Continue reading here.");
    assert.equal(continuationIndex(old[2], old.length, next), 1);
});

test("job IDs are unique and monotonic across playback and export", () => {
    assert.ok(nextJobId() < nextJobId());
    assert.ok(Number.isSafeInteger(nextJobId()));
});

test("preferences retain valid zero volume and clamp invalid stored values", () => {
    const values: Record<string, string> = {
        edge_tts_volume: "0",
        edge_tts_speed: "999",
        edge_tts_pitch: "NaN",
        edge_tts_markdown: "true",
        edge_tts_pronounce_code: "false",
    };
    const prefs = loadPreferences({ getItem: (key) => values[key] ?? null });
    assert.equal(prefs.volume, 0);
    assert.equal(prefs.speed, 3);
    assert.equal(prefs.pitch, 0);
    assert.equal(prefs.markdown, true);
    assert.equal(prefs.code, false);
});
