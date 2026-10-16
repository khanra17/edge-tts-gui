import DOMPurify from "dompurify";
import { marked } from "marked";
import type { PlaybackView, TextRange } from "./types.ts";

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

export class Editor {
    readonly input: HTMLTextAreaElement;
    readonly preview: HTMLDivElement;
    private scrollButton: HTMLButtonElement;
    private segments: Segment[] = [];
    private spoken = "";
    private markdown = false;
    private code = true;
    private autoScroll = true;
    private active = false;
    private highlighted = "";
    private lastRange: TextRange | null = null;

    constructor(
        input: HTMLTextAreaElement,
        preview: HTMLDivElement,
        scrollButton: HTMLButtonElement,
    ) {
        this.input = input;
        this.preview = preview;
        this.scrollButton = scrollButton;
        for (const element of [input, preview]) {
            const disableScroll = () => {
                if (!this.active) return;
                this.autoScroll = false;
                this.scrollButton.hidden = false;
            };
            element.addEventListener("wheel", disableScroll, { passive: true });
            element.addEventListener("touchmove", disableScroll, { passive: true });
            element.addEventListener("pointerdown", (event) => {
                if ((event as PointerEvent).offsetX >= element.clientWidth) disableScroll();
            });
        }
        scrollButton.addEventListener("click", () => {
            this.autoScroll = true;
            scrollButton.hidden = true;
            if (this.lastRange) this.select(this.lastRange);
        });
        preview.addEventListener("click", (event) => {
            if ((event.target as Element).closest("a")) event.preventDefault();
        });
        preview.addEventListener("beforeinput", (event) => event.preventDefault());
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
            if (this.autoScroll) {
                const segment = this.segments.find(
                    (item) => item.end > range.start && item.start < range.end,
                );
                segment?.node.parentElement?.scrollIntoView({ block: "nearest" });
            }
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
        this.scrollButton.hidden = true;
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

    private select(range: TextRange): void {
        if (this.markdown) {
            this.segments
                .find((item) => item.end > range.start)
                ?.node.parentElement?.scrollIntoView({ block: "center" });
            return;
        }
        const top = this.input.scrollTop;
        const left = this.input.scrollLeft;
        if (this.autoScroll) this.input.focus({ preventScroll: true });
        this.input.setSelectionRange(range.start, range.end);
        if (this.autoScroll) {
            const fraction = range.start / Math.max(1, this.input.value.length);
            this.input.scrollTop = Math.max(
                0,
                fraction * this.input.scrollHeight - this.input.clientHeight / 2,
            );
        } else {
            this.input.scrollTop = top;
            this.input.scrollLeft = left;
        }
    }
}
