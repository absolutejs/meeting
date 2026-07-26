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
