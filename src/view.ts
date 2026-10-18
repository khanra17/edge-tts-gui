import type { PlaybackView } from "./types.ts";

type Action = "play" | "stop" | "rewind" | "forward";

function formatTime(seconds: number): string {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

/** One view model drives normal and fullscreen controls on both platforms. */
export class ReaderView {
    private nodes = new Map<string, HTMLElement>();
    private controls: Record<Action, HTMLButtonElement[]>;
    private time = "00:00 / 00:00";

    constructor() {
        this.controls = {
            play: ["play", "reader-play"].map((id) => this.element<HTMLButtonElement>(id)),
            stop: ["stop", "reader-stop"].map((id) => this.element<HTMLButtonElement>(id)),
            rewind: ["rewind-5s", "reader-rewind"].map((id) => this.element<HTMLButtonElement>(id)),
            forward: ["forward-5s", "reader-forward"].map((id) => this.element<HTMLButtonElement>(id)),
        };
    }

    element<T extends HTMLElement>(id: string): T {
        let node = this.nodes.get(id);
        if (!node) {
            node = document.getElementById(id) ?? undefined;
            if (!node) throw new Error(`Missing #${id}`);
            this.nodes.set(id, node);
        }
        return node as T;
    }

    bindPlayback(actions: Record<Action, () => void>): void {
        for (const action of Object.keys(this.controls) as Action[]) {
            for (const button of this.controls[action]) button.addEventListener("click", actions[action]);
        }
    }

    setStatus(message: string): void {
        this.text("status", message);
        this.text("reader-status", `${message} · ${this.time}`);
    }

    setProgress(value: number | null): void {
        const progress = this.element<HTMLProgressElement>("progress");
        const hidden = value === null;
        if (progress.classList.contains("is-hidden") !== hidden) {
            progress.classList.toggle("is-hidden", hidden);
            progress.setAttribute("aria-hidden", String(hidden));
        }
        if (progress.value !== (value ?? 0)) progress.value = value ?? 0;
    }

    render(view: PlaybackView, saving: boolean, voicesReady: boolean): void {
        const idle = view.status === "idle";
        this.time = `${formatTime(view.position)} / ${formatTime(view.duration)}`;
        this.text("time-display", this.time);
        this.buttons("play", saving || !voicesReady,
            idle ? "Play" : view.status === "paused" ? "Resume" : "Pause");
        this.buttons("stop", idle && !saving);
        this.buttons("rewind", idle || view.status === "buffering");
        this.buttons("forward", idle || view.status === "buffering");
        this.disable("save", saving || !idle || !voicesReady);
        for (const id of ["language", "voice", "pitch", "open"]) this.disable(id, saving);
        const dot = this.element("status-dot");
        const className = `dot ${view.status === "buffering" ? "synthesizing" : view.status}`;
        if (dot.className !== className) dot.className = className;
        if (!saving) {
            this.setStatus(view.message);
            this.setProgress(idle ? null : ((view.sentenceIndex + 1) / Math.max(1, view.sentences.length)) * 100);
        }
    }

    private text(id: string, value: string): void {
        const node = this.element(id);
        if (node.textContent !== value) node.textContent = value;
    }

    private disable(id: string, disabled: boolean): void {
        const node = this.element<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(id);
        if (node.disabled !== disabled) node.disabled = disabled;
    }

    private buttons(action: Action, disabled: boolean, label?: string): void {
        for (const button of this.controls[action]) {
            if (button.disabled !== disabled) button.disabled = disabled;
            if (label !== undefined && button.textContent !== label) button.textContent = label;
        }
    }
}
