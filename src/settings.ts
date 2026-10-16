export interface Preferences {
    voice: string;
    speed: number;
    pitch: number;
    volume: number;
    markdown: boolean;
    code: boolean;
}

const keys: Record<keyof Preferences, string> = {
    voice: "edge_tts_voice",
    speed: "edge_tts_speed",
    pitch: "edge_tts_pitch",
    volume: "edge_tts_volume",
    markdown: "edge_tts_markdown",
    code: "edge_tts_pronounce_code",
};

export function loadPreferences(storage: Pick<Storage, "getItem"> = localStorage): Preferences {
    const number = (key: keyof Preferences, fallback: number, min: number, max: number) => {
        const value = storage.getItem(keys[key]);
        const parsed = value === null ? fallback : Number(value);
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
    };
    return {
        voice: storage.getItem(keys.voice) ?? "",
        speed: number("speed", 1, 0.5, 3),
        pitch: Math.round(number("pitch", 0, -50, 50)),
        volume: number("volume", 1, 0, 1),
        markdown: storage.getItem(keys.markdown) === "true",
        code: storage.getItem(keys.code) !== "false",
    };
}

export function storePreferences(preferences: Preferences): void {
    for (const key of Object.keys(keys) as (keyof Preferences)[]) {
        localStorage.setItem(keys[key], String(preferences[key]));
    }
}
