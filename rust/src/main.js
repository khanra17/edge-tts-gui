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

// Sentence-level 3-sentence windowed buffer state
let sentences = [];
let currentIndex = 0;
let audioMap = new Map();
let wordMap = new Map();
let fetchingIndices = new Set();
let activeWordIndex = -1;
let wordHighlightFrame = null;
let pendingSeekWord = "";
let pendingSeekProgress = 0;

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

function startWordHighlightLoop() {
  if (wordHighlightFrame !== null) return;
  const tick = () => {
    wordHighlightFrame = null;
    if (playState !== "playing") return;
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

// Check and fetch up to 3 sentences ahead in buffer
async function checkAndFetchBuffer() {
  // CRITICAL REQUIREMENT: Stop/pause buffer fetching if paused or idle
  if (playState === "paused" || playState === "idle") {
    return;
  }

  const currentJob = jobId;
  const maxLookahead = 3; // Buffer at most 3 sentences ahead
  const endLook = Math.min(sentences.length - 1, currentIndex + maxLookahead);

  for (let i = currentIndex; i <= endLook; i++) {
    if (playState === "paused" || playState === "idle") return;

    if (!audioMap.has(i) && !fetchingIndices.has(i)) {
      fetchingIndices.add(i);
      const targetIndex = i;

      invoke("synthesize_sentence_with_boundaries", {
        text: sentences[targetIndex].text,
        voice: activeVoiceCode(),
        rate: null,
        pitch: getPitchString(),
        jobId: currentJob,
      })
        .then((result) => {
          fetchingIndices.delete(targetIndex);
          if (currentJob !== jobId) return;

          const audioBase64 = result?.audioBase64 || "";
          if (!audioBase64) {
            audioMap.set(targetIndex, null);
            wordMap.set(targetIndex, []);
          } else {
            audioMap.set(targetIndex, audioBase64);
            wordMap.set(targetIndex, result.wordBoundaries || []);
          }

          // If waiting for current sentence, play it immediately once ready
          if (
            targetIndex === currentIndex &&
            (playState === "synthesizing" || playState === "playing") &&
            !audio
          ) {
            playSentence(currentIndex);
          }

          // Continue buffer checks if active
          if (playState === "playing" || playState === "synthesizing") {
            checkAndFetchBuffer();
          }
        })
        .catch((err) => {
          fetchingIndices.delete(targetIndex);
          if (currentJob !== jobId) return;

          console.warn(`No audio data received or synthesis error for sentence ${targetIndex + 1}:`, err);
          // Record null audio so we don't repeatedly retry or get stuck on empty/unsupported sentences
          audioMap.set(targetIndex, null);
          wordMap.set(targetIndex, []);

          // If waiting for current sentence, trigger playSentence to skip to next sentence
          if (
            targetIndex === currentIndex &&
            (playState === "synthesizing" || playState === "playing") &&
            !audio
          ) {
            playSentence(currentIndex);
          }

          if (playState === "playing" || playState === "synthesizing") {
            checkAndFetchBuffer();
          }
        });
    }
  }
}

function playSentence(index) {
  if (index < 0 || index >= sentences.length) {
    stopAudio();
    updatePlayState("idle", "Playback finished");
    setProgress(null);
    return;
  }

  currentIndex = index;
  stopWordHighlightLoop();
  highlightSentence(index);
  setProgress(Math.round(((index + 1) / sentences.length) * 100));

  if (!audioMap.has(index)) {
    updatePlayState("synthesizing", `Buffering sentence ${index + 1}/${sentences.length}...`);
    checkAndFetchBuffer();
    return;
  }

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

  const b64 = audioMap.get(index);
  // If sentence has no audio data (e.g. empty or synthesis failed/no audio returned)
  if (!b64 || b64.length === 0) {
    if (currentIndex + 1 < sentences.length) {
      playSentence(currentIndex + 1);
    } else {
      stopAudio();
      updatePlayState("idle", "Playback finished");
      setProgress(null);
    }
    return;
  }

  const blob = base64ToBlob(b64);
  audioUrl = URL.createObjectURL(blob);
  audio = new Audio(audioUrl);

  audio.playbackRate = currentSpeed();
  if ("preservesPitch" in audio) audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
  audio.volume = currentVolume();

  if (pendingSeekWord) {
    const normalizedWord = pendingSeekWord.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const boundaries = wordMap.get(index) || [];
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
      const seekTime = Math.max(0, boundary.offsetMs / 1000);
      const applySeek = () => {
        if (audio) audio.currentTime = seekTime;
      };
      applySeek();
      audio.addEventListener("loadedmetadata", applySeek, { once: true });
    }
    pendingSeekWord = "";
    pendingSeekProgress = 0;
  }

  audio.ontimeupdate = () => {
    updateTimeDisplay();
    updateWordHighlight();
  };

  audio.onended = () => {
    stopWordHighlightLoop();
    URL.revokeObjectURL(audioUrl);
    audioUrl = "";
    audio = null;
    updateTimeDisplay();

    if (currentIndex + 1 < sentences.length) {
      playSentence(currentIndex + 1);
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
    updateTimeDisplay();

    if (currentIndex + 1 < sentences.length) {
      playSentence(currentIndex + 1);
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
    updatePlayState("playing", `Sentence ${index + 1}/${sentences.length}`);
    startWordHighlightLoop();
    checkAndFetchBuffer();
  }
}

function stopAudio() {
  stopWordHighlightLoop();
  const currentAudio = audio;
  audio = null;
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
  audioMap.clear();
  wordMap.clear();
  fetchingIndices.clear();
  sentences = [];
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
  } else if (audioMap.has(currentIndex)) {
    playSentence(currentIndex);
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
  audioMap.clear();
  wordMap.clear();
  fetchingIndices.clear();

  let spokenText = content.value;
  playingRenderedMarkdown = markdownMode;
  renderedSpeechSegments = [];
  if (markdownMode) {
    renderMarkdownPreview();
    const model = markdownSpeechModel(content.value, true);
    spokenText = model.text;
    renderedSpeechSegments = model.segments;
  }

  const newSentences = parseSentences(spokenText);
  if (newSentences.length === 0) {
    updatePlayState("idle", "Nothing to read with these settings");
    setProgress(null);
    return;
  }
  const targetIndex = findContinuationSentence(snapshot, newSentences);
  sentences = newSentences;
  currentIndex = targetIndex;
  pendingSeekWord = snapshot.word;
  pendingSeekProgress = snapshot.wordProgress;
  updatePlayState("synthesizing", `Switching mode at sentence ${targetIndex + 1}/${sentences.length}...`);
  highlightSentence(targetIndex);
  highlightContinuationWord(snapshot, sentences[targetIndex]);
  setProgress(Math.round(((targetIndex + 1) / sentences.length) * 100));

  try {
    const result = await invoke("synthesize_sentence_with_boundaries", {
      text: sentences[targetIndex].text,
      voice: activeVoiceCode(),
      rate: null,
      pitch: getPitchString(),
      jobId: currentJob,
    });
    if (currentJob !== jobId) return;

    audioMap.set(targetIndex, result?.audioBase64 || null);
    wordMap.set(targetIndex, result?.wordBoundaries || []);
    if (wasPaused) {
      playState = "paused";
      playSentence(targetIndex);
      updatePlayState("paused", `Sentence ${targetIndex + 1}/${sentences.length}`);
    } else {
      playSentence(targetIndex);
    }
  } catch (error) {
    if (currentJob === jobId) {
      updatePlayState("idle", String(error));
      setProgress(null);
    }
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
    } else if (currentIndex > 0) {
      playSentence(currentIndex - 1);
    } else {
      audio.currentTime = 0;
    }
    updateTimeDisplay();
  }
}

function forwardFiveSeconds() {
  if (audio) {
    if (audio.duration && audio.currentTime + 5 < audio.duration) {
      audio.currentTime += 5;
    } else if (currentIndex + 1 < sentences.length) {
      playSentence(currentIndex + 1);
    }
    updateTimeDisplay();
  }
}

async function playText(text = content.value) {
  const sourceText = text;
  if (!sourceText.trim()) return;

  await stopAll();
  content.value = sourceText;
  playingRenderedMarkdown = markdownMode;

  let spokenText = sourceText;
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

  playSentence(0);
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


