import {
  createVoiceScribe,
  type STTAdapter,
  type VoiceLanguageStrategy,
  type VoiceLexiconEntry,
  type VoicePhraseHint,
  type VoiceScribeTurn,
} from "@absolutejs/voice";
import { createEmitter } from "./emitter";
import type {
  ChatMessage,
  MeetingCapabilities,
  MeetingParticipant,
  MeetingSource,
  SpeakAudio,
} from "./source";

export type MeetingTurn = VoiceScribeTurn & {
  /** Resolved participant for this turn, when the source identified speakers. */
  participant?: MeetingParticipant;
};

export type MeetingEventMap = {
  turn: { turn: MeetingTurn };
  /** Roster update. `status` mirrors the source: "joined"/absent on appear,
   *  "left" when a participant leaves the call. */
  participant: {
    participant: MeetingParticipant;
    status?: "joined" | "left";
  };
  /** A text message arrived in the call chat. */
  chat: { message: ChatMessage };
  end: { reason?: string; transcript: MeetingTurn[] };
  error: { error: Error };
};

export type MeetingSession = {
  on: <K extends keyof MeetingEventMap>(
    event: K,
    handler: (payload: MeetingEventMap[K]) => void | Promise<void>,
  ) => () => void;
  /** Join the call and start transcribing. */
  start: () => Promise<void>;
  /** Leave the call, finalize, and emit `end` with the full transcript. */
  stop: (reason?: string) => Promise<void>;
  /**
   * Play audio INTO the call (the bot speaks). Delegates to the source; throws
   * if the underlying adapter doesn't implement `speak`. See `SpeakAudio` for
   * the formats each adapter accepts (Recall: mp3; Discord: pcm).
   */
  speak: (audio: SpeakAudio) => Promise<void>;
  /** Cut the bot's in-progress speech (barge-in). No-op when the source can't
   *  inject/stop audio or nothing is playing. */
  stopSpeaking: () => Promise<void>;
  /**
   * Post a text message INTO the call chat. Delegates to the source; throws if
   * the underlying adapter doesn't implement `sendChat`. `opts.system` is a hint
   * for platforms that distinguish system messages (ignored elsewhere).
   */
  sendChat: (text: string, opts?: { system?: boolean }) => Promise<void>;
  /** What the underlying source can do (speak / chat). */
  readonly capabilities: MeetingCapabilities;
  getTranscript: () => MeetingTurn[];
  getParticipants: () => MeetingParticipant[];
};

export type CreateMeetingOptions = {
  source: MeetingSource;
  stt: STTAdapter;
  sessionId: string;
  languageStrategy?: VoiceLanguageStrategy;
  lexicon?: VoiceLexiconEntry[];
  phraseHints?: VoicePhraseHint[];
};

/**
 * Wire a meeting source (any platform) to the voice scribe: audio flows
 * source → scribe → diarized turns; the participant roster from the source is
 * tracked alongside. Platform-agnostic — the Recall / Discord / onSpark
 * adapters all satisfy `MeetingSource`, so this core never changes per platform.
 */
export const createMeeting = async (
  options: CreateMeetingOptions,
): Promise<MeetingSession> => {
  const scribe = await createVoiceScribe({
    format: options.source.format,
    languageStrategy: options.languageStrategy,
    lexicon: options.lexicon,
    phraseHints: options.phraseHints,
    sessionId: options.sessionId,
    stt: options.stt,
  });

  const participants = new Map<string, MeetingParticipant>();
  // The participant the source last attributed audio to (per-user-stream
  // sources); lets us label turns even when STT diarization can't.
  let lastSpeaker: string | undefined;

  const { emit, on } = createEmitter<MeetingEventMap>([
    "chat",
    "end",
    "error",
    "participant",
    "turn",
  ]);

  const resolveParticipant = (
    turn: VoiceScribeTurn,
  ): MeetingParticipant | undefined =>
    participants.get(turn.speaker) ??
    (lastSpeaker ? participants.get(lastSpeaker) : undefined);

  scribe.on("turn", ({ turn }) => {
    emit("turn", { turn: { ...turn, participant: resolveParticipant(turn) } });
  });
  scribe.on("error", (event) => emit("error", { error: event.error }));

  let ended = false;
  const unsubscribe: (() => void)[] = [];

  const finalize = async (reason?: string) => {
    if (ended) return;
    ended = true;
    for (const off of unsubscribe) off();
    await scribe.close(reason);
    const transcript = scribe.getTranscript().map((turn) => ({
      ...turn,
      participant: resolveParticipant(turn),
    }));
    emit("end", { reason, transcript });
  };

  unsubscribe.push(
    options.source.on("audio", ({ chunk, participant }) => {
      if (participant) lastSpeaker = participant;
      void scribe.send(chunk);
    }),
    options.source.on("participant", ({ participant, status }) => {
      // Keep the roster on join/identify; on "left" forward the event but leave
      // the participant in the map so past turns keep their resolved speaker.
      if (status !== "left") participants.set(participant.id, participant);
      emit("participant", { participant, ...(status ? { status } : {}) });
    }),
    options.source.on("chat", (payload) => emit("chat", payload)),
    options.source.on("end", ({ reason }) => void finalize(reason)),
    options.source.on("error", ({ error }) => emit("error", { error })),
  );

  const capabilities: MeetingCapabilities = options.source.capabilities ?? {
    canChat: Boolean(options.source.sendChat),
    canSpeak: Boolean(options.source.speak),
  };

  return {
    capabilities,
    getParticipants: () => [...participants.values()],
    getTranscript: () =>
      scribe.getTranscript().map((turn) => ({
        ...turn,
        participant: resolveParticipant(turn),
      })),
    on,
    sendChat: async (text, opts) => {
      if (!options.source.sendChat) {
        throw new Error(
          "meeting.sendChat: this source does not implement sendChat() — the bot can't post to the call chat",
        );
      }
      await options.source.sendChat(text, opts);
    },
    speak: async (audio) => {
      if (!options.source.speak) {
        throw new Error(
          "meeting.speak: this source does not implement speak() — the bot can't play audio into the call",
        );
      }
      await options.source.speak(audio);
    },
    stopSpeaking: async () => {
      // Barge-in: cut the bot's in-progress speech. No-op for sources that
      // can't inject (or stop) audio.
      await options.source.stopSpeaking?.();
    },
    start: () => options.source.start(),
    stop: async (reason) => {
      // Leave the call first (source emits "end" → finalize), then ensure
      // finalize ran even if the source didn't emit (finalize is idempotent).
      await options.source.stop(reason);
      await finalize(reason);
    },
  };
};
