# @absolutejs/meeting

Meeting-bot core for AbsoluteJS. Join a call through a **source adapter**,
transcribe it live with the [`@absolutejs/voice`](https://github.com/absolutejs/voice)
scribe, and surface **diarized turns + participants** for analysis (deal
coaching, summaries, action items, …).

Platform-agnostic: the core only depends on the small `MeetingSource` contract,
so each platform is a separate adapter under
[`meeting-adapters`](https://github.com/absolutejs/meeting-adapters) (mirrors
`voice-adapters`):

- `@absolutejs/meeting-recall` — Recall.ai (Meet / Zoom / Teams)
- `@absolutejs/meeting-discord` — native `@discordjs/voice` receive

## Usage

```ts
import { createMeeting } from "@absolutejs/meeting";
import { deepgram } from "@absolutejs/voice-deepgram";
import { createRecallMeetingSource } from "@absolutejs/meeting-recall";

const meeting = await createMeeting({
  source: createRecallMeetingSource({
    apiKey: process.env.RECALL_API_KEY!,
    meetingUrl,
    websocketUrl: process.env.RECALL_WEBSOCKET_URL!,
  }),
  stt: deepgram({ apiKey: process.env.DEEPGRAM_API_KEY!, diarize: true }),
  sessionId: "deal-123",
});

meeting.on("turn", ({ turn }) => {
  // { speaker, text, participant? } — stream to your analyzer / UI
});
meeting.on("end", ({ transcript }) => {
  // full diarized transcript — run your deal-call analysis
});

await meeting.start(); // bot joins the call
// ... later: await meeting.stop()
```

For an application that joins dynamic calls, bind provider configuration once
and use the multi-session manager. Installation itself never contacts a meeting
platform:

```ts
import { createMeetingManager } from "@absolutejs/meeting";
import { createRecallMeetingSourceFactory } from "@absolutejs/meeting-recall";

const meetings = createMeetingManager({
  source: createRecallMeetingSourceFactory({
    apiKey: process.env.RECALL_API_KEY!,
    websocketUrl: "wss://app.example.com/meeting/audio",
  }),
  stt: deepgram({ apiKey: process.env.DEEPGRAM_API_KEY!, diarize: true }),
});

await meetings.start({
  sessionId: "deal-123",
  target: "https://meet.google.com/abc-defg-hij",
});
```

### Testing without a platform

`createBufferMeetingSource` streams an in-memory PCM buffer in real time — the
reference `MeetingSource` implementation and a test harness.

## API

- `createMeeting(options)` → `MeetingSession` (`on`, `start`, `stop`,
  `getTranscript`, `getParticipants`).
- `createMeetingManager(options)` → dynamic, idempotent multi-session host
  boundary (`start`, `stop`, `get`, `list`).
- `createBufferMeetingSource(options)` → `MeetingSource`.
- Types: `MeetingSource`, `MeetingSourceEventMap`, `MeetingParticipant`,
  `MeetingSession`, `MeetingTurn`, `CreateMeetingOptions`.

## License

Business Source License 1.1 — production use is free except offering the package as a competing hosted service (see the Additional Use Grant in [LICENSE](./LICENSE)). Converts to Apache 2.0 on May 29, 2030.
