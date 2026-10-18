import assert from "node:assert/strict";
import test from "node:test";
import { audioByteLength, decodeAudio } from "../src/audio.ts";

test("MP3 completion sizes account for base64 padding without decoding the full audio", () => {
    for (const value of ["", "a", "ab", "abc", "abcd", "abcde", "x".repeat(6001)]) {
        const encoded = btoa(value);
        assert.equal(audioByteLength(encoded), value.length);
        assert.equal(decodeAudio(encoded).length, value.length);
    }
});
