/** Full-window reading without changing the playback session or replacing the editor. */
export class ReaderMode {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private previousFocus: HTMLElement | null = null;
    private keyboard = false;
    private background: HTMLElement[] = [];
    private wasReadonly = false;
    private pointerStart: { x: number; y: number } | null = null;
    active = false;

    private container: HTMLElement;
    private trigger: HTMLButtonElement;
    private overlay: HTMLElement;
    private toolbar: HTMLElement;
    private input: HTMLTextAreaElement;
    private isFollowing: () => boolean;

    constructor(
        container: HTMLElement,
        trigger: HTMLButtonElement,
        overlay: HTMLElement,
        toolbar: HTMLElement,
        input: HTMLTextAreaElement,
        isFollowing: () => boolean,
    ) {
        this.container = container;
        this.trigger = trigger;
        this.overlay = overlay;
        this.toolbar = toolbar;
        this.input = input;
        this.isFollowing = isFollowing;
        trigger.addEventListener("click", () => this.enter());
        container.addEventListener("pointerdown", (event) => {
            this.keyboard = false;
            this.pointerStart = { x: event.clientX, y: event.clientY };
        });
        container.addEventListener("click", (event) => {
            if (!this.active) return;
            if ((event.target as Element).closest("button, a")) {
                this.reveal();
                return;
            }
            const start = this.pointerStart;
            this.pointerStart = null;
            // Selecting text or dragging a scrollbar is not a tap.
            if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
            if (document.documentElement.classList.contains("reader-controls-visible")) this.hide();
            else this.reveal();
        });
        container.addEventListener("wheel", () => this.reveal(), { passive: true });
        container.addEventListener("touchmove", () => this.reveal(), { passive: true });
        container.addEventListener("scroll", () => {
            // Programmatic word-following must not keep the controls awake.
            if (!this.isFollowing()) this.reveal();
        }, { capture: true, passive: true });
        document.addEventListener("keydown", (event) => {
            if (!this.active) return;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.exit();
            } else {
                this.keyboard = true;
                this.reveal();
                if (event.key === "Tab") this.trapFocus(event);
            }
        }, true);
    }

    enter(): void {
        if (this.active) return;
        this.active = true;
        this.keyboard = false;
        this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.wasReadonly = this.input.readOnly;
        this.input.readOnly = true;
        // Prevent keyboard navigation from reaching controls behind the fullscreen reader.
        this.background = [...document.querySelectorAll<HTMLElement>(
            ".editor-header, .meta, .shell > :not(.editor)",
        )].filter((node) => !node.inert);
        for (const node of this.background) node.inert = true;
        document.documentElement.classList.add("reading-fullscreen");
        this.trigger.setAttribute("aria-expanded", "true");
        this.container.setAttribute("role", "dialog");
        this.container.setAttribute("aria-modal", "true");
        this.container.setAttribute("aria-label", "Fullscreen reader");
        this.overlay.hidden = false;
        this.container.focus({ preventScroll: true });
        this.reveal();
    }

    exit(): void {
        if (!this.active) return;
        this.active = false;
        this.cancelTimer();
        this.overlay.hidden = true;
        this.toolbar.inert = false;
        this.toolbar.removeAttribute("aria-hidden");
        document.documentElement.classList.remove("reading-fullscreen", "reader-controls-visible");
        this.trigger.setAttribute("aria-expanded", "false");
        this.container.removeAttribute("role");
        this.container.removeAttribute("aria-modal");
        this.container.removeAttribute("aria-label");
        this.input.readOnly = this.wasReadonly;
        for (const node of this.background) node.inert = false;
        this.background = [];
        this.previousFocus?.focus({ preventScroll: true });
    }

    reveal(): void {
        if (!this.active) return;
        document.documentElement.classList.add("reader-controls-visible");
        this.toolbar.inert = false;
        this.toolbar.removeAttribute("aria-hidden");
        this.cancelTimer();
        this.timer = setTimeout(() => this.hide(), 3000);
    }

    private hide(): void {
        this.cancelTimer();
        if (this.keyboard && this.toolbar.contains(document.activeElement)) {
            this.reveal();
            return;
        }
        if (this.toolbar.contains(document.activeElement)) {
            this.container.focus({ preventScroll: true });
        }
        document.documentElement.classList.remove("reader-controls-visible");
        this.toolbar.inert = true;
        this.toolbar.setAttribute("aria-hidden", "true");
    }

    private cancelTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    private trapFocus(event: KeyboardEvent): void {
        const nodes = [...this.container.querySelectorAll<HTMLElement>(
            'button:not(:disabled):not([hidden]), textarea:not([hidden]), [tabindex="0"]:not([hidden])',
        )].filter((node) => node.getClientRects().length > 0);
        if (!nodes.length) return;
        // Read-only text and scroll containers have different native Tab behavior
        // across WebView platforms. Keep the complete modal focus order explicit.
        const current = nodes.indexOf(document.activeElement as HTMLElement);
        const next = current < 0
            ? event.shiftKey ? nodes.length - 1 : 0
            : (current + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
        event.preventDefault();
        nodes[next].focus({ preventScroll: true });
    }
}
