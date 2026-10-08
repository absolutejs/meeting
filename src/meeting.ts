import {
  createVoiceScribe,
  type STTAdapter,
  type VoiceLanguageStrategy,
  type VoiceLexiconEntry,
  type VoicePhraseHint,
  type VoiceScribeTurn,
  type VoiceScribeSession,
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
  /** The speaker stopped: the turns finalized since the previous end of turn,
   *  i.e. one utterance the STT vendor may have finalized in several pieces
   *  while the person was still talking. Act on requests here rather than on
   *  each `turn`. Needs @absolutejs/voice 0.0.22-beta.679 or later; older
   *  scribes never emit it. */
  endOfTurn: { turns: MeetingTurn[] };
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
  /** Total raw audio duration submitted across transcription streams. */
  getTranscriptionSeconds: () => number;
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
  const participants = new Map<string, MeetingParticipant>();
  const transcript: MeetingTurn[] = [];
  const beganAt = Date.now();
  let audioBytes = 0,
    closing = false,
    finished = false;
  let finishPromise: Promise<void> | undefined;
  const { emit, on } = createEmitter<MeetingEventMap>([
    "chat",
    "end",
    "endOfTurn",
    "error",
    "participant",
    "turn",
  ]);
  type Stream = { ready: Promise<VoiceScribeSession>; pending: Promise<void> };
  // Participant IDs bind separate audio channels to their own STT stream.
  // Delayed results never inherit whichever participant spoke most recently.
  // Sources without participant attribution retain a separate mixed stream.
  const streams = new Map<string | undefined, Stream>();
  const streamFor = (participantId?: string) => {
    const existing = streams.get(participantId);
    if (existing) return existing;
    const offset = Date.now() - beganAt;
    const ready = (async () => {
      const scribe = await createVoiceScribe({
        format: options.source.format,
        languageStrategy: options.languageStrategy,
        lexicon: options.lexicon,
        phraseHints: options.phraseHints,
        sessionId: `${options.sessionId}:${participantId ?? "mixed"}`,
        stt: options.stt,
      });
      const resolved = new WeakMap<VoiceScribeTurn, MeetingTurn>();
      const resolve = (turn: VoiceScribeTurn): MeetingTurn => {
        const known = resolved.get(turn);
        if (known) return known;
        const participant =
          participantId !== undefined
            ? (participants.get(participantId) ?? { id: participantId })
            : participants.get(turn.speaker);
        const value = {
          ...turn,
          ...(participantId !== undefined ? { speaker: participantId } : {}),
          ...(turn.startedAtMs !== undefined
            ? { startedAtMs: turn.startedAtMs + offset }
            : {}),
          ...(turn.endedAtMs !== undefined
            ? { endedAtMs: turn.endedAtMs + offset }
            : {}),
          ...(participant ? { participant: { ...participant } } : {}),
        };
        resolved.set(turn, value);
        return value;
      };
      scribe.on("turn", ({ turn }) => {
        if (finished) return;
        const value = resolve(turn);
        transcript.push(value);
        emit("turn", { turn: value });
      });
      try {
        scribe.on("endOfTurn", ({ turns }) => {
          if (!finished) emit("endOfTurn", { turns: turns.map(resolve) });
        });
      } catch {
        /* Older voice scribes still emit finalized turns. */
      }
      scribe.on("error", (event) => {
        if (!finished) emit("error", event);
      });
      return scribe;
    })();
    const stream = { ready, pending: Promise.resolve() };
    streams.set(participantId, stream);
    return stream;
  };
  const unsubscribe: (() => void)[] = [];
  const finalize = (reason?: string): Promise<void> => {
    if (finishPromise) return finishPromise;
    closing = true;
    for (const off of unsubscribe) off();
    finishPromise = (async () => {
      await Promise.all(
        [...streams.values()].map(async (stream) => {
          await stream.pending;
          try {
            await (await stream.ready).close(reason);
          } catch (error) {
            emit("error", {
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
        }),
      );
      finished = true;
      emit("end", { reason, transcript: [...transcript] });
    })();
    return finishPromise;
  };
  unsubscribe.push(
    options.source.on("audio", ({ chunk, participant }) => {
      if (closing) return;
      const stream = streamFor(participant);
      // Keep frames in order while the STT connection opens, too.
      stream.pending = stream.pending
        .then(async () => {
          const scribe = await stream.ready;
          await scribe.send(chunk);
          audioBytes += chunk.byteLength;
        })
        .catch((error) =>
          emit("error", {
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        );
    }),
    options.source.on("participant", ({ participant, status }) => {
      if (status !== "left") participants.set(participant.id, participant);
      emit("participant", { participant, ...(status ? { status } : {}) });
    }),
    options.source.on("chat", (payload) => emit("chat", payload)),
    options.source.on("end", ({ reason }) => {
      void finalize(reason);
    }),
    options.source.on("error", ({ error }) => emit("error", { error })),
  );

  const capabilities: MeetingCapabilities = options.source.capabilities ?? {
    canChat: Boolean(options.source.sendChat),
    canSpeak: Boolean(options.source.speak),
  };

  return {
    capabilities,
    getParticipants: () => [...participants.values()],
    getTranscript: () => [...transcript],
    getTranscriptionSeconds: () =>
      audioBytes /
      (options.source.format.sampleRateHz *
        options.source.format.channels *
        (options.source.format.encoding === "pcm_s16le" ? 2 : 1)),
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
