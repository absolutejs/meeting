import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { BufferMeetingSourceOptions } from "./bufferSource";
import type { CreateMeetingOptions, MeetingSession } from "./meeting";

const tool = toolFactory<MeetingSession>();

const MAX_TRANSCRIPT_TURNS = 200;
const DEFAULT_TRANSCRIPT_TURNS = 50;
const MAX_CHAT_LENGTH = 2000;

/* Serializable subset of CreateMeetingOptions: languageStrategy and
 * phraseHints only. `source` and `stt` are instance-valued → slots;
 * `sessionId` is per-meeting → generated in the wiring; `lexicon` carries
 * metadata records → left to code. */
export const manifest = defineManifest<CreateMeetingOptions, MeetingSession>()({
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
      contract: "meeting/source",
      factory: "createBufferMeetingSource",
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
          "createBufferMeetingSource({",
          "\tchunkMs: ${settings.chunkMs},",
          "\tformat: { channels: 1, container: 'raw', encoding: 'pcm_s16le', sampleRateHz: 16000 },",
          "\t// TODO: supply raw PCM matching `format` (e.g. a recorded test fixture).",
          "\tpcm: new Uint8Array(0)",
          "})",
        ].join("\n"),
        imports: [
          { from: "@absolutejs/meeting", names: ["createBufferMeetingSource"] },
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
      contract: "meeting/source",
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
    leave_meeting: tool.runtime({
      annotations: { destructiveHint: true, idempotentHint: true },
      authorization: {
        approval: "policy",
        audience: "owner",
        destinations: ["configured-meeting-platform"],
        effects: ["write", "send", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["meeting:leave"],
        resource: { type: "active-meeting" },
        reversible: false,
      },
      description:
        "Make the bot leave the call, finalize the transcript, and end the session.",
      handler: async ({ reason }, meeting) => {
        await meeting.stop(reason);

        return "left the meeting";
      },
      input: Type.Object({ reason: Type.Optional(Type.String()) }),
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
      handler: (_input, meeting) =>
        JSON.stringify(
          meeting.getParticipants().map((participant) => ({
            id: participant.id,
            name: participant.name ?? null,
            platform: participant.platform ?? null,
          })),
        ),
      input: Type.Object({}),
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
      handler: ({ limit }, meeting) => {
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
      }),
    }),
    send_chat_message: tool.runtime({
      annotations: { openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "owner",
        destinations: ["configured-meeting-platform"],
        effects: ["send", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["meeting:chat:send"],
        resource: { type: "active-meeting" },
        reversible: false,
      },
      description:
        "Post a text message into the call chat as the bot. Fails cleanly when the platform adapter can't write chat (check first: not every source supports it).",
      handler: async ({ text }, meeting) => {
        if (!meeting.capabilities.canChat) {
          return "this meeting's platform adapter can't post to the call chat";
        }
        await meeting.sendChat(text);

        return "chat message sent";
      },
      input: Type.Object({
        text: Type.String({ maxLength: MAX_CHAT_LENGTH, minLength: 1 }),
      }),
    }),
  },
  wiring: [
    {
      description:
        "The bot joins the call via the source adapter; the scribe streams back diarized turns and the final transcript.",
      id: "default",
      server: {
        code: [
          "const meeting = await createMeeting({",
          "\tlanguageStrategy: ${settings.languageStrategy},",
          "\tphraseHints: ${settings.phraseHints},",
          "\tsessionId: crypto.randomUUID(),",
          "\tsource: ${slot.source},",
          "\tstt: ${slot.stt}",
          "});",
          "",
          "meeting.on('turn', ({ turn }) => {",
          "\t// TODO: stream diarized turns to your analyzer / UI.",
          "});",
          "meeting.on('end', ({ transcript }) => {",
          "\t// TODO: persist or analyze the full transcript.",
          "});",
          "",
          "await meeting.start(); // the bot joins the call",
        ].join("\n"),
        imports: [{ from: "@absolutejs/meeting", names: ["createMeeting"] }],
        placement: "module-scope",
      },
      title: "Join a call and transcribe it live",
    },
  ],
});
