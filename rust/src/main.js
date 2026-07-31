import "./style.css";

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

let voices = [];
let audio = null;
let audioUrl = "";
let jobId = 0;

// Playback States: 'idle' | 'synthesizing' | 'playing' | 'paused'
let playState = "idle";
let isMuted = false;
let previousVolume = 1.0;

// Sentence-level 3-sentence windowed buffer state
let sentences = [];
let currentIndex = 0;
let audioMap = new Map();
let fetchingIndices = new Set();

function nextJob() {
  jobId += 1;
  return jobId;
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

function highlightSentence(idx) {
  if (idx < 0 || idx >= sentences.length) return;
  const s = sentences[idx];
  content.focus();
  content.setSelectionRange(s.start, s.end);
}

function updatePlayState(newState, label = "") {
  playState = newState;

  if (statusDot) {
    statusDot.className = "dot " + newState;
  }

  switch (newState) {
    case "idle":
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
}

function setProgress(value) {
  if (value == null) {
    progress.hidden = true;
    progress.value = 0;
  } else {
    progress.hidden = false;
    progress.value = value;
  }
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
  count.textContent = `Count: ${content.value.replace(/\s+/g, "").length}`;
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

      invoke("synthesize_sentence", {
        text: sentences[targetIndex].text,
        voice: activeVoiceCode(),
        rate: null,
        jobId: currentJob,
      })
        .then((b64) => {
          fetchingIndices.delete(targetIndex);
          if (currentJob !== jobId) return;

          audioMap.set(targetIndex, b64);

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
          if (currentJob === jobId && targetIndex === currentIndex) {
            updatePlayState("idle", String(err));
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
  const blob = base64ToBlob(b64);
  audioUrl = URL.createObjectURL(blob);
  audio = new Audio(audioUrl);

  audio.playbackRate = currentSpeed();
  if ("preservesPitch" in audio) audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
  audio.volume = currentVolume();

  audio.ontimeupdate = () => {
    updateTimeDisplay();
  };

  audio.onended = () => {
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
    stopAudio();
    updatePlayState("idle", "Playback error");
    setProgress(null);
  };

  if (playState !== "paused") {
    audio.play();
    updatePlayState("playing", `Sentence ${index + 1}/${sentences.length}`);
    checkAndFetchBuffer();
  }
}

function stopAudio() {
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
  fetchingIndices.clear();
  sentences = [];
  currentIndex = 0;

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
  } else if (audioMap.has(currentIndex)) {
    playSentence(currentIndex);
  } else {
    updatePlayState("synthesizing", `Buffering sentence ${currentIndex + 1}/${sentences.length}...`);
  }

  // Resume lookahead buffer fetching
  checkAndFetchBuffer();
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
  const trimmed = text.trim();
  if (!trimmed) return;

  await stopAll();
  content.value = text;
  updateCount();

  sentences = parseSentences(text);
  if (sentences.length === 0) return;

  currentIndex = 0;
  nextJob();
  updatePlayState("synthesizing", `Synthesizing sentence 1/${sentences.length}...`);
  setProgress(5);

  playSentence(0);
}

async function saveText() {
  const text = content.value.trim();
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

content.addEventListener("input", updateCount);

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
volumeInput?.addEventListener("input", updateVolumeLabel);
muteBtn?.addEventListener("click", toggleMute);

playButton.addEventListener("click", togglePlayPause);
stopButton.addEventListener("click", stopAll);
rewindButton?.addEventListener("click", rewindFiveSeconds);
forwardButton?.addEventListener("click", forwardFiveSeconds);
saveButton.addEventListener("click", saveText);
closeButton.addEventListener("click", () => invoke("close_window"));

clearButton?.addEventListener("click", () => {
  content.value = "";
  updateCount();
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
const savedVolume = localStorage.getItem("edge_tts_volume");

if (savedSpeed) {
  speedInput.value = savedSpeed;
}
updateSpeedLabel();

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
updateCount();


