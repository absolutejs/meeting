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
 * A text message in the call's chat. `kind` distinguishes ordinary messages
 * from emoji reactions and platform/system notices; everything but `text` is
 * best-effort and may be absent depending on what the source can report.
 */
export type ChatMessage = {
  /** The message body (or reaction emoji / system text). */
  text: string;
  /** What sort of chat event this is. Defaults to a normal "message". */
  kind?: "message" | "reaction" | "system";
  /** Resolved sender, when the source identified them. */
  author?: MeetingParticipant;
  /** Raw platform sender id, even when the full participant isn't resolved. */
  authorId?: string;
  /** Epoch ms the message was sent, when the source reports it. */
  timestamp?: number;
  /** Platform channel/thread id the message belongs to, when applicable. */
  channelId?: string;
};

/**
 * Which in-call outputs a source supports. Mirrors the optional `speak` /
 * `sendChat` members so a consumer can branch on capabilities up front instead
 * of probing for thrown "not implemented" errors.
 */
export type MeetingCapabilities = {
  /** The bot can play audio INTO the call (`speak`). */
  canSpeak: boolean;
  /** The bot can post text into the call chat (`sendChat`). */
  canChat: boolean;
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
  /** Roster update — someone joined / left / was identified. `status` signals
   *  the transition: "joined" (or absent — the historical behavior) when a
   *  participant appears/is identified, "left" when they leave the call. */
  participant: {
    participant: MeetingParticipant;
    status?: "joined" | "left";
  };
  /** A text message arrived in the call chat. */
  chat: { message: ChatMessage };
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
  /**
   * Stop any in-progress `speak()` output immediately (barge-in / ducking).
   * Optional — sources that can't inject audio (or can't stop it) omit it;
   * `meeting.stopSpeaking()` then no-ops.
   */
  stopSpeaking?: () => Promise<void>;
  /**
   * Post a text message INTO the call chat. Optional — adapters that can't write
   * chat simply don't implement it; `meeting.sendChat()` will throw a clear
   * error in that case. `opts.system` is a hint for platforms that distinguish
   * system/announcement messages from ordinary ones (ignored elsewhere).
   */
  sendChat?: (text: string, opts?: { system?: boolean }) => Promise<void>;
  /**
   * What this source can do (speak / chat). Optional — when absent, consumers
   * fall back to probing the presence of `speak` / `sendChat`.
   */
  readonly capabilities?: MeetingCapabilities;
};
