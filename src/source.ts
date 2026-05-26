import type { AudioChunk, AudioFormat } from "@absolutejs/voice";

/** A participant in the call, as reported by the source platform. */
export type MeetingParticipant = {
  id: string;
  name?: string;
  /** Platform of origin, e.g. "recall", "discord", "onspark". */
  platform?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Audio the bot wants to play INTO the call. Adapters declare which formats
 * they accept (Recall: mp3; Discord: pcm); a TypeError is the right signal
 * when an adapter is handed a format it cannot play.
 */
export type SpeakAudio =
  | { format: "mp3"; data: ArrayBuffer | Uint8Array }
  | {
      format: "pcm";
      data: ArrayBuffer | Uint8Array;
      sampleRateHz: number;
      channels: number;
    };

export type MeetingSourceEventMap = {
  /** A chunk of call audio (in `format`). `participant` is set when the source
   *  knows who is speaking for this chunk (per-user streams); otherwise omit it
   *  and rely on the scribe's diarization. */
  audio: { chunk: AudioChunk; participant?: string };
  /** Roster update — someone joined / was identified. */
  participant: { participant: MeetingParticipant };
  /** The call ended (everyone left, host stopped, etc.). */
  end: { reason?: string };
  error: { error: Error };
};

/**
 * A meeting "source" — the thing that gets audio out of a call. Implemented by
 * the platform adapters (`@absolutejs/meeting-recall`, `@absolutejs/meeting-
 * discord`, an onSpark browser source, …). The core only depends on this
 * contract, so a new platform is just a new adapter.
 */
export type MeetingSource = {
  /** Audio format this source emits — fed straight into the scribe's STT. */
  readonly format: AudioFormat;
  on: <K extends keyof MeetingSourceEventMap>(
    event: K,
    handler: (payload: MeetingSourceEventMap[K]) => void | Promise<void>,
  ) => () => void;
  /** Join the call / begin streaming audio. */
  start: () => Promise<void>;
  /** Leave the call / stop streaming. */
  stop: (reason?: string) => Promise<void>;
  /**
   * Play audio INTO the call (the bot speaks). Optional — adapters that can't
   * inject audio simply don't implement it; `meeting.speak()` will throw a
   * clear error in that case. Resolves when playback finishes (or as soon as
   * the platform has accepted it, for fire-and-forget transports).
   */
  speak?: (audio: SpeakAudio) => Promise<void>;
};
