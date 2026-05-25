import type { AudioFormat } from "@absolutejs/voice";
import type {
  MeetingParticipant,
  MeetingSource,
  MeetingSourceEventMap,
} from "./source";

export type BufferMeetingSourceOptions = {
  format: AudioFormat;
  /** Raw audio matching `format` (e.g. pcm_s16le bytes). */
  pcm: Uint8Array;
  /** Chunk cadence in ms (how the buffer is paced out). Default 40. */
  chunkMs?: number;
  /** Optional roster to announce on start. */
  participants?: MeetingParticipant[];
};

const bytesPerSample = (format: AudioFormat) =>
  (format.encoding === "pcm_s16le" ? 2 : 1) * format.channels;

/**
 * A meeting source backed by an in-memory PCM buffer, paced out in real time.
 * Used to test the meeting core + voice scribe without a live platform, and as
 * the reference implementation of `MeetingSource` for adapter authors.
 */
export const createBufferMeetingSource = (
  options: BufferMeetingSourceOptions,
): MeetingSource => {
  const chunkMs = options.chunkMs ?? 40;
  const listeners: {
    [K in keyof MeetingSourceEventMap]: Set<
      (payload: MeetingSourceEventMap[K]) => void | Promise<void>
    >;
  } = {
    audio: new Set(),
    end: new Set(),
    error: new Set(),
    participant: new Set(),
  };
  const emit = <K extends keyof MeetingSourceEventMap>(
    event: K,
    payload: MeetingSourceEventMap[K],
  ) => {
    for (const handler of listeners[event]) void handler(payload);
  };
  let stopped = false;

  return {
    format: options.format,
    on: (event, handler) => {
      listeners[event].add(handler as never);

      return () => {
        listeners[event].delete(handler as never);
      };
    },
    start: async () => {
      for (const participant of options.participants ?? []) {
        emit("participant", { participant });
      }
      const chunkBytes = Math.max(
        2,
        Math.round((bytesPerSample(options.format) * options.format.sampleRateHz * chunkMs) / 1000),
      );
      void (async () => {
        for (
          let off = 0;
          off < options.pcm.length && !stopped;
          off += chunkBytes
        ) {
          emit("audio", { chunk: options.pcm.subarray(off, off + chunkBytes) });
          await new Promise((resolve) => setTimeout(resolve, chunkMs));
        }
        if (!stopped) emit("end", { reason: "buffer-complete" });
      })();
    },
    stop: async (reason) => {
      stopped = true;
      emit("end", { reason: reason ?? "stopped" });
    },
  };
};
