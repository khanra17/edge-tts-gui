import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVoices, saveAudio, speechService } from "./api.ts";
import { Editor } from "./editor.ts";
import { Playback } from "./playback.ts";
import { loadPreferences, storePreferences } from "./settings.ts";
import { nextJobId } from "./speech.ts";
import type { PlaybackView, SpeechSettings } from "./types.ts";

function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing #${id}`);
    return node as T;
}

const content = element<HTMLTextAreaElement>("content");
const language = element<HTMLSelectElement>("language");
const voice = element<HTMLSelectElement>("voice");
const speed = element<HTMLInputElement>("speed");
const pitch = element<HTMLInputElement>("pitch");
const volume = element<HTMLInputElement>("volume");
const play = element<HTMLButtonElement>("play");
const stop = element<HTMLButtonElement>("stop");
const save = element<HTMLButtonElement>("save");
const rewind = element<HTMLButtonElement>("rewind-5s");
const forward = element<HTMLButtonElement>("forward-5s");
const markdown = element<HTMLButtonElement>("markdown-toggle");
const code = element<HTMLButtonElement>("code-toggle");
const progress = element<HTMLProgressElement>("progress");
const status = element("status");
const preferences = loadPreferences();
const player = new Playback(speechService);
const editor = new Editor(content, element("markdown-preview"), element("auto-scroll-btn"));
let voices: Awaited<ReturnType<typeof getVoices>> = [];
let muted = false;
let saving: number | null = null;
let frame: number | null = null;

const synthesisSettings = (): SpeechSettings => ({
    voice: preferences.voice,
    pitch: preferences.pitch,
});

function formatTime(seconds: number): string {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)
        .toString()
        .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

function setProgress(value: number | null): void {
    progress.classList.toggle("is-hidden", value === null);
    progress.setAttribute("aria-hidden", String(value === null));
    progress.value = value ?? 0;
}

function render(view: PlaybackView): void {
    const idle = view.status === "idle";
    play.textContent = idle ? "Play" : view.status === "paused" ? "Resume" : "Pause";
    play.disabled = saving !== null || !voices.length;
    save.disabled = saving !== null || !idle || !voices.length;
    stop.disabled = idle && saving === null;
    rewind.disabled = forward.disabled = idle || view.status === "buffering";
    language.disabled = voice.disabled = pitch.disabled = saving !== null;
    element("status-dot").className =
        `dot ${view.status === "buffering" ? "synthesizing" : view.status}`;
    if (saving === null) {
        if (status.textContent !== view.message) status.textContent = view.message;
        setProgress(
            idle ? null : ((view.sentenceIndex + 1) / Math.max(1, view.sentences.length)) * 100,
        );
    }
    const time = `${formatTime(view.position)} / ${formatTime(view.duration)}`;
    const display = element("time-display");
    if (display.textContent !== time) display.textContent = time;
    editor.highlight(view);
    if (view.status === "playing" && frame === null) {
        frame = requestAnimationFrame(() => {
            frame = null;
            if (player.view.status === "playing") player.tick();
        });
    }
}

player.onChange = render;

function updateCount(): void {
    const count = (value: string) => value.replace(/\s/gu, "").length;
    element("count").textContent = preferences.markdown
        ? `Count: ${count(content.value)} · Spoken: ${count(editor.text)}`
        : `Count: ${count(content.value)}`;
}

function updateEditor(): void {
    editor.refresh(preferences.markdown, preferences.code);
    markdown.textContent = `Markdown: ${preferences.markdown ? "On" : "Off"}`;
    markdown.classList.toggle("active", preferences.markdown);
    markdown.setAttribute("aria-pressed", String(preferences.markdown));
    code.textContent = `Code: ${preferences.code ? "Speak" : "Skip"}`;
    code.classList.toggle("active", !preferences.code);
    code.setAttribute("aria-pressed", String(!preferences.code));
    updateCount();
}

function updateLocalSettings(): void {
    element("speed-val").textContent = `${preferences.speed.toFixed(1)}x`;
    element("pitch-val").textContent = `${preferences.pitch >= 0 ? "+" : ""}${preferences.pitch}Hz`;
    element("volume-val").textContent = `${Math.round(preferences.volume * 100)}%`;
    element("mute-btn").textContent = muted || preferences.volume === 0 ? "🔇" : "🔊";
    player.setLocal(preferences.speed, muted ? 0 : preferences.volume);
    storePreferences(preferences);
}

function applySynthesisSettings(): void {
    storePreferences(preferences);
    player.reconfigure(editor.text, synthesisSettings());
}

function populateVoices(selected = preferences.voice): void {
    const options = voices.filter((item) => item.language === language.value);
    voice.replaceChildren(...options.map((item) => new Option(item.name, item.code)));
    if (options.some((item) => item.code === selected)) voice.value = selected;
    preferences.voice = voice.value;
}

function togglePlayback(): void {
    if (saving !== null || !voices.length) return;
    switch (player.view.status) {
        case "idle":
            player.start(editor.text, synthesisSettings());
            break;
        case "paused":
            player.resume();
            break;
        default:
            player.pause();
    }
}

function stopAll(): void {
    saving = null;
    player.stop();
}

function replaceText(text: string, read = false): void {
    stopAll();
    content.value = text;
    updateEditor();
    if (read) togglePlayback();
}

async function exportAudio(): Promise<void> {
    if (saving !== null || !editor.text.trim() || player.view.status !== "idle" || !voices.length)
        return;
    const jobId = nextJobId();
    saving = jobId;
    render(player.view);
    status.textContent = "Saving full audio…";
    setProgress(1);
    try {
        const path = await saveAudio(
            {
                text: editor.text,
                ...synthesisSettings(),
                rate: Math.round((preferences.speed - 1) * 100),
            },
            jobId,
        );
        if (saving !== jobId) return;
        saving = null;
        render(player.view);
        status.textContent = path ? `Saved: ${path}` : "Save cancelled";
    } catch (error) {
        if (saving !== jobId) return;
        saving = null;
        render(player.view);
        status.textContent = `Save failed: ${error}`;
    }
}

play.addEventListener("click", togglePlayback);
stop.addEventListener("click", stopAll);
rewind.addEventListener("click", () => player.seek(-5));
forward.addEventListener("click", () => player.seek(5));
save.addEventListener("click", () => void exportAudio());
element("close").addEventListener("click", () => void getCurrentWindow().close());

language.addEventListener("change", () => {
    populateVoices();
    applySynthesisSettings();
});
voice.addEventListener("change", () => {
    preferences.voice = voice.value;
    applySynthesisSettings();
});
speed.value = String(preferences.speed);
pitch.value = String(preferences.pitch);
volume.value = String(preferences.volume);
speed.addEventListener("input", () => {
    preferences.speed = Number(speed.value);
    updateLocalSettings();
});
pitch.addEventListener("input", () => {
    preferences.pitch = Number(pitch.value);
    updateLocalSettings();
    applySynthesisSettings();
});
pitch.addEventListener("dblclick", () => {
    pitch.value = "0";
    pitch.dispatchEvent(new Event("input"));
});
volume.addEventListener("input", () => {
    preferences.volume = Number(volume.value);
    muted = false;
    updateLocalSettings();
});
element("mute-btn").addEventListener("click", () => {
    muted = !muted;
    updateLocalSettings();
});

for (const [button, key] of [
    [markdown, "markdown"],
    [code, "code"],
] as const) {
    button.addEventListener("click", () => {
        if (saving !== null) return;
        preferences[key] = !preferences[key];
        updateEditor();
        applySynthesisSettings();
    });
}
content.addEventListener("input", () => {
    stopAll();
    updateEditor();
});
element("clear-text").addEventListener("click", () => replaceText(""));
element("copy-text").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(content.value);
        status.textContent = "Copied";
    } catch (error) {
        status.textContent = `Copy failed: ${error}`;
    }
});
document.addEventListener("paste", (event) => {
    if (!preferences.markdown) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
        event.preventDefault();
        replaceText(
            content.value + (content.value && !content.value.endsWith("\n") ? "\n" : "") + text,
        );
    }
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    try {
        replaceText(await file.text());
    } catch (error) {
        status.textContent = `Cannot read file: ${error}`;
    }
});
document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    const editing =
        target === content ||
        target.isContentEditable ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLInputElement;
    if ((event.code === "Space" && !editing) || (event.ctrlKey && event.key === "Enter")) {
        event.preventDefault();
        togglePlayback();
    } else if (event.key === "Escape") {
        event.preventDefault();
        stopAll();
    } else if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        player.seek(event.key === "ArrowLeft" ? -5 : 5);
    } else if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void exportAudio();
    }
});

updateEditor();
updateLocalSettings();
render(player.view);

try {
    await listen<string>("selection-text", ({ payload }) => replaceText(payload, true));
    await listen<{ jobId: number; percent: number }>("save-progress", ({ payload }) => {
        if (saving === payload.jobId) setProgress(payload.percent);
    });
    voices = await getVoices();
    language.replaceChildren(
        ...[...new Set(voices.map((item) => item.language))].map((name) => new Option(name)),
    );
    const selected =
        voices.find((item) => item.code === preferences.voice) ??
        voices.find((item) => item.code === "en-US, AvaNeural") ??
        voices[0];
    if (selected) language.value = selected.language;
    populateVoices(selected?.code);
    storePreferences(preferences);
    render(player.view);
} catch (error) {
    status.textContent = `Cannot initialize reader: ${error}`;
}
