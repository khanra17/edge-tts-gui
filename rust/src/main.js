import "./style.css";
import { marked } from "marked";
import DOMPurify from "dompurify";

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const listen = tauri.event.listen;

const content = document.querySelector("#content");
const count = document.querySelector("#count");
const statusText = document.querySelector("#status");
const statusDot = document.querySelector("#status-dot");
const timeDisplay = document.querySelector("#time-display");
const language = document.querySelector("#language");
const voice = document.querySelector("#voice");
const speedInput = document.querySelector("#speed");
const speedVal = document.querySelector("#speed-val");
const pitchInput = document.querySelector("#pitch");
const pitchVal = document.querySelector("#pitch-val");
const volumeInput = document.querySelector("#volume");
const volumeVal = document.querySelector("#volume-val");
const muteBtn = document.querySelector("#mute-btn");
const progress = document.querySelector("#progress");

const playButton = document.querySelector("#play");
const stopButton = document.querySelector("#stop");
const rewindButton = document.querySelector("#rewind-5s");
const forwardButton = document.querySelector("#forward-5s");
const saveButton = document.querySelector("#save");
const closeButton = document.querySelector("#close");
const clearButton = document.querySelector("#clear-text");
const copyButton = document.querySelector("#copy-text");
const markdownToggle = document.querySelector("#markdown-toggle");
const codeToggle = document.querySelector("#code-toggle");
const markdownPreview = document.querySelector("#markdown-preview");
const autoScrollBtn = document.querySelector("#auto-scroll-btn");

let voices = [];
let audio = null;
let audioUrl = "";
let jobId = 0;

// Playback States: 'idle' | 'synthesizing' | 'playing' | 'paused'
let playState = "idle";
let isMuted = false;
let previousVolume = 1.0;
let markdownMode = localStorage.getItem("edge_tts_markdown") === "true";
let pronounceCode = localStorage.getItem("edge_tts_pronounce_code") !== "false";
let playingRenderedMarkdown = false;
let renderedSpeechSegments = [];

// Auto-scroll state
let autoScroll = true;
let isProgrammaticScroll = false;
let programmaticScrollTimeout = null;

// Chunk buffer state: quick start with 1 sentence, followed by 3-sentence chunks
let sentences = [];
let spokenText = "";
let currentIndex = 0;
let chunks = [];
let activeChunkIndex = 0;
let activeChunk = null;
let chunkMap = new Map();
let wordMap = new Map();
let fetchingChunkIndices = new Set();
let activeWordIndex = -1;
let wordHighlightFrame = null;
let pendingSeekWord = "";
let pendingSeekProgress = 0;

const SUBSEQUENT_CHUNK_SIZE = 3;
const MAX_LOOKAHEAD_CHUNKS = 2;

function nextJob() {
  jobId += 1;
  return jobId;
}

function markdownBody(markdown) {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
}

function sanitizedMarkdown(markdown) {
  return DOMPurify.sanitize(marked.parse(markdownBody(markdown)), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style"],
  });
}

function renderMarkdownPreview() {
  markdownPreview.innerHTML = sanitizedMarkdown(content.value);
  markdownPreview.classList.toggle("skip-code", !pronounceCode);
}

function buildMarkdownSpeechModel(root) {
  const blockTags = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "FOOTER", "H1", "H2", "H3",
    "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "P", "PRE", "SECTION", "TR",
  ]);
  let text = "";
  const segments = [];

  const appendSynthetic = (value) => {
    text += value;
  };

  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.data) return;
      const start = text.length;
      text += node.data;
      segments.push({ node, start, end: text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;
    if ((tag === "CODE" || tag === "PRE") && !pronounceCode) {
      appendSynthetic(tag === "PRE" ? "\n" : " ");
      return;
    }
    if (tag === "IMG") {
      appendSynthetic(node.getAttribute("alt") || "");
      return;
    }
    if (tag === "BR") {
      appendSynthetic("\n");
      return;
    }

    node.childNodes.forEach(visit);
    if (tag === "TD" || tag === "TH") appendSynthetic(" ");
    if (blockTags.has(tag)) appendSynthetic("\n");
  };

  root.childNodes.forEach(visit);
  return { text, segments };
}

function markdownSpeechModel(markdown, usePreview = false) {
  if (!markdown.trim()) return { text: "", segments: [] };
  if (usePreview) return buildMarkdownSpeechModel(markdownPreview);

  const root = document.createElement("div");
  root.innerHTML = sanitizedMarkdown(markdown);
  return buildMarkdownSpeechModel(root);
}

function textForSpeech(text) {
  return markdownMode ? markdownSpeechModel(text).text : text;
}

function updateCodeToggle() {
  codeToggle.textContent = `Code: ${pronounceCode ? "Speak" : "Skip"}`;
  codeToggle.classList.toggle("active", !pronounceCode);
  codeToggle.setAttribute("aria-pressed", String(!pronounceCode));
  markdownPreview.classList.toggle("skip-code", !pronounceCode);
  localStorage.setItem("edge_tts_pronounce_code", String(pronounceCode));
  updateCount();
}

function updateMarkdownToggle() {
  markdownToggle.textContent = `Markdown: ${markdownMode ? "On" : "Off"}`;
  markdownToggle.classList.toggle("active", markdownMode);
  markdownToggle.setAttribute("aria-pressed", String(markdownMode));
  content.hidden = markdownMode;
  markdownPreview.hidden = !markdownMode;
  if (markdownMode) renderMarkdownPreview();
  localStorage.setItem("edge_tts_markdown", String(markdownMode));
  updateCount();
}

function parseSentences(text) {
  if (!text) return [];
  const regex = /[^.!?\n。！？；…]+[.!?\n。！？；…]*/g;
  const list = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const start = match.index + raw.indexOf(trimmed);
      const end = start + trimmed.length;
      list.push({
        index: list.length,
        text: trimmed,
        start,
        end,
      });
    }
  }
  if (list.length === 0 && text.trim().length > 0) {
    const trimmed = text.trim();
    const start = text.indexOf(trimmed);
    list.push({
      index: 0,
      text: trimmed,
      start,
      end: start + trimmed.length,
    });
  }
  return list;
}

function markProgrammaticScroll() {
  isProgrammaticScroll = true;
  if (programmaticScrollTimeout) clearTimeout(programmaticScrollTimeout);
  programmaticScrollTimeout = setTimeout(() => {
    isProgrammaticScroll = false;
  }, 120);
}

function updateAutoScrollButton() {
  if (!autoScrollBtn) return;
  const isPlaybackActive = playState === "playing" || playState === "paused" || playState === "synthesizing";
  autoScrollBtn.hidden = autoScroll || !isPlaybackActive;
}

function disableAutoScroll() {
  if (!autoScroll) return;
  autoScroll = false;
  updateAutoScrollButton();
}

function enableAutoScroll() {
  autoScroll = true;
  updateAutoScrollButton();
  scrollToCurrentHighlight();
}

function scrollToCurrentHighlight() {
  if (currentIndex < 0 || currentIndex >= sentences.length) return;
  const sentence = sentences[currentIndex];
  if (!sentence) return;

  if (playingRenderedMarkdown) {
    markProgrammaticScroll();
    const overlaps = renderedSpeechSegments.filter(
      (segment) => segment.end > sentence.start && segment.start < sentence.end,
    );
    if (overlaps.length > 0) {
      overlaps[0].node.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } else {
    markProgrammaticScroll();
    let start = sentence.start;
    let end = sentence.end;
    const boundaries = wordMap.get(currentIndex) || [];
    if (activeWordIndex >= 0 && activeWordIndex < boundaries.length) {
      const localRange = findBoundaryRange(sentence.text, activeWordIndex, boundaries);
      if (localRange) {
        start = sentence.start + localRange.start;
        end = sentence.start + localRange.end;
      }
    }

    const textBefore = content.value.slice(0, start);
    const lineIndex = textBefore.split("\n").length - 1;
    const totalLines = content.value.split("\n").length;
    const approxLineHeight = content.scrollHeight / Math.max(1, totalLines);
    const targetTop = Math.max(0, lineIndex * approxLineHeight - content.clientHeight / 2);

    content.scrollTo({ top: targetTop, behavior: "smooth" });
    content.focus({ preventScroll: true });
    content.setSelectionRange(start, end);
  }
}

function highlightSentence(idx) {
  if (idx < 0 || idx >= sentences.length) return;
  const sentence = sentences[idx];

  if (!playingRenderedMarkdown) {
    if (autoScroll) {
      markProgrammaticScroll();
      content.focus({ preventScroll: true });
      content.setSelectionRange(sentence.start, sentence.end);
    } else {
      const prevTop = content.scrollTop;
      const prevLeft = content.scrollLeft;
      content.setSelectionRange(sentence.start, sentence.end);
      content.scrollTop = prevTop;
      content.scrollLeft = prevLeft;
    }
    return;
  }

  const overlaps = renderedSpeechSegments.filter(
    (segment) => segment.end > sentence.start && segment.start < sentence.end,
  );
  if (overlaps.length === 0) return;

  const ranges = overlaps.map((segment) => {
    const range = document.createRange();
    range.setStart(segment.node, Math.max(0, sentence.start - segment.start));
    range.setEnd(segment.node, Math.min(segment.node.data.length, sentence.end - segment.start));
    return range;
  });

  if (CSS.highlights && globalThis.Highlight) {
    CSS.highlights.set("spoken-sentence", new Highlight(...ranges));
  } else {
    const range = document.createRange();
    const first = overlaps[0];
    const last = overlaps[overlaps.length - 1];
    range.setStart(first.node, Math.max(0, sentence.start - first.start));
    range.setEnd(last.node, Math.min(last.node.data.length, sentence.end - last.start));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (autoScroll) {
    markProgrammaticScroll();
    overlaps[0].node.parentElement?.scrollIntoView({ block: "nearest" });
  }
}

function findBoundaryRange(sentenceText, targetIndex, boundaries) {
  const lowerText = sentenceText.toLocaleLowerCase();
  let cursor = 0;

  for (let index = 0; index <= targetIndex; index++) {
    const rawWord = typeof boundaries[index]?.text === "string" ? boundaries[index].text.trim() : "";
    if (!rawWord) continue;

    let word = rawWord;
    let position = lowerText.indexOf(word.toLocaleLowerCase(), cursor);
    if (position === -1) {
      const cleanWord = rawWord.replace(/[^\p{L}\p{N}]/gu, "");
      if (cleanWord) {
        word = cleanWord;
        position = lowerText.indexOf(cleanWord.toLocaleLowerCase(), cursor);
      }
    }
    if (position === -1) continue;

    const range = { start: position, end: position + word.length };
    cursor = range.end;
    if (index === targetIndex) return range;
  }
  return null;
}

function highlightRenderedWord(start, end) {
  const overlaps = renderedSpeechSegments.filter(
    (segment) => segment.end > start && segment.start < end,
  );
  if (overlaps.length === 0 || !CSS.highlights || !globalThis.Highlight) return;

  const ranges = overlaps.map((segment) => {
    const range = document.createRange();
    range.setStart(segment.node, Math.max(0, start - segment.start));
    range.setEnd(segment.node, Math.min(segment.node.data.length, end - segment.start));
    return range;
  });
  CSS.highlights.set("spoken-word", new Highlight(...ranges));
}

function updateWordHighlight() {
  if (!audio || playState !== "playing" || currentIndex >= sentences.length) return;
  const boundaries = wordMap.get(currentIndex) || [];
  const currentMs = audio.currentTime * 1000 + 60;
  let targetIndex = -1;

  for (let index = 0; index < boundaries.length; index++) {
    if (boundaries[index].offsetMs > currentMs) break;
    targetIndex = index;
  }
  if (targetIndex < 0 || targetIndex === activeWordIndex) return;

  const localRange = findBoundaryRange(sentences[currentIndex].text, targetIndex, boundaries);
  if (!localRange) return;
  activeWordIndex = targetIndex;
  const start = sentences[currentIndex].start + localRange.start;
  const end = sentences[currentIndex].start + localRange.end;

  if (playingRenderedMarkdown) {
    highlightRenderedWord(start, end);
  } else {
    if (autoScroll) {
      markProgrammaticScroll();
      content.focus({ preventScroll: true });
      content.setSelectionRange(start, end);
    } else {
      const prevTop = content.scrollTop;
      const prevLeft = content.scrollLeft;
      content.setSelectionRange(start, end);
      content.scrollTop = prevTop;
      content.scrollLeft = prevLeft;
    }
  }
}

function stopWordHighlightLoop() {
  if (wordHighlightFrame !== null) cancelAnimationFrame(wordHighlightFrame);
  wordHighlightFrame = null;
  activeWordIndex = -1;
  CSS.highlights?.delete("spoken-word");
}

function updateSentenceFromAudio() {
  if (!audio || !activeChunk || !activeChunk.sentenceTiming) return;
  const curMs = audio.currentTime * 1000;
  const timing = activeChunk.sentenceTiming.find(
    (t) => curMs >= t.startMs && curMs < t.endMs,
  );
  if (timing && timing.index !== currentIndex) {
    currentIndex = timing.index;
    activeWordIndex = -1;
    highlightSentence(currentIndex);
    updateTimeDisplay();
    setProgress(Math.round(((currentIndex + 1) / sentences.length) * 100));
    if (autoScroll) {
      scrollToCurrentHighlight();
    }
    updatePlayState("playing", `Sentence ${currentIndex + 1}/${sentences.length}`);
  }
}

function startWordHighlightLoop() {
  if (wordHighlightFrame !== null) return;
  const tick = () => {
    wordHighlightFrame = null;
    if (playState !== "playing") return;
    updateSentenceFromAudio();
    updateWordHighlight();
    wordHighlightFrame = requestAnimationFrame(tick);
  };
  wordHighlightFrame = requestAnimationFrame(tick);
}

function updatePlayState(newState, label = "") {
  playState = newState;

  if (statusDot) {
    statusDot.className = "dot " + newState;
  }

  switch (newState) {
    case "idle":
      autoScroll = true;
      playButton.textContent = "Play";
      playButton.disabled = false;
      stopButton.disabled = true;
      if (rewindButton) rewindButton.disabled = true;
      if (forwardButton) forwardButton.disabled = true;
      saveButton.disabled = false;
      statusText.textContent = label || "Ready";
      break;

    case "synthesizing":
      playButton.textContent = "Pause";
      playButton.disabled = false;
      stopButton.disabled = false;
      if (rewindButton) rewindButton.disabled = true;
      if (forwardButton) forwardButton.disabled = true;
      saveButton.disabled = true;
      statusText.textContent = label || "Synthesizing...";
      break;

    case "playing":
      playButton.textContent = "Pause";
      playButton.disabled = false;
      stopButton.disabled = false;
      if (rewindButton) rewindButton.disabled = !audio;
      if (forwardButton) forwardButton.disabled = !audio;
      saveButton.disabled = true;
      statusText.textContent = label || "Playing";
      break;

    case "paused":
      playButton.textContent = "Resume";
      playButton.disabled = false;
      stopButton.disabled = false;
      if (rewindButton) rewindButton.disabled = !audio;
      if (forwardButton) forwardButton.disabled = !audio;
      saveButton.disabled = true;
      statusText.textContent = label || "Paused";
      break;
  }

  updateAutoScrollButton();
}

function setProgress(value) {
  const isHidden = value == null;
  progress.classList.toggle("is-hidden", isHidden);
  progress.setAttribute("aria-hidden", String(isHidden));
  progress.value = isHidden ? 0 : value;
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds == null) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateTimeDisplay() {
  if (!timeDisplay) return;
  if (audio && (playState === "playing" || playState === "paused")) {
    const cur = formatTime(audio.currentTime);
    const dur = formatTime(audio.duration);
    const totalSentences = sentences.length > 0 ? sentences.length : 1;
    timeDisplay.textContent = `[${currentIndex + 1}/${totalSentences}] ${cur} / ${dur}`;
  } else {
    timeDisplay.textContent = "00:00 / 00:00";
  }
}

function activeVoiceCode() {
  const selected = voice.selectedOptions[0];
  return selected?.dataset.code || voices[0]?.code || "en-US, AvaNeural";
}

function getRateString() {
  const speed = parseFloat(speedInput.value) || 1.0;
  const pct = Math.round((speed - 1.0) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function currentSpeed() {
  return parseFloat(speedInput.value) || 1.0;
}

function updateSpeedLabel() {
  const speed = currentSpeed();
  speedVal.textContent = `${speed.toFixed(1)}x`;
  localStorage.setItem("edge_tts_speed", speedInput.value);

  if (audio) {
    audio.playbackRate = speed;
  }
}

function getPitchString() {
  const pitch = parseInt(pitchInput?.value || "0", 10) || 0;
  return pitch >= 0 ? `+${pitch}Hz` : `${pitch}Hz`;
}

function updatePitchLabel() {
  const pitch = parseInt(pitchInput?.value || "0", 10) || 0;
  const label = pitch >= 0 ? `+${pitch}Hz` : `${pitch}Hz`;
  if (pitchVal) pitchVal.textContent = label;
  localStorage.setItem("edge_tts_pitch", String(pitch));
}

async function onPitchChange() {
  if (playState === "playing" || playState === "paused") {
    const snapshot = capturePlaybackSnapshot();
    if (snapshot) {
      await continuePlaybackWithCurrentSettings(snapshot);
    }
  }
}

function currentVolume() {
  return isMuted ? 0 : parseFloat(volumeInput.value) || 1.0;
}

function updateVolumeLabel() {
  const vol = parseFloat(volumeInput.value) || 1.0;
  if (volumeVal) volumeVal.textContent = `${Math.round(vol * 100)}%`;
  localStorage.setItem("edge_tts_volume", volumeInput.value);

  if (audio) {
    audio.volume = currentVolume();
  }

  if (muteBtn) {
    muteBtn.textContent = isMuted || vol === 0 ? "🔇" : "🔊";
  }
}

function toggleMute() {
  if (isMuted) {
    isMuted = false;
    volumeInput.value = previousVolume || 1.0;
  } else {
    previousVolume = volumeInput.value || 1.0;
    isMuted = true;
  }
  updateVolumeLabel();
}

function setVoiceCode(code) {
  const item = voices.find((v) => v.code === code);
  if (!item) return;
  language.value = item.language;
  fillVoiceSelect(item.language, item.code);
  localStorage.setItem("edge_tts_voice", code);
}

function fillLanguageSelect() {
  const languages = [...new Set(voices.map((item) => item.language))];
  language.replaceChildren(...languages.map((name) => new Option(name, name)));
}

function fillVoiceSelect(languageName, selectedCode) {
  const items = voices.filter((item) => item.language === languageName);
  voice.replaceChildren(
    ...items.map((item) => {
      const option = new Option(item.name, item.name);
      option.dataset.code = item.code;
      option.selected = item.code === selectedCode;
      return option;
    }),
  );
}

function updateCount() {
  const sourceCount = content.value.replace(/\s+/g, "").length;
  if (markdownMode) {
    const spokenCount = textForSpeech(content.value).replace(/\s+/g, "").length;
    count.textContent = `Count: ${sourceCount} · Spoken: ${spokenCount}`;
  } else {
    count.textContent = `Count: ${sourceCount}`;
  }
}

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mpeg" });
}

function buildChunksFromIndex(startIdx, totalSentences) {
  const list = [];
  if (startIdx >= totalSentences) return list;

  // First chunk: ONLY 1 sentence for instantaneous quick start
  list.push({
    chunkIndex: 0,
    sentenceIndices: [startIdx],
  });

  // Subsequent chunks: small batches (3 sentences) for natural voice and cadence
  let curr = startIdx + 1;
  while (curr < totalSentences) {
    const end = Math.min(totalSentences, curr + SUBSEQUENT_CHUNK_SIZE);
    const indices = [];
    for (let i = curr; i < end; i++) {
      indices.push(i);
    }
    list.push({
      chunkIndex: list.length,
      sentenceIndices: indices,
    });
    curr = end;
  }
  return list;
}

function processChunkBoundaries(chunkSentences, wordBoundaries) {
  const sentenceTiming = [];
  const boundariesBySentence = new Map();
  chunkSentences.forEach((s) => boundariesBySentence.set(s.index, []));

  if (chunkSentences.length === 1) {
    const s = chunkSentences[0];
    boundariesBySentence.set(s.index, wordBoundaries || []);
    sentenceTiming.push({
      index: s.index,
      startMs: 0,
      endMs: Infinity,
    });
    return { boundariesBySentence, sentenceTiming };
  }

  let currentSentenceIdx = 0;
  let cursor = 0;
  const rawBoundaries = wordBoundaries || [];

  for (let bIdx = 0; bIdx < rawBoundaries.length; bIdx++) {
    const wb = rawBoundaries[bIdx];
    const rawWord = typeof wb.text === "string" ? wb.text.trim() : "";
    if (!rawWord) {
      boundariesBySentence.get(chunkSentences[currentSentenceIdx].index).push(wb);
      continue;
    }
    const cleanWord = rawWord.replace(/[^\p{L}\p{N}]/gu, "");

    let curText = chunkSentences[currentSentenceIdx].text.toLocaleLowerCase();
    let pos = curText.indexOf(rawWord.toLocaleLowerCase(), cursor);
    let matchedLen = rawWord.length;

    if (pos === -1 && cleanWord) {
      pos = curText.indexOf(cleanWord.toLocaleLowerCase(), cursor);
      matchedLen = cleanWord.length;
    }

    if (pos !== -1) {
      cursor = pos + matchedLen;
      boundariesBySentence.get(chunkSentences[currentSentenceIdx].index).push(wb);
      continue;
    }

    // Word not found in current sentence at or after cursor.
    // Check subsequent sentences in the chunk.
    let foundInSubsequent = false;
    for (let nextIdx = currentSentenceIdx + 1; nextIdx < chunkSentences.length; nextIdx++) {
      let nextText = chunkSentences[nextIdx].text.toLocaleLowerCase();
      let nextPos = nextText.indexOf(rawWord.toLocaleLowerCase(), 0);
      let nextLen = rawWord.length;
      if (nextPos === -1 && cleanWord) {
        nextPos = nextText.indexOf(cleanWord.toLocaleLowerCase(), 0);
        nextLen = cleanWord.length;
      }
      if (nextPos !== -1) {
        currentSentenceIdx = nextIdx;
        cursor = nextPos + nextLen;
        boundariesBySentence.get(chunkSentences[currentSentenceIdx].index).push(wb);
        foundInSubsequent = true;
        break;
      }
    }

    if (!foundInSubsequent) {
      boundariesBySentence.get(chunkSentences[currentSentenceIdx].index).push(wb);
    }
  }

  for (let i = 0; i < chunkSentences.length; i++) {
    const s = chunkSentences[i];
    const bList = boundariesBySentence.get(s.index);
    let startMs = 0;
    if (i === 0) {
      startMs = 0;
    } else {
      if (bList && bList.length > 0) {
        startMs = bList[0].offsetMs;
      } else {
        const prev = sentenceTiming[i - 1];
        startMs = prev ? prev.startMs + 500 : 0;
      }
    }
    sentenceTiming.push({
      index: s.index,
      startMs,
      endMs: Infinity,
    });
  }

  for (let i = 0; i < sentenceTiming.length - 1; i++) {
    if (sentenceTiming[i + 1].startMs < sentenceTiming[i].startMs) {
      sentenceTiming[i + 1].startMs = sentenceTiming[i].startMs + 50;
    }
    sentenceTiming[i].endMs = sentenceTiming[i + 1].startMs;
  }

  return { boundariesBySentence, sentenceTiming };
}

// Check and fetch up to MAX_LOOKAHEAD_CHUNKS (approx 6-8 sentences) ahead in buffer
async function checkAndFetchBuffer() {
  if (playState === "paused" || playState === "idle") {
    return;
  }

  const currentJob = jobId;
  const endChunk = Math.min(chunks.length - 1, activeChunkIndex + MAX_LOOKAHEAD_CHUNKS);

  for (let cIdx = activeChunkIndex; cIdx <= endChunk; cIdx++) {
    if (playState === "paused" || playState === "idle") return;

    if (!chunkMap.has(cIdx) && !fetchingChunkIndices.has(cIdx)) {
      fetchingChunkIndices.add(cIdx);
      const targetChunkIndex = cIdx;
      const targetChunk = chunks[targetChunkIndex];
      const chunkSentences = targetChunk.sentenceIndices.map((i) => sentences[i]);
      const chunkText = (spokenText
        ? spokenText.slice(
            chunkSentences[0].start,
            chunkSentences[chunkSentences.length - 1].end,
          )
        : "") || chunkSentences.map((s) => s.text).join(" ");

      invoke("synthesize_sentence_with_boundaries", {
        text: chunkText,
        voice: activeVoiceCode(),
        rate: null,
        pitch: getPitchString(),
        jobId: currentJob,
      })
        .then((result) => {
          fetchingChunkIndices.delete(targetChunkIndex);
          if (currentJob !== jobId) return;

          const audioBase64 = result?.audioBase64 || "";
          if (!audioBase64) {
            chunkMap.set(targetChunkIndex, null);
            targetChunk.sentenceIndices.forEach((sIdx) => wordMap.set(sIdx, []));
          } else {
            const { boundariesBySentence, sentenceTiming } = processChunkBoundaries(
              chunkSentences,
              result.wordBoundaries || [],
            );

            for (const [sIdx, sBoundaries] of boundariesBySentence.entries()) {
              wordMap.set(sIdx, sBoundaries);
            }

            const blob = base64ToBlob(audioBase64);
            const blobUrl = URL.createObjectURL(blob);
            const audioObj = new Audio(blobUrl);
            audioObj.preload = "auto";
            if ("preservesPitch" in audioObj) audioObj.preservesPitch = true;
            if ("webkitPreservesPitch" in audioObj) audioObj.webkitPreservesPitch = true;
            if ("mozPreservesPitch" in audioObj) audioObj.mozPreservesPitch = true;
            audioObj.load();

            chunkMap.set(targetChunkIndex, {
              chunkIndex: targetChunkIndex,
              sentenceIndices: targetChunk.sentenceIndices,
              audioBase64,
              audioUrl: blobUrl,
              audioObj,
              sentenceTiming,
            });
          }

          // If waiting for this chunk, play it immediately once ready
          if (
            targetChunkIndex === activeChunkIndex &&
            (playState === "synthesizing" || playState === "playing") &&
            !audio
          ) {
            playChunk(activeChunkIndex);
          }

          // Evict old chunks far behind playback to avoid memory accumulation
          for (const [idx, data] of chunkMap.entries()) {
            if (idx < activeChunkIndex - 2) {
              if (data?.audioUrl) URL.revokeObjectURL(data.audioUrl);
              chunkMap.delete(idx);
            }
          }

          // Continue lookahead fetch for next chunk
          if (playState === "playing" || playState === "synthesizing") {
            checkAndFetchBuffer();
          }
        })
        .catch((err) => {
          fetchingChunkIndices.delete(targetChunkIndex);
          if (currentJob !== jobId) return;

          console.warn(`Synthesis error for chunk ${targetChunkIndex + 1}:`, err);
          chunkMap.set(targetChunkIndex, null);
          targetChunk.sentenceIndices.forEach((sIdx) => wordMap.set(sIdx, []));

          if (
            targetChunkIndex === activeChunkIndex &&
            (playState === "synthesizing" || playState === "playing") &&
            !audio
          ) {
            if (activeChunkIndex + 1 < chunks.length) {
              playChunk(activeChunkIndex + 1);
            } else {
              stopAudio();
              updatePlayState("idle", "Playback finished");
              setProgress(null);
            }
          }

          if (playState === "playing" || playState === "synthesizing") {
            checkAndFetchBuffer();
          }
        });

      // Break loop to fetch sequentially one chunk at a time
      break;
    }
  }
}

function playChunk(chunkIndex, seekTime = 0, initialSentenceIndex = -1) {
  if (chunkIndex < 0 || chunkIndex >= chunks.length) {
    stopAudio();
    updatePlayState("idle", "Playback finished");
    setProgress(null);
    return;
  }

  activeChunkIndex = chunkIndex;
  const targetChunk = chunks[chunkIndex];

  if (initialSentenceIndex >= 0) {
    currentIndex = initialSentenceIndex;
  } else if (targetChunk && targetChunk.sentenceIndices.length > 0) {
    currentIndex = targetChunk.sentenceIndices[0];
  }

  stopWordHighlightLoop();
  highlightSentence(currentIndex);
  setProgress(Math.round(((currentIndex + 1) / sentences.length) * 100));

  if (!chunkMap.has(chunkIndex)) {
    const firstSent = targetChunk.sentenceIndices[0] + 1;
    const lastSent = targetChunk.sentenceIndices[targetChunk.sentenceIndices.length - 1] + 1;
    const label = firstSent === lastSent
      ? `Buffering sentence ${firstSent}/${sentences.length}...`
      : `Buffering sentences ${firstSent}-${lastSent}/${sentences.length}...`;
    updatePlayState("synthesizing", label);
    checkAndFetchBuffer();
    return;
  }

  const chunkData = chunkMap.get(chunkIndex);
  if (!chunkData || !chunkData.audioBase64) {
    if (activeChunkIndex + 1 < chunks.length) {
      playChunk(activeChunkIndex + 1);
    } else {
      stopAudio();
      updatePlayState("idle", "Playback finished");
      setProgress(null);
    }
    return;
  }

  activeChunk = chunkData;

  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.pause();
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = "";
    }
  }

  if (chunkData.audioObj) {
    audio = chunkData.audioObj;
    audioUrl = chunkData.audioUrl;
  } else {
    const blob = base64ToBlob(chunkData.audioBase64);
    audioUrl = URL.createObjectURL(blob);
    audio = new Audio(audioUrl);
    chunkData.audioUrl = audioUrl;
    chunkData.audioObj = audio;
  }

  audio.playbackRate = currentSpeed();
  if ("preservesPitch" in audio) audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
  audio.volume = currentVolume();

  if (seekTime > 0) {
    const applySeek = () => {
      if (audio) audio.currentTime = seekTime;
    };
    applySeek();
    audio.addEventListener("loadedmetadata", applySeek, { once: true });
  }

  if (pendingSeekWord) {
    const normalizedWord = pendingSeekWord.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const boundaries = wordMap.get(currentIndex) || [];
    const matches = boundaries
      .map((item, boundaryIndex) => ({ item, boundaryIndex }))
      .filter(({ item }) => (
        item.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === normalizedWord
      ));
    const expectedIndex = pendingSeekProgress * Math.max(0, boundaries.length - 1);
    const match = matches.sort((a, b) => (
      Math.abs(a.boundaryIndex - expectedIndex) - Math.abs(b.boundaryIndex - expectedIndex)
    ))[0];
    if (match) {
      const boundary = match.item;
      const wordSeekTime = Math.max(0, boundary.offsetMs / 1000);
      const applyWordSeek = () => {
        if (audio) audio.currentTime = wordSeekTime;
      };
      applyWordSeek();
      audio.addEventListener("loadedmetadata", applyWordSeek, { once: true });
    }
    pendingSeekWord = "";
    pendingSeekProgress = 0;
  }

  audio.ontimeupdate = () => {
    updateSentenceFromAudio();
    updateTimeDisplay();
    updateWordHighlight();
  };

  audio.onended = () => {
    stopWordHighlightLoop();
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = "";
    }
    audio = null;
    activeChunk = null;
    updateTimeDisplay();

    if (activeChunkIndex + 1 < chunks.length) {
      playChunk(activeChunkIndex + 1);
    } else {
      updatePlayState("idle", "Playback finished");
      setProgress(null);
    }
  };

  audio.onerror = () => {
    stopWordHighlightLoop();
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = "";
    }
    audio = null;
    activeChunk = null;
    updateTimeDisplay();

    if (activeChunkIndex + 1 < chunks.length) {
      playChunk(activeChunkIndex + 1);
    } else {
      stopAudio();
      updatePlayState("idle", "Playback finished");
      setProgress(null);
    }
  };

  if (playState !== "paused") {
    audio.play().catch(() => {
      if (audio && audio.onerror) {
        audio.onerror();
      }
    });
    updatePlayState("playing", `Sentence ${currentIndex + 1}/${sentences.length}`);
    startWordHighlightLoop();
    checkAndFetchBuffer();
  }
}

function jumpToSentence(targetIndex) {
  if (targetIndex < 0 || targetIndex >= sentences.length) return;

  if (activeChunk && activeChunk.sentenceIndices.includes(targetIndex)) {
    const timing = activeChunk.sentenceTiming.find((t) => t.index === targetIndex);
    if (timing && audio) {
      audio.currentTime = Math.max(0, timing.startMs / 1000);
      currentIndex = targetIndex;
      activeWordIndex = -1;
      stopWordHighlightLoop();
      highlightSentence(currentIndex);
      updateTimeDisplay();
      updatePlayState("playing", `Sentence ${currentIndex + 1}/${sentences.length}`);
      startWordHighlightLoop();
      return;
    }
  }

  const cachedChunk = Array.from(chunkMap.values()).find(
    (c) => c && c.sentenceIndices && c.sentenceIndices.includes(targetIndex) && c.audioBase64,
  );
  if (cachedChunk) {
    const timing = cachedChunk.sentenceTiming.find((t) => t.index === targetIndex);
    const seekTime = timing ? Math.max(0, timing.startMs / 1000) : 0;
    playChunk(cachedChunk.chunkIndex, seekTime, targetIndex);
    return;
  }

  rebuildAndPlayFrom(targetIndex);
}

function rebuildAndPlayFrom(targetIndex) {
  stopAudio();
  for (const data of chunkMap.values()) {
    if (data?.audioUrl) URL.revokeObjectURL(data.audioUrl);
  }
  chunkMap.clear();
  wordMap.clear();
  fetchingChunkIndices.clear();

  currentIndex = targetIndex;
  nextJob();
  updatePlayState("synthesizing", `Synthesizing sentence ${targetIndex + 1}/${sentences.length}...`);
  highlightSentence(targetIndex);
  setProgress(Math.round(((targetIndex + 1) / sentences.length) * 100));

  chunks = buildChunksFromIndex(targetIndex, sentences.length);
  activeChunkIndex = 0;
  playChunk(0);
}

function stopAudio() {
  stopWordHighlightLoop();
  const currentAudio = audio;
  audio = null;
  activeChunk = null;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.ontimeupdate = null;
    currentAudio.pause();
    currentAudio.removeAttribute("src");
    currentAudio.load();
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = "";
  }
  updateTimeDisplay();
}

async function stopAll() {
  nextJob();
  for (const data of chunkMap.values()) {
    if (data?.audioUrl) URL.revokeObjectURL(data.audioUrl);
  }
  chunkMap.clear();
  wordMap.clear();
  fetchingChunkIndices.clear();
  chunks = [];
  activeChunkIndex = 0;
  activeChunk = null;
  sentences = [];
  spokenText = "";
  renderedSpeechSegments = [];
  pendingSeekWord = "";
  pendingSeekProgress = 0;
  currentIndex = 0;
  if (playingRenderedMarkdown) {
    CSS.highlights?.delete("spoken-sentence");
    window.getSelection()?.removeAllRanges();
  }

  stopAudio();
  updatePlayState("idle", "Stopped");
  setProgress(null);

  await invoke("stop");
}

function pausePlayback() {
  if (playState !== "playing" && playState !== "synthesizing") return;

  // Immediately set state to 'paused' to stop any new buffer requests from firing!
  updatePlayState("paused", "Paused");

  if (audio) {
    audio.pause();
  }
}

function resumePlayback() {
  if (playState !== "paused") return;

  updatePlayState("playing", `Sentence ${currentIndex + 1}/${sentences.length}`);

  if (audio) {
    audio.play();
    startWordHighlightLoop();
  } else if (chunkMap.has(activeChunkIndex)) {
    playChunk(activeChunkIndex);
  } else {
    updatePlayState("synthesizing", `Buffering sentence ${currentIndex + 1}/${sentences.length}...`);
  }

  // Resume lookahead buffer fetching
  checkAndFetchBuffer();
}

function capturePlaybackSnapshot() {
  if (playState === "idle" || sentences.length === 0) return null;
  const boundaries = wordMap.get(currentIndex) || [];
  const currentMs = (audio?.currentTime || 0) * 1000 + 60;
  let activeBoundary = null;
  let boundaryIndex = -1;
  for (let index = 0; index < boundaries.length; index++) {
    if (boundaries[index].offsetMs > currentMs) break;
    activeBoundary = boundaries[index];
    boundaryIndex = index;
  }
  return {
    state: playState,
    sentenceText: sentences[currentIndex]?.text || "",
    sentenceIndex: currentIndex,
    sentenceCount: sentences.length,
    word: activeBoundary?.text || "",
    wordProgress: boundaryIndex >= 0 ? boundaryIndex / Math.max(1, boundaries.length - 1) : 0,
  };
}

function sentenceWords(text) {
  return new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []));
}

function findContinuationSentence(snapshot, newSentences) {
  if (newSentences.length === 0) return 0;
  const oldPosition = snapshot.sentenceCount > 1
    ? snapshot.sentenceIndex / (snapshot.sentenceCount - 1)
    : 0;
  const approximate = Math.round(oldPosition * Math.max(0, newSentences.length - 1));
  const oldWords = sentenceWords(snapshot.sentenceText);
  const anchor = snapshot.word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  let bestIndex = Math.min(approximate, newSentences.length - 1);
  let bestScore = -Infinity;

  newSentences.forEach((sentence, index) => {
    const words = sentenceWords(sentence.text);
    let shared = 0;
    oldWords.forEach((word) => {
      if (words.has(word)) shared += 1;
    });
    const similarity = oldWords.size ? shared / oldWords.size : 0;
    const hasAnchor = anchor && words.has(anchor) ? 1 : 0;
    const distancePenalty = Math.abs(index - approximate) / Math.max(1, newSentences.length);
    const score = similarity * 5 + hasAnchor * 2 - distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function highlightContinuationWord(snapshot, sentence) {
  const anchor = snapshot.word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!anchor) return;

  const text = sentence.text.toLocaleLowerCase();
  const occurrences = [];
  let position = text.indexOf(anchor);
  while (position !== -1) {
    occurrences.push(position);
    position = text.indexOf(anchor, position + anchor.length);
  }
  if (occurrences.length === 0) return;

  const expected = snapshot.wordProgress * sentence.text.length;
  const localStart = occurrences.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
  const start = sentence.start + localStart;
  const end = start + anchor.length;
  if (playingRenderedMarkdown) {
    highlightRenderedWord(start, end);
  } else {
    if (autoScroll) {
      markProgrammaticScroll();
      content.focus({ preventScroll: true });
      content.setSelectionRange(start, end);
    } else {
      const prevTop = content.scrollTop;
      const prevLeft = content.scrollLeft;
      content.setSelectionRange(start, end);
      content.scrollTop = prevTop;
      content.scrollLeft = prevLeft;
    }
  }
}

async function continuePlaybackWithCurrentSettings(snapshot) {
  const wasPaused = snapshot.state === "paused";
  const currentJob = nextJob();

  // Audio synthesized with the previous settings must not continue after a toggle.
  stopAudio();
  for (const data of chunkMap.values()) {
    if (data?.audioUrl) URL.revokeObjectURL(data.audioUrl);
  }
  chunkMap.clear();
  wordMap.clear();
  fetchingChunkIndices.clear();

  let newSpokenText = content.value;
  playingRenderedMarkdown = markdownMode;
  renderedSpeechSegments = [];
  if (markdownMode) {
    renderMarkdownPreview();
    const model = markdownSpeechModel(content.value, true);
    newSpokenText = model.text;
    renderedSpeechSegments = model.segments;
  }

  const newSentences = parseSentences(newSpokenText);
  if (newSentences.length === 0) {
    updatePlayState("idle", "Nothing to read with these settings");
    setProgress(null);
    return;
  }
  const targetIndex = findContinuationSentence(snapshot, newSentences);
  sentences = newSentences;
  spokenText = newSpokenText;
  currentIndex = targetIndex;
  pendingSeekWord = snapshot.word;
  pendingSeekProgress = snapshot.wordProgress;
  updatePlayState("synthesizing", `Switching mode at sentence ${targetIndex + 1}/${sentences.length}...`);
  highlightSentence(targetIndex);
  highlightContinuationWord(snapshot, sentences[targetIndex]);
  setProgress(Math.round(((targetIndex + 1) / sentences.length) * 100));

  chunks = buildChunksFromIndex(targetIndex, sentences.length);
  activeChunkIndex = 0;

  if (wasPaused) {
    playState = "paused";
    try {
      const targetChunk = chunks[0];
      const chunkSentences = targetChunk.sentenceIndices.map((i) => sentences[i]);
      const chunkText = (spokenText
        ? spokenText.slice(
            chunkSentences[0].start,
            chunkSentences[chunkSentences.length - 1].end,
          )
        : "") || chunkSentences.map((s) => s.text).join(" ");

      const result = await invoke("synthesize_sentence_with_boundaries", {
        text: chunkText,
        voice: activeVoiceCode(),
        rate: null,
        pitch: getPitchString(),
        jobId: currentJob,
      });
      if (currentJob !== jobId) return;

      const audioBase64 = result?.audioBase64 || "";
      if (audioBase64) {
        const { boundariesBySentence, sentenceTiming } = processChunkBoundaries(
          chunkSentences,
          result.wordBoundaries || [],
        );
        for (const [sIdx, sBoundaries] of boundariesBySentence.entries()) {
          wordMap.set(sIdx, sBoundaries);
        }
        const blob = base64ToBlob(audioBase64);
        const audioUrl = URL.createObjectURL(blob);
        const audioObj = new Audio(audioUrl);
        chunkMap.set(0, {
          chunkIndex: 0,
          sentenceIndices: targetChunk.sentenceIndices,
          audioBase64,
          audioUrl,
          audioObj,
          sentenceTiming,
        });
        playState = "paused";
        playChunk(0);
        updatePlayState("paused", `Sentence ${targetIndex + 1}/${sentences.length}`);
      }
    } catch (error) {
      if (currentJob === jobId) {
        updatePlayState("idle", String(error));
        setProgress(null);
      }
    }
  } else {
    playChunk(0);
  }
}

function togglePlayPause() {
  if (playState === "playing" || playState === "synthesizing") {
    pausePlayback();
  } else if (playState === "paused") {
    resumePlayback();
  } else {
    playText();
  }
}

function rewindFiveSeconds() {
  if (audio) {
    if (audio.currentTime > 5) {
      audio.currentTime -= 5;
      updateSentenceFromAudio();
      updateTimeDisplay();
    } else if (currentIndex > 0) {
      jumpToSentence(currentIndex - 1);
    } else {
      audio.currentTime = 0;
      updateSentenceFromAudio();
      updateTimeDisplay();
    }
  }
}

function forwardFiveSeconds() {
  if (audio) {
    if (audio.duration && audio.currentTime + 5 < audio.duration) {
      audio.currentTime += 5;
      updateSentenceFromAudio();
      updateTimeDisplay();
    } else if (currentIndex + 1 < sentences.length) {
      jumpToSentence(currentIndex + 1);
    }
  }
}

async function playText(text = content.value) {
  const sourceText = text;
  if (!sourceText.trim()) return;

  await stopAll();
  content.value = sourceText;
  playingRenderedMarkdown = markdownMode;

  spokenText = sourceText;
  if (markdownMode) {
    renderMarkdownPreview();
    const model = markdownSpeechModel(sourceText, true);
    spokenText = model.text;
    renderedSpeechSegments = model.segments;
  }
  if (!spokenText.trim()) return;
  updateCount();

  sentences = parseSentences(spokenText);
  if (sentences.length === 0) return;

  currentIndex = 0;
  nextJob();
  updatePlayState("synthesizing", `Synthesizing sentence 1/${sentences.length}...`);
  setProgress(5);

  chunks = buildChunksFromIndex(0, sentences.length);
  activeChunkIndex = 0;
  playChunk(0);
}

async function saveText() {
  const text = textForSpeech(content.value).trim();
  if (!text) return;

  const currentJob = nextJob();
  const oldState = playState;
  if (oldState === "idle") {
    updatePlayState("synthesizing", "Saving full audio...");
  }
  setProgress(1);

  try {
    const saved = await invoke("save_audio", {
      text,
      voice: activeVoiceCode(),
      rate: getRateString(),
      pitch: getPitchString(),
      jobId: currentJob,
    });
    if (currentJob !== jobId) return;
    if (oldState === "idle") {
      updatePlayState("idle", saved ? `Saved: ${saved}` : "Save canceled");
    }
    setProgress(null);
  } catch (error) {
    if (currentJob === jobId) {
      updatePlayState("idle", String(error));
      setProgress(null);
    }
  }
}

function appendPastedMarkdown(text) {
  if (!text) return;
  const separator = content.value && !content.value.endsWith("\n") ? "\n" : "";
  content.value += separator + text;
  renderMarkdownPreview();
  updateCount();
}

content.addEventListener("input", updateCount);
markdownPreview?.addEventListener("click", (event) => {
  if (event.target.closest("a")) event.preventDefault();
});
markdownPreview?.addEventListener("beforeinput", (event) => event.preventDefault());

document.addEventListener("paste", (event) => {
  if (!markdownMode) return;
  const text = event.clipboardData?.getData("text/plain");
  if (text) {
    event.preventDefault();
    appendPastedMarkdown(text);
  }
});

document.addEventListener("keydown", (event) => {
  const isEditing = document.activeElement === content;

  if (event.code === "Space" && !isEditing) {
    event.preventDefault();
    togglePlayPause();
  } else if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    togglePlayPause();
  } else if (event.key === "Escape") {
    event.preventDefault();
    stopAll();
  } else if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    rewindFiveSeconds();
  } else if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    forwardFiveSeconds();
  } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveText();
  }
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    content.value = text;
    if (markdownMode) renderMarkdownPreview();
    updateCount();
  });
});

language.addEventListener("change", () => {
  fillVoiceSelect(language.value);
  const code = activeVoiceCode();
  if (code) localStorage.setItem("edge_tts_voice", code);
});
voice.addEventListener("change", () => {
  const code = activeVoiceCode();
  if (code) localStorage.setItem("edge_tts_voice", code);
});

speedInput.addEventListener("input", updateSpeedLabel);
pitchInput?.addEventListener("input", updatePitchLabel);
pitchInput?.addEventListener("dblclick", () => {
  if (pitchInput) {
    pitchInput.value = "0";
    updatePitchLabel();
    onPitchChange();
  }
});
pitchInput?.addEventListener("change", onPitchChange);

volumeInput?.addEventListener("input", updateVolumeLabel);
muteBtn?.addEventListener("click", toggleMute);

playButton.addEventListener("click", togglePlayPause);
stopButton.addEventListener("click", stopAll);
rewindButton?.addEventListener("click", rewindFiveSeconds);
forwardButton?.addEventListener("click", forwardFiveSeconds);
saveButton.addEventListener("click", saveText);
closeButton.addEventListener("click", () => invoke("close_window"));

function handleUserScroll() {
  if (playState !== "idle" && autoScroll) {
    disableAutoScroll();
  }
}

content.addEventListener("wheel", () => {
  isProgrammaticScroll = false;
  handleUserScroll();
}, { passive: true });

markdownPreview?.addEventListener("wheel", () => {
  isProgrammaticScroll = false;
  handleUserScroll();
}, { passive: true });

content.addEventListener("touchmove", () => {
  isProgrammaticScroll = false;
  handleUserScroll();
}, { passive: true });

markdownPreview?.addEventListener("touchmove", () => {
  isProgrammaticScroll = false;
  handleUserScroll();
}, { passive: true });

content.addEventListener("scroll", () => {
  if (!isProgrammaticScroll) {
    handleUserScroll();
  }
}, { passive: true });

markdownPreview?.addEventListener("scroll", () => {
  if (!isProgrammaticScroll) {
    handleUserScroll();
  }
}, { passive: true });

autoScrollBtn?.addEventListener("click", enableAutoScroll);

clearButton?.addEventListener("click", () => {
  content.value = "";
  if (markdownMode) renderMarkdownPreview();
  updateCount();
});

markdownToggle?.addEventListener("click", async () => {
  const snapshot = capturePlaybackSnapshot();
  markdownToggle.disabled = true;
  codeToggle.disabled = true;
  markdownMode = !markdownMode;
  updateMarkdownToggle();
  if (snapshot) {
    await continuePlaybackWithCurrentSettings(snapshot);
  } else {
    updatePlayState("idle", markdownMode ? "Markdown reading enabled" : "Plain-text reading enabled");
  }
  markdownToggle.disabled = false;
  codeToggle.disabled = false;
});

codeToggle?.addEventListener("click", async () => {
  const snapshot = capturePlaybackSnapshot();
  markdownToggle.disabled = true;
  codeToggle.disabled = true;
  pronounceCode = !pronounceCode;
  updateCodeToggle();
  if (snapshot) {
    await continuePlaybackWithCurrentSettings(snapshot);
  } else {
    updatePlayState("idle", pronounceCode ? "Code will be spoken" : "Code will be skipped");
  }
  markdownToggle.disabled = false;
  codeToggle.disabled = false;
});

copyButton?.addEventListener("click", () => {
  if (content.value) {
    navigator.clipboard.writeText(content.value);
    const orig = copyButton.textContent;
    copyButton.textContent = "Copied!";
    setTimeout(() => {
      copyButton.textContent = orig;
    }, 1200);
  }
});

listen("hotkey-text", (event) => playText(event.payload));
listen("save-progress", (event) => {
  if (event.payload.job_id === jobId) setProgress(event.payload.percent);
});

voices = await invoke("get_voices");
fillLanguageSelect();

const savedVoice = localStorage.getItem("edge_tts_voice");
const savedSpeed = localStorage.getItem("edge_tts_speed");
const savedPitch = localStorage.getItem("edge_tts_pitch");
const savedVolume = localStorage.getItem("edge_tts_volume");

if (savedSpeed) {
  speedInput.value = savedSpeed;
}
updateSpeedLabel();

if (savedPitch && pitchInput) {
  pitchInput.value = savedPitch;
}
updatePitchLabel();

if (savedVolume && volumeInput) {
  volumeInput.value = savedVolume;
}
updateVolumeLabel();

if (savedVoice && voices.some((v) => v.code === savedVoice)) {
  setVoiceCode(savedVoice);
} else {
  const defaultVoice = voices.find((v) => v.code === "en-US, AvaNeural") || voices[0];
  if (defaultVoice) setVoiceCode(defaultVoice.code);
}
updateCodeToggle();
updateMarkdownToggle();
updateAutoScrollButton();


