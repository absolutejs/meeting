import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { BufferMeetingSourceOptions } from "./bufferSource";
import type { MeetingManager, MeetingManagerOptions } from "./manager";

const tool = toolFactory<MeetingManager>();

const MAX_TRANSCRIPT_TURNS = 200;
const DEFAULT_TRANSCRIPT_TURNS = 50;
const MAX_CHAT_LENGTH = 2000;

/* Serializable subset of MeetingManagerOptions: languageStrategy and
 * phraseHints only. `source` and `stt` are instance-valued → slots;
 * session identity + target are supplied to the governed start action;
 * `lexicon` carries
 * metadata records → left to code. */
export const manifest = defineManifest<MeetingManagerOptions, MeetingManager>()(
  {
    contract: 2,
    identity: {
      accent: "#f97316",
      category: "voice",
      description:
        "Meeting-bot core: join a call through a `MeetingSource` platform adapter (`@absolutejs/meeting-*`), transcribe it live with the `@absolutejs/voice` scribe, and surface diarized turns, the participant roster, and call chat for analysis (deal coaching, summaries, action items). The bot can also speak into the call and post chat where the platform allows.",
      docsUrl: "https://github.com/absolutejs/meeting",
      name: "@absolutejs/meeting",
      tagline: "Put a bot in your meetings — live transcripts and analysis.",
    },
    implements: [
      defineImplementation<BufferMeetingSourceOptions>()({
        contract: "meeting/source-factory",
        factory: "createBufferMeetingSourceFactory",
        from: "@absolutejs/meeting",
        settings: Type.Object({
          chunkMs: Type.Optional(
            Type.Number({
              description:
                "How often a slice of the buffer is emitted, in milliseconds. Default 40.",
              minimum: 1,
              title: "Chunk cadence",
            }),
          ),
        }),
        title: "In-memory audio buffer (testing without a live platform)",
        wiring: {
          code: [
            "createBufferMeetingSourceFactory({",
            "\tchunkMs: ${settings.chunkMs},",
            "\tformat: { channels: 1, container: 'raw', encoding: 'pcm_s16le', sampleRateHz: 16000 },",
            "\t// TODO: supply raw PCM matching `format` (e.g. a recorded test fixture).",
            "\tpcm: new Uint8Array(0)",
            "})",
          ].join("\n"),
          imports: [
            {
              from: "@absolutejs/meeting",
              names: ["createBufferMeetingSourceFactory"],
            },
          ],
        },
      }),
    ],
    settings: Type.Object({
      languageStrategy: Type.Optional(
        Type.Union(
          [
            Type.Object({
              allowedLanguages: Type.Optional(Type.Array(Type.String())),
              mode: Type.Literal("auto-detect"),
            }),
            Type.Object({
              mode: Type.Literal("fixed"),
              primaryLanguage: Type.String(),
              secondaryLanguages: Type.Optional(Type.Array(Type.String())),
            }),
            Type.Object({
              mode: Type.Literal("allow-switching"),
              primaryLanguage: Type.Optional(Type.String()),
              secondaryLanguages: Type.Array(Type.String()),
            }),
          ],
          {
            description:
              "What languages the calls are in. Auto-detect works for most teams; pin a language for better accuracy in single-language calls.",
            title: "Meeting languages",
          },
        ),
      ),
      phraseHints: Type.Optional(
        Type.Array(
          Type.Object({
            aliases: Type.Optional(Type.Array(Type.String())),
            boost: Type.Optional(Type.Number()),
            text: Type.String(),
          }),
          {
            description:
              "Names, products, and jargon the transcriber should recognize — improves accuracy on words unique to your business.",
            title: "Vocabulary hints",
          },
        ),
      ),
    }),
    slots: {
      source: {
        configPath: "source",
        contract: "meeting/source-factory",
        description: "The platform the bot joins calls on",
        known: [
          "@absolutejs/meeting-recall",
          "@absolutejs/meeting-discord",
          "@absolutejs/meeting#buffer",
        ],
        required: true,
      },
      stt: {
        configPath: "stt",
        contract: "voice/stt",
        description: "Who turns the call audio into text",
        known: ["@absolutejs/voice-deepgram"],
        required: true,
      },
    },
    tools: {
      join_meeting: tool.runtime({
        annotations: { idempotentHint: true, openWorldHint: true },
        authorization: {
          approval: "policy",
          audience: "owner",
          destinations: ["configured-meeting-platform"],
          effects: ["write", "external-network"],
          idempotency: { mode: "resource" },
          requiredScopes: ["meeting:join"],
          resource: { idField: "sessionId", type: "active-meeting" },
          reversible: false,
        },
        description:
          "Join one call through the configured platform adapter. The target is adapter-defined: a Meet/Zoom/Teams URL for Recall or a voice-channel id for Discord.",
        handler: async ({ sessionId, target }, meetings) => {
          await meetings.start({ sessionId, target });

          return `joined meeting ${sessionId}`;
        },
        input: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          target: Type.String({ maxLength: 2048, minLength: 1 }),
        }),
      }),
      leave_meeting: tool.runtime({
        annotations: { destructiveHint: true, idempotentHint: true },
        authorization: {
          approval: "policy",
          audience: "owner",
          destinations: ["configured-meeting-platform"],
          effects: ["write", "send", "external-network"],
          idempotency: { mode: "resource" },
          requiredScopes: ["meeting:leave"],
          resource: { idField: "sessionId", type: "active-meeting" },
          reversible: false,
        },
        description:
          "Make the bot leave the call, finalize the transcript, and end the session.",
        handler: async ({ reason, sessionId }, meetings) => {
          const stopped = await meetings.stop(sessionId, reason);

          return stopped ? "left the meeting" : "meeting is not active";
        },
        input: Type.Object({
          reason: Type.Optional(Type.String()),
          sessionId: Type.String({ minLength: 1 }),
        }),
      }),
      active_meetings: tool.runtime({
        annotations: { readOnlyHint: true },
        authorization: {
          approval: "never",
          audience: "owner",
          effects: ["read"],
          requiredScopes: ["meeting:read"],
        },
        description: "List active meeting session identities and targets.",
        handler: (_input, meetings) =>
          JSON.stringify(
            meetings.list().map(({ sessionId, target }) => ({
              sessionId,
              target,
            })),
          ),
        input: Type.Object({}),
      }),
      meeting_participants: tool.runtime({
        annotations: { readOnlyHint: true },
        authorization: {
          approval: "never",
          audience: "owner",
          effects: ["read"],
          requiredScopes: ["meeting:read"],
        },
        description:
          "List the participants the call platform has reported for this meeting.",
        handler: ({ sessionId }, meetings) => {
          const meeting = meetings.get(sessionId);
          if (meeting === undefined) return "meeting is not active";

          return JSON.stringify(
            meeting.getParticipants().map((participant) => ({
              id: participant.id,
              name: participant.name ?? null,
              platform: participant.platform ?? null,
            })),
          );
        },
        input: Type.Object({ sessionId: Type.String({ minLength: 1 }) }),
      }),
      meeting_transcript: tool.runtime({
        annotations: { readOnlyHint: true },
        authorization: {
          approval: "never",
          audience: "owner",
          effects: ["read"],
          requiredScopes: ["meeting:read"],
        },
        description:
          "Read the diarized transcript so far — the most recent turns, each with its speaker and (when known) the resolved participant.",
        handler: ({ limit, sessionId }, meetings) => {
          const meeting = meetings.get(sessionId);
          if (meeting === undefined) return "meeting is not active";
          const turns = meeting.getTranscript();

          return JSON.stringify(
            turns.slice(-(limit ?? DEFAULT_TRANSCRIPT_TURNS)).map((turn) => ({
              participant: turn.participant?.name ?? null,
              speaker: turn.speaker,
              text: turn.text,
            })),
          );
        },
        input: Type.Object({
          limit: Type.Optional(
            Type.Integer({
              default: DEFAULT_TRANSCRIPT_TURNS,
              maximum: MAX_TRANSCRIPT_TURNS,
              minimum: 1,
            }),
          ),
          sessionId: Type.String({ minLength: 1 }),
        }),
      }),
      send_chat_message: tool.runtime({
        annotations: { openWorldHint: true },
        authorization: {
          approval: "policy",
          audience: "owner",
          destinations: ["configured-meeting-platform"],
          effects: ["send", "external-network"],
          idempotency: { mode: "resource" },
          requiredScopes: ["meeting:chat:send"],
          resource: { idField: "sessionId", type: "active-meeting" },
          reversible: false,
        },
        description:
          "Post a text message into the call chat as the bot. Fails cleanly when the platform adapter can't write chat (check first: not every source supports it).",
        handler: async ({ sessionId, text }, meetings) => {
          const meeting = meetings.get(sessionId);
          if (meeting === undefined) return "meeting is not active";
          if (!meeting.capabilities.canChat) {
            return "this meeting's platform adapter can't post to the call chat";
          }
          await meeting.sendChat(text);

          return "chat message sent";
        },
        input: Type.Object({
          sessionId: Type.String({ minLength: 1 }),
          text: Type.String({ maxLength: MAX_CHAT_LENGTH, minLength: 1 }),
        }),
      }),
    },
    wiring: [
      {
        description:
          "Create a multi-session meeting manager. Joining a specific call is an explicit governed action, so installation never contacts a meeting platform.",
        id: "default",
        server: {
          code: [
            "const meetings = createMeetingManager({",
            "\tlanguageStrategy: ${settings.languageStrategy},",
            "\tphraseHints: ${settings.phraseHints},",
            "\tsource: ${slot.source},",
            "\tstt: ${slot.stt}",
            "});",
          ].join("\n"),
          imports: [
            { from: "@absolutejs/meeting", names: ["createMeetingManager"] },
          ],
          placement: "module-scope",
        },
        title: "Create the meeting manager",
      },
    ],
  },
);
