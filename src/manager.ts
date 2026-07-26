import type { CreateMeetingOptions, MeetingSession } from "./meeting";
import { createMeeting } from "./meeting";
import type { MeetingSource } from "./source";

export type MeetingSourceFactoryInput = {
  /** Stable host-owned identity used for tracing, idempotency, and storage. */
  sessionId: string;
  /**
   * Adapter-defined call target. Recall uses a Meet/Zoom/Teams URL; Discord
   * uses a voice-channel id. The core deliberately does not interpret it.
   */
  target: string;
};

export type MeetingSourceFactory = (
  input: MeetingSourceFactoryInput,
) => MeetingSource | Promise<MeetingSource>;

export type MeetingManagerOptions = Omit<
  CreateMeetingOptions,
  "sessionId" | "source"
> & {
  source: MeetingSourceFactory;
};

export type ManagedMeeting = {
  meeting: MeetingSession;
  sessionId: string;
  target: string;
};

export type MeetingManager = {
  /**
   * Create and join one meeting. Session ids are unique while active; callers
   * retrying the same id receive the existing session without joining twice.
   */
  start(input: MeetingSourceFactoryInput): Promise<MeetingSession>;
  get(sessionId: string): MeetingSession | undefined;
  list(): ManagedMeeting[];
  stop(sessionId: string, reason?: string): Promise<boolean>;
};

/**
 * Multi-session host boundary for dynamic meeting targets. It keeps provider
 * configuration in the source factory and accepts only the per-call target
 * and stable session identity at execution time.
 */
export const createMeetingManager = (
  options: MeetingManagerOptions,
): MeetingManager => {
  const active = new Map<string, ManagedMeeting>();
  const pending = new Map<
    string,
    { promise: Promise<MeetingSession>; target: string }
  >();

  const start = async (
    input: MeetingSourceFactoryInput,
  ): Promise<MeetingSession> => {
    const existing = active.get(input.sessionId);
    if (existing !== undefined) {
      if (existing.target !== input.target) {
        throw new Error(
          `meeting session ${input.sessionId} is already bound to a different target`,
        );
      }
      return existing.meeting;
    }
    const inFlight = pending.get(input.sessionId);
    if (inFlight !== undefined) {
      if (inFlight.target !== input.target) {
        throw new Error(
          `meeting session ${input.sessionId} is already being created for a different target`,
        );
      }
      return inFlight.promise;
    }

    const create = (async () => {
      const source = await options.source(input);
      const meeting = await createMeeting({
        ...(options.languageStrategy !== undefined
          ? { languageStrategy: options.languageStrategy }
          : {}),
        ...(options.lexicon !== undefined ? { lexicon: options.lexicon } : {}),
        ...(options.phraseHints !== undefined
          ? { phraseHints: options.phraseHints }
          : {}),
        sessionId: input.sessionId,
        source,
        stt: options.stt,
      });
      active.set(input.sessionId, {
        meeting,
        sessionId: input.sessionId,
        target: input.target,
      });
      meeting.on("end", () => {
        active.delete(input.sessionId);
      });
      try {
        await meeting.start();
      } catch (error) {
        active.delete(input.sessionId);
        throw error;
      }

      return meeting;
    })();

    pending.set(input.sessionId, { promise: create, target: input.target });
    try {
      return await create;
    } finally {
      pending.delete(input.sessionId);
    }
  };

  return {
    get: (sessionId) => active.get(sessionId)?.meeting,
    list: () => [...active.values()],
    start,
    stop: async (sessionId, reason) => {
      const managed = active.get(sessionId);
      if (managed === undefined) return false;
      await managed.meeting.stop(reason);
      active.delete(sessionId);
      return true;
    },
  };
};
