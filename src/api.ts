import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
    Platform,
    SpeechRequest,
    SpeechService,
    SynthesizedSpeech,
    SynthesisUpdate,
    Voice,
} from "./types.ts";

export const speechService: SpeechService = {
    synthesize: (request, jobId, onUpdate) => {
        const channel = new Channel<SynthesisUpdate>(onUpdate);
        return invoke<SynthesizedSpeech>("synthesize", {
            request,
            jobId,
            streaming: Boolean(onUpdate),
            onUpdate: channel,
        });
    },
    cancel: (jobId) => invoke<void>("set_current_job", { jobId }),
};

export const closeWindow = () => getCurrentWindow().close();
export const onSelection = (handler: (text: string) => void) =>
    listen<string>("selection-text", ({ payload }) => handler(payload));
export const onSaveProgress = (handler: (jobId: number, percent: number) => void) =>
    listen<{ jobId: number; percent: number }>("save-progress", ({ payload }) =>
        handler(payload.jobId, payload.percent),
    );

export const getPlatform = () => invoke<Platform>("get_platform");

export const getVoices = () => invoke<Voice[]>("get_voices");

export const saveAudio = (request: SpeechRequest, jobId: number) =>
    invoke<string | null>("save_audio", { request, jobId });
