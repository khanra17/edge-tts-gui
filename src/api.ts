import { Channel, invoke } from "@tauri-apps/api/core";
import type {
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

export const getVoices = () => invoke<Voice[]>("get_voices");

export const saveAudio = (request: SpeechRequest, jobId: number) =>
    invoke<string | null>("save_audio", { request, jobId });
