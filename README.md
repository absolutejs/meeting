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
import { recall } from "@absolutejs/meeting-recall";

const meeting = await createMeeting({
  source: recall({ apiKey: process.env.RECALL_API_KEY!, meetingUrl }),
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

### Testing without a platform

`createBufferMeetingSource` streams an in-memory PCM buffer in real time — the
reference `MeetingSource` implementation and a test harness.

## API

- `createMeeting(options)` → `MeetingSession` (`on`, `start`, `stop`,
  `getTranscript`, `getParticipants`).
- `createBufferMeetingSource(options)` → `MeetingSource`.
- Types: `MeetingSource`, `MeetingSourceEventMap`, `MeetingParticipant`,
  `MeetingSession`, `MeetingTurn`, `CreateMeetingOptions`.

## License

CC BY-NC 4.0
