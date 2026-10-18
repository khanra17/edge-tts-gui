import { closeWindow, getPlatform, getVoices, onSaveProgress, onSelection, saveAudio, speechService } from "./api.ts";
import { Editor } from "./editor.ts";
import { Playback } from "./playback.ts";
import { ReaderMode } from "./reader-mode.ts";
import { ReaderView } from "./view.ts";
import { loadPreferences, storePreferences } from "./settings.ts";
import { nextJobId } from "./speech.ts";
import type { PlaybackView, SpeechSettings } from "./types.ts";

export async function startApp(): Promise<void> {
    const ui = new ReaderView();
    function element<T extends HTMLElement>(id: string): T {
        return ui.element<T>(id);
    }

    const content = element<HTMLTextAreaElement>("content");
    const language = element<HTMLSelectElement>("language");
    const voice = element<HTMLSelectElement>("voice");
    const speed = element<HTMLInputElement>("speed");
    const pitch = element<HTMLInputElement>("pitch");
    const volume = element<HTMLInputElement>("volume");
    const save = element<HTMLButtonElement>("save");
    const markdown = element<HTMLButtonElement>("markdown-toggle");
    const code = element<HTMLButtonElement>("code-toggle");
    const preferences = loadPreferences();
    const player = new Playback(speechService);
    const editor = new Editor(content, element("markdown-preview"), element("auto-scroll-btn"));
    const readerMode = new ReaderMode(
        element("reader-area"),
        element<HTMLButtonElement>("reader-fullscreen"),
        element("reader-overlay"),
        element("reader-toolbar"),
        content,
        () => editor.following,
    );
    let voices: Awaited<ReturnType<typeof getVoices>> = [];
    let muted = false;
    let saving: number | null = null;
    let tickTimer: ReturnType<typeof setTimeout> | null = null;

    const synthesisSettings = (): SpeechSettings => ({
        voice: preferences.voice,
        pitch: preferences.pitch,
    });

    function render(view: PlaybackView): void {
        ui.render(view, saving !== null, voices.length > 0);
        if (view.status === "idle" && view.message !== "Ready") readerMode.reveal();
        if (!document.hidden || view.status === "idle") editor.highlight(view);
        if (view.status === "playing" && !document.hidden) {
            if (tickTimer === null) {
                tickTimer = setTimeout(() => {
                    tickTimer = null;
                    if (player.view.status === "playing") player.tick();
                }, 80);
            }
        } else if (tickTimer !== null) {
            clearTimeout(tickTimer);
            tickTimer = null;
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
        code.hidden = !preferences.markdown;
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
        // Dismiss the keyboard before reading; highlighting must not bring it back.
        if (matchMedia("(any-pointer: coarse)").matches && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
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
        ui.setStatus("Saving full audio…");
        ui.setProgress(1);
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
            ui.setStatus(path ? `Saved: ${path}` : "Save cancelled");
        } catch (error) {
            if (saving !== jobId) return;
            saving = null;
            render(player.view);
            ui.setStatus(`Save failed: ${error}`);
        }
    }

    ui.bindPlayback({
        play: togglePlayback,
        stop: stopAll,
        rewind: () => player.seek(-5),
        forward: () => player.seek(5),
    });
    element("reader-exit").addEventListener("click", () => readerMode.exit());
    save.addEventListener("click", () => void exportAudio());
    element("close").addEventListener("click", () => void closeWindow());
    const openFile = element<HTMLInputElement>("open-file");
    element("open").addEventListener("click", () => {
        if (saving === null) openFile.click();
    });
    async function readFile(file: File): Promise<void> {
        if (saving !== null) return;
        try {
            replaceText(await file.text());
        } catch (error) {
            ui.setStatus(`Cannot read file: ${error}`);
        }
    }
    openFile.addEventListener("change", () => {
        const file = openFile.files?.[0];
        if (file) void readFile(file);
        openFile.value = "";
    });

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
        await readFile(file);
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

    document.addEventListener("visibilitychange", () => render(player.view));

    updateEditor();
    updateLocalSettings();
    render(player.view);

    try {
        const platform = await getPlatform();
        document.documentElement.classList.toggle("android", platform === "android");
        element("close").hidden = platform === "android";
        if (platform === "desktop") await onSelection((text) => replaceText(text, true));
        await onSaveProgress((jobId, percent) => {
            if (saving === jobId) ui.setProgress(percent);
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
        ui.setStatus(`Cannot initialize reader: ${error}`);
    }
}
