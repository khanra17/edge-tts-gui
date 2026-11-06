import DOMPurify from "dompurify";
import { marked } from "marked";
import type { PlaybackView, Sentence, TextRange } from "./types.ts";

interface Segment extends TextRange {
    node: Text;
}

const BLOCKS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "DIV",
    "FOOTER",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "LI",
    "MAIN",
    "NAV",
    "P",
    "PRE",
    "SECTION",
    "TR",
]);

export function markdownHtml(source: string): string {
    const body = source.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
    return DOMPurify.sanitize(marked.parse(body, { async: false }), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
        FORBID_ATTR: ["style"],
    });
}

export function speechModel(
    root: HTMLElement,
    pronounceCode: boolean,
): { text: string; segments: Segment[] } {
    let text = "";
    const segments: Segment[] = [];
    const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const start = text.length;
            text += node.textContent ?? "";
            segments.push({ node: node as Text, start, end: text.length });
        } else if (node instanceof HTMLElement) {
            const tag = node.tagName;
            if ((tag === "CODE" || tag === "PRE") && !pronounceCode) {
                text += tag === "PRE" ? "\n" : " ";
            } else if (tag === "IMG") {
                text += node.getAttribute("alt") ?? "";
            } else if (tag === "BR") {
                text += "\n";
            } else {
                node.childNodes.forEach(visit);
                if (tag === "TD" || tag === "TH") text += " ";
                if (BLOCKS.has(tag)) text += "\n";
            }
        }
    };
    root.childNodes.forEach(visit);
    return { text, segments };
}

/** Space left above the highlight when auto-scroll brings it back into view. */
const SCROLL_MARGIN = 0.12;

const MIRRORED_STYLES = [
    "boxSizing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "fontVariant",
    "fontStretch",
    "letterSpacing",
    "lineHeight",
    "tabSize",
    "textIndent",
    "textTransform",
    "wordSpacing",
    "wordBreak",
    "overflowWrap",
    "whiteSpace",
] as const;

/** New scroll position that puts `top` near the top of the viewport, or null if already visible. */
export function revealTop(
    top: number,
    bottom: number,
    scrollTop: number,
    viewport: number,
): number | null {
    if (top >= scrollTop && bottom <= scrollTop + viewport) return null;
    return Math.max(0, top - viewport * SCROLL_MARGIN);
}

export class Editor {
    readonly input: HTMLTextAreaElement;
    readonly preview: HTMLDivElement;
    private scrollActions: HTMLElement;
    private segments: Segment[] = [];
    private spoken = "";
    private markdown = false;
    private code = true;
    private autoScroll = true;
    private active = false;
    private highlighted = "";
    private lastRange: TextRange | null = null;
    private mirror: HTMLDivElement | null = null;

    constructor(
        input: HTMLTextAreaElement,
        preview: HTMLDivElement,
        followButton: HTMLButtonElement,
        scrollActions: HTMLElement = followButton,
    ) {
        this.input = input;
        this.preview = preview;
        this.scrollActions = scrollActions;
        for (const element of [input, preview]) {
            const disableScroll = () => {
                if (!this.active) return;
                this.autoScroll = false;
                this.scrollActions.hidden = false;
            };
            element.addEventListener("wheel", disableScroll, { passive: true });
            element.addEventListener("touchmove", disableScroll, { passive: true });
            element.addEventListener("keydown", (event) => {
                if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes((event as KeyboardEvent).key)) {
                    disableScroll();
                }
            });
            element.addEventListener("pointerdown", (event) => {
                if ((event as PointerEvent).offsetX >= element.clientWidth) disableScroll();
            });
        }
        followButton.addEventListener("click", () => this.follow());
        preview.addEventListener("click", (event) => {
            if ((event.target as Element).closest("a")) event.preventDefault();
        });
        preview.addEventListener("beforeinput", (event) => event.preventDefault());
        // A read-only region has no native Paste menu item. Become editable just
        // before the context menu opens so it offers Paste; the beforeinput guard
        // keeps the rendered Markdown unchanged and the paste handler appends.
        const allowPaste = () => {
            preview.contentEditable = "true";
            preview.inputMode = "none";
        };
        const blockPaste = () => {
            if (!preview.isContentEditable) return;
            preview.removeAttribute("contenteditable");
            preview.removeAttribute("inputmode");
        };
        preview.addEventListener("pointerdown", (event) => {
            if (event.button === 2) allowPaste();
            else blockPaste();
        });
        preview.addEventListener("contextmenu", allowPaste);
        preview.addEventListener("focusout", blockPaste);
        preview.addEventListener("keydown", (event) => {
            if (event.key === "Escape") blockPaste();
        });
    }

    /** Resume keeping the spoken text in view. */
    follow(): void {
        this.autoScroll = true;
        this.scrollActions.hidden = true;
        if (this.lastRange) this.select(this.lastRange);
    }

    /**
     * Start offset of the first sentence that begins inside the visible text, or the
     * sentence that fills the view when none begins there. Works in both directions.
     */
    visibleOffset(sentences: readonly Sentence[]): number | null {
        if (!sentences.length) return null;
        const surface = this.markdown ? this.preview : this.input;
        const height = surface.clientHeight;
        if (!height) return null;
        // The fullscreen top bar can cover the first lines.
        const fullscreen = document.documentElement.classList.contains("reading-fullscreen");
        const line = (fullscreen ? 56 : 0) + height * 0.03;
        const top = (index: number): number => {
            const sentence = sentences[index];
            if (this.markdown) {
                const rect = this.ranges(sentence)[0]?.getBoundingClientRect();
                if (!rect) return -Infinity;
                return rect.top - this.preview.getBoundingClientRect().top - this.preview.clientTop;
            }
            const position = this.inputLine(sentence.start);
            return position ? position.top - this.input.scrollTop : -Infinity;
        };
        let low = 0;
        let high = sentences.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (top(middle) >= line) high = middle;
            else low = middle + 1;
        }
        const index = low < sentences.length && top(low) < height ? low : Math.max(0, low - 1);
        return sentences[index].start;
    }

    /** Text offset under an Alt+click, in the coordinates of the spoken text. */
    offsetAt(event: MouseEvent): number | null {
        if (event.target === this.input) return this.input.selectionStart;
        if (!this.markdown || !this.preview.contains(event.target as Node)) return null;
        const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
        const node = position?.offsetNode ?? null;
        const offset = position?.offset ?? 0;
        const segment = this.segments.find((item) => item.node === node);
        return segment ? segment.start + offset : null;
    }

    get following(): boolean {
        return this.active && this.autoScroll;
    }

    get text(): string {
        return this.markdown ? this.spoken : this.input.value;
    }

    refresh(markdown: boolean, code: boolean): void {
        this.clear();
        this.markdown = markdown;
        this.code = code;
        this.input.hidden = markdown;
        this.preview.hidden = !markdown;
        this.preview.classList.toggle("skip-code", !code);
        if (markdown) {
            this.preview.innerHTML = markdownHtml(this.input.value);
            const model = speechModel(this.preview, this.code);
            this.spoken = model.text;
            this.segments = model.segments;
        } else {
            this.preview.replaceChildren();
            this.spoken = "";
            this.segments = [];
        }
    }

    highlight(view: PlaybackView): void {
        this.active = view.status !== "idle";
        if (!this.active) {
            this.clear();
            return;
        }
        const sentence = view.sentences[view.sentenceIndex];
        if (!sentence) return;
        const range = view.word ?? sentence;
        const key = `${sentence.start}:${range.start}:${range.end}`;
        if (key === this.highlighted) return;
        this.highlighted = key;
        this.lastRange = range;
        if (this.markdown && CSS.highlights) {
            CSS.highlights.set("spoken-sentence", new Highlight(...this.ranges(sentence)));
            CSS.highlights.set(
                "spoken-word",
                new Highlight(...(view.word ? this.ranges(view.word) : [])),
            );
            if (this.autoScroll) this.scrollPreview(range);
        } else {
            this.select(range);
        }
    }

    clear(): void {
        CSS.highlights?.delete("spoken-sentence");
        CSS.highlights?.delete("spoken-word");
        this.highlighted = "";
        this.lastRange = null;
        this.autoScroll = true;
        this.scrollActions.hidden = true;
    }

    private ranges(selection: TextRange): Range[] {
        return this.segments
            .filter((segment) => segment.end > selection.start && segment.start < selection.end)
            .map((segment) => {
                const range = document.createRange();
                range.setStart(segment.node, Math.max(0, selection.start - segment.start));
                range.setEnd(
                    segment.node,
                    Math.min(segment.node.length, selection.end - segment.start),
                );
                return range;
            });
    }

    private scrollPreview(selection: TextRange): void {
        const rect = this.ranges(selection)[0]?.getBoundingClientRect();
        if (!rect) return;
        const container = this.preview.getBoundingClientRect();
        const offset = this.preview.scrollTop - container.top - this.preview.clientTop;
        const target = revealTop(
            rect.top + offset,
            rect.bottom + offset,
            this.preview.scrollTop,
            this.preview.clientHeight,
        );
        if (target !== null) this.preview.scrollTop = target;
    }

    /** Vertical position of a character inside the textarea's scrollable content. */
    private inputLine(index: number): { top: number; bottom: number } | null {
        const input = this.input;
        if (!input.clientWidth) return null;
        if (!this.mirror) {
            this.mirror = document.createElement("div");
            this.mirror.setAttribute("aria-hidden", "true");
            Object.assign(this.mirror.style, {
                position: "absolute",
                visibility: "hidden",
                pointerEvents: "none",
                top: "0",
                left: "-10000px",
                border: "0",
                overflow: "hidden",
            });
            document.body.append(this.mirror);
        }
        const mirror = this.mirror;
        const style = getComputedStyle(input);
        for (const name of MIRRORED_STYLES) mirror.style[name] = style[name];
        mirror.style.boxSizing = "border-box";
        mirror.style.width = `${input.clientWidth}px`;
        if (mirror.textContent !== input.value) mirror.textContent = input.value;
        const node = mirror.firstChild as Text | null;
        if (!node) return null;
        const range = document.createRange();
        const start = Math.min(index, node.length);
        range.setStart(node, start);
        range.setEnd(node, Math.min(node.length, start + 1));
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        const top = rect.top - mirror.getBoundingClientRect().top;
        return { top, bottom: top + Math.max(rect.height, 1) };
    }

    private select(range: TextRange): void {
        if (this.markdown) {
            if (this.autoScroll) this.scrollPreview(range);
            return;
        }
        const top = this.input.scrollTop;
        const left = this.input.scrollLeft;
        if (this.autoScroll && !document.documentElement.classList.contains("reading-fullscreen") &&
            !matchMedia("(any-pointer: coarse)").matches) {
            this.input.focus({ preventScroll: true });
        }
        this.input.setSelectionRange(range.start, range.end);
        if (this.autoScroll) {
            const line = this.inputLine(range.start);
            const target = line
                ? revealTop(line.top, line.bottom, top, this.input.clientHeight)
                : null;
            this.input.scrollTop = target ?? top;
            this.input.scrollLeft = left;
        } else {
            this.input.scrollTop = top;
            this.input.scrollLeft = left;
        }
    }
}
