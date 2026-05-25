import {
  createVoiceScribe,
  type STTAdapter,
  type VoiceLanguageStrategy,
  type VoiceLexiconEntry,
  type VoicePhraseHint,
  type VoiceScribeTurn,
} from "@absolutejs/voice";
import type { MeetingParticipant, MeetingSource } from "./source";

export type MeetingTurn = VoiceScribeTurn & {
  /** Resolved participant for this turn, when the source identified speakers. */
  participant?: MeetingParticipant;
};

export type MeetingEventMap = {
  turn: { turn: MeetingTurn };
  participant: { participant: MeetingParticipant };
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

  const listeners: {
    [K in keyof MeetingEventMap]: Set<
      (payload: MeetingEventMap[K]) => void | Promise<void>
    >;
  } = {
    end: new Set(),
    error: new Set(),
    participant: new Set(),
    turn: new Set(),
  };
  const emit = <K extends keyof MeetingEventMap>(
    event: K,
    payload: MeetingEventMap[K],
  ) => {
    for (const handler of listeners[event]) void handler(payload);
  };

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
    options.source.on("participant", ({ participant }) => {
      participants.set(participant.id, participant);
      emit("participant", { participant });
    }),
    options.source.on("end", ({ reason }) => void finalize(reason)),
    options.source.on("error", ({ error }) => emit("error", { error })),
  );

  return {
    getParticipants: () => [...participants.values()],
    getTranscript: () =>
      scribe.getTranscript().map((turn) => ({
        ...turn,
        participant: resolveParticipant(turn),
      })),
    on: (event, handler) => {
      listeners[event].add(handler as never);

      return () => {
        listeners[event].delete(handler as never);
      };
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
