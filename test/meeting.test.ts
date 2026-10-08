import { expect, test } from "bun:test";
import type { STTAdapter } from "@absolutejs/voice";
import {
  createBufferMeetingSource,
  createMeeting,
  createMeetingManager,
} from "../src";

const format = {
  channels: 1,
  container: "raw",
  encoding: "pcm_s16le",
  sampleRateHz: 16_000,
} as const;

const silentStt: STTAdapter = {
  kind: "stt",
  open: () => ({
    close: async () => {},
    on: () => () => {},
    send: async () => {},
  }),
};

test("buffer source streams participants, audio, and completion", async () => {
  const source = createBufferMeetingSource({
    chunkMs: 1,
    format,
    participants: [{ id: "ada", name: "Ada" }],
    pcm: new Uint8Array([1, 2, 3, 4]),
  });
  const participants: string[] = [];
  const chunks: number[] = [];
  const completed = new Promise<string | undefined>((resolve) => {
    source.on("end", ({ reason }) => resolve(reason));
  });

  source.on("participant", ({ participant }) => {
    participants.push(participant.id);
  });
  source.on("audio", ({ chunk }) => {
    chunks.push(chunk.byteLength);
  });

  await source.start();

  expect(await completed).toBe("buffer-complete");
  expect(participants).toEqual(["ada"]);
  expect(chunks).toEqual([4]);
});

test("meeting exposes source capabilities and retains its participant roster", async () => {
  const source = createBufferMeetingSource({
    chunkMs: 1,
    format,
    participants: [{ id: "grace", name: "Grace" }],
    pcm: new Uint8Array(),
  });
  const meeting = await createMeeting({
    sessionId: "meeting-test",
    source,
    stt: silentStt,
  });
  const completed = new Promise<void>((resolve) => {
    meeting.on("end", () => resolve());
  });

  await meeting.start();
  await completed;

  expect(meeting.capabilities).toEqual({ canChat: false, canSpeak: false });
  expect(meeting.getParticipants()).toEqual([{ id: "grace", name: "Grace" }]);
});

test("meeting manager creates dynamic targets idempotently and removes ended sessions", async () => {
  const targets: string[] = [];
  const manager = createMeetingManager({
    source: ({ target }) => {
      targets.push(target);
      return createBufferMeetingSource({
        chunkMs: 1,
        format,
        pcm: new Uint8Array(),
      });
    },
    stt: silentStt,
  });

  const first = manager.start({
    sessionId: "managed-meeting",
    target: "https://meet.example/one",
  });
  const retry = manager.start({
    sessionId: "managed-meeting",
    target: "https://meet.example/one",
  });
  expect(await first).toBe(await retry);
  expect(targets).toEqual(["https://meet.example/one"]);

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(manager.list()).toEqual([]);
});

test("meeting manager rejects one session identity being rebound to another target", async () => {
  let releaseStart: (() => void) | undefined;
  const manager = createMeetingManager({
    source: async () => {
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return createBufferMeetingSource({
        chunkMs: 1,
        format,
        pcm: new Uint8Array(),
      });
    },
    stt: silentStt,
  });

  const first = manager.start({ sessionId: "same-id", target: "target-one" });
  await Promise.resolve();
  await expect(
    manager.start({ sessionId: "same-id", target: "target-two" }),
  ).rejects.toThrow("different target");
  releaseStart?.();
  await first;
});

async function transcriptionFixture() {
  type Handler = (payload: any) => void;
  const handlers = new Map<string, Set<Handler>>();
  const emit = (name: string, payload: unknown) => {
    for (const h of handlers.get(name) ?? []) h(payload);
  };
  const channels: {
    send: (text: string) => void;
    frames: number[];
    endTurn: () => void;
    closed: boolean;
  }[] = [];
  const source = {
    format,
    on: (name: string, handler: Handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return () => {
        handlers.get(name)!.delete(handler);
      };
    },
    start: async () => {},
    stop: async () => {
      emit("end", { reason: "stopped" });
    },
  };
  const stt: STTAdapter = {
    kind: "stt",
    open: () => {
      const listeners = new Map<string, Handler[]>();
      const fire = (name: string, payload: unknown) => {
        for (const h of listeners.get(name) ?? []) h(payload);
      };
      const channel = {
        closed: false,
        frames: [] as number[],
        send: (text: string) =>
          fire("final", {
            type: "final",
            receivedAt: 0,
            transcript: {
              id: crypto.randomUUID(),
              isFinal: true,
              text,
              speaker: "0",
              startedAtMs: 0,
              endedAtMs: 100,
            },
          }),
        endTurn: () =>
          fire("endOfTurn", {
            type: "endOfTurn",
            reason: "vendor",
            receivedAt: 0,
          }),
      };
      channels.push(channel);
      return {
        on: (name: string, handler: Handler) => {
          listeners.set(name, [...(listeners.get(name) ?? []), handler]);
          return () => {};
        },
        send: async (chunk: ArrayBufferView) => {
          channel.frames.push(
            new Uint8Array(
              chunk.buffer,
              chunk.byteOffset,
              chunk.byteLength,
            )[0]!,
          );
        },
        close: async () => {
          channel.closed = true;
        },
      };
    },
  } as unknown as STTAdapter;
  const meeting = await createMeeting({
    sessionId: "m",
    source: source as never,
    stt,
  });
  return { meeting, emit, channels };
}

test("separate speakers keep separate PCM, delayed transcripts and utterance boundaries", async () => {
  const f = await transcriptionFixture();
  expect(f.channels).toHaveLength(0); // No STT connection while waiting for admission.
  f.emit("participant", { participant: { id: "ada", name: "Ada" } });
  f.emit("participant", { participant: { id: "ray", name: "Ray" } });
  f.emit("audio", { participant: "ada", chunk: new Uint8Array(32000).fill(1) });
  f.emit("audio", { participant: "ray", chunk: new Uint8Array(32000).fill(2) });
  f.emit("audio", { participant: "ada", chunk: new Uint8Array(32000).fill(3) });
  await Bun.sleep(5);
  expect(f.channels).toHaveLength(2);
  expect(f.channels.map((c) => c.frames)).toEqual([[1, 3], [2]]);
  expect(f.meeting.getTranscriptionSeconds()).toBe(3);
  const utterances: string[][] = [];
  f.meeting.on("endOfTurn", ({ turns }) =>
    utterances.push(turns.map((t) => `${t.participant?.name}: ${t.text}`)),
  );
  f.channels[0]!.send("So instead");
  f.channels[1]!.send("AI");
  f.channels[0]!.send("of your proposal");
  f.channels[1]!.endTurn();
  f.channels[0]!.endTurn();
  expect(utterances).toEqual([
    ["Ray: AI"],
    ["Ada: So instead", "Ada: of your proposal"],
  ]);
  expect(f.meeting.getTranscript().map((t) => t.participant?.name)).toEqual([
    "Ada",
    "Ray",
    "Ada",
  ]);
  let ended = 0;
  f.meeting.on("end", () => {
    ended++;
  });
  await Promise.all([f.meeting.stop(), f.meeting.stop()]);
  expect(ended).toBe(1);
  expect(f.channels.every((c) => c.closed)).toBe(true);
  f.channels[0]!.send("late");
  f.emit("audio", { participant: "ada", chunk: new Uint8Array([4]) });
  expect(f.meeting.getTranscript()).toHaveLength(3);
});

test("unattributed audio never inherits a named speaker from another channel", async () => {
  const f = await transcriptionFixture();
  f.emit("participant", { participant: { id: "ada", name: "Ada" } });
  f.emit("audio", { participant: "ada", chunk: new Uint8Array([1, 0]) });
  f.emit("audio", { chunk: new Uint8Array([2, 0]) });
  await Bun.sleep(5);
  f.channels[1]!.send("Unknown speaker");
  expect(f.meeting.getTranscript()[0]!.participant).toBeUndefined();
  await f.meeting.stop();
});
