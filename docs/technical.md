# Technical map — flowvoice-engine (voice runtime)

Node.js/TypeScript engine that holds live phone calls open and bridges
Twilio audio, OpenAI's Realtime API, and the `flowvoice` dashboard's API.
This file maps each file under `src/` to its purpose, main exports, and
dependencies. Business purpose, database schema, and the full cross-system
call flow live in the `flowvoice` repo — see
https://github.com/tomasmarekcz/flowvoice/blob/main/docs/architecture.md

Maintained incrementally by the `update-docs` skill — each section below
corresponds to one source file and is only rewritten when that file
changes.

## index.ts

**Purpose:** Entry point. Boots an Express app with a `/health` check and
the Twilio webhook routes, then a raw `http` server with a `WebSocketServer`
that manually routes upgrade requests by path (`/ws/twilio` vs
`/ws/browser`) to the two connection handlers.

**Main exports:** `app`, `server` (for tests).

**Depends on:** `handlers/twilio.ts` (`handleTwilioVoiceWebhook`,
`handleRecordingStatusCallback`, `handleTwilioConnection`),
`handlers/browser.ts` (`handleBrowserConnection`), `logger.ts`.

**Depended on by:** nothing (process entry point, started via `npm start`/Docker).

## config.ts

**Purpose:** Supabase REST access helpers and the `AssistantSettings` type
— the shape of a project's live assistant configuration as loaded at the
start of a call, including fields joined in from `projects` (business
name/industry/description/website/language, owner phone/email),
`calendars` (`_calendar_project_id`), and `event_types`
(`_service_names`, active service names for the prompt). Fields prefixed
`_` are joined/derived, not columns on `assistant_settings` itself.

**Main exports:** `getSupabaseUrl()`, `getSupabaseHeaders()`,
`loadAssistantSettings(projectId)`, `AssistantSettings` (interface).

**Depends on:** `logger.ts`; talks directly to the Supabase REST API
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars) — no ORM.

**Depended on by:** `session.ts` (loads settings at call start),
`handlers/twilio.ts` and `call-logger.ts` (Supabase URL/headers for direct
writes), `prompt.ts` (consumes `AssistantSettings` to build the prompt).

## session.ts

**Purpose:** `CallSession` — the core per-call state machine. Loads
assistant settings, opens the OpenAI Realtime WebSocket, sends the
`session.update` with instructions/tools/voice, relays audio and events
between the transport (Twilio or browser) and OpenAI via callbacks,
dispatches tool calls, and on call end generates the summary, sends SMS,
and (if enabled) triggers the owner email notification.

**Main exports:** `CallSession` (class: `start()`, `handleClientAudio()`,
`handleClientEvent()`, `end()`), `SessionCallbacks` (interface:
`sendAudio`, `sendJson`, `endCall`).

**Depends on:** `call-logger.ts` (`CallLogger`, `generateCallSummary`,
`SmsOptions`), `config.ts` (`loadAssistantSettings`, `AssistantSettings`),
`prompt.ts` (`buildPromptFromSettings`, `buildTools`), `tools.ts`
(`executeTool`), `sms.ts` (`sendSmsNotifications`), `logger.ts`.

**Depended on by:** `handlers/twilio.ts` and `handlers/browser.ts` (both
construct a `CallSession` per connection).

## tools.ts

**Purpose:** `executeTool()` — dispatches a named tool call (as requested
by the OpenAI Realtime model) to the corresponding `flowvoice` dashboard
API route over HTTP (`FRONTEND_API_URL`, defaults to
`http://localhost:3000`). Handles `get_available_slots`, `get_services`,
`get_resources`, `get_day_availability`, `web_search`,
`create_calendar_event` (including decoding a `slot_id` fallback into
`start_time`/`end_time`), and `create_enquiry`. `end_call` is handled
entirely inside `session.ts`, not here.

**Main exports:** `executeTool(name, args, projectId, calendarProjectId, dbCallId?)`.

**Depends on:** `logger.ts`; HTTP calls into the `flowvoice` dashboard's
`/api/calendar/slots`, `/api/services`, `/api/resources`,
`/api/calendar/windows`, `/api/web-search`, `/api/calendar/events`,
`/api/enquiries` routes (see that repo's `docs/technical.md`).

**Depended on by:** `session.ts` (`executeToolCall`).

## prompt.ts

**Purpose:** Builds the actual instructions string sent to OpenAI for a
call, from three layers: a hardcoded universal base prompt (identical for
every business, never editable), a business-context block built from the
loaded `AssistantSettings` (name, industry, description, website,
language, active service names, today's date), and (further down the
file) a tools preamble plus per-capability tool schemas. Also computes
`getTodayLabel()` in the `Europe/Prague` timezone so the model always
knows the current date.

**Main exports:** `buildPromptFromSettings(settings)`, `buildTools(settings)`,
`OpenAITool` (interface).

**Depends on:** `config.ts` (`AssistantSettings` type only).

**Depended on by:** `session.ts` (`start()`, to build `instructions` and
`tools` for the `session.update` message).

## call-logger.ts

**Purpose:** `CallLogger` — writes the `calls` row for a call to Supabase
directly (via REST, not through the dashboard API) at call start
(`createCall`), accumulates the transcript and tool-call log as OpenAI/
client events arrive, and exposes `generateCallSummary()` to produce the
post-call title/summary/SMS/email text via GPT once the call ends.

**Main exports:** `CallLogger` (class: `createCall()`,
`handleOpenAIEvent()`, `handleClientEvent()`, `finalizeCall()`,
`callId`, `transcript`, `callDurationSeconds`), `generateCallSummary()`,
`SmsOptions`, `TranscriptEntry`.

**Depends on:** `config.ts` (`getSupabaseUrl`, `getSupabaseHeaders`),
`logger.ts`.

**Depended on by:** `session.ts` (owns one `CallLogger` per call).

## sms.ts

**Purpose:** Sends SMS notifications (to the business owner and/or the
caller) via the Twilio REST API directly (Basic Auth with
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`), independent of the
Twilio Voice/SIP call path itself.

**Main exports:** `sendSmsNotifications(targets)`, `SmsTargets` (interface).

**Depends on:** `logger.ts`; calls `api.twilio.com` directly.

**Depended on by:** `session.ts` (`end()`, after generating the call summary).

## audio.ts

**Purpose:** Pure audio codec/resampling functions bridging Twilio's
8kHz μ-law format and OpenAI Realtime's 24kHz PCM16 format — no I/O, no
side effects. Includes μ-law encode/decode, naive linear-interpolation
resampling (3× up/down, since 8kHz × 3 = 24kHz exactly), and the two
end-to-end pipeline functions used elsewhere.

**Main exports:** `twilioAudioToOpenAI(mulawB64)`,
`openAIAudioToTwilio(pcm24B64)` (the two pipelines actually used by
callers), plus the lower-level `mulawToLinear`, `linearToMulaw`,
`upsample8kTo24k`, `downsample24kTo8k`, `pcm8kToFloat32`,
`float32ToPcm8k`, `pcm24kToBase64`, `base64ToPcm24k`.

**Depends on:** nothing.

**Depended on by:** `handlers/twilio.ts` (both pipeline functions, per
audio frame in each direction).

## logger.ts

**Purpose:** Structured logger, same shape/behavior as the dashboard's
`src/lib/logger.ts` (independent copy, not a shared package): JSON lines
in production, colored console output otherwise; redacts long strings and
normalizes `err`/`error` fields (including a short stack trace) into a
plain message. `minLevel()` is `info` in production, `debug` otherwise.

**Main exports:** `logger` (`debug`/`info`/`warn`/`error`).

**Depends on:** nothing.

**Depended on by:** every other file in `src/`.

## handlers/twilio.ts

**Purpose:** Express handler for the Twilio Voice webhook
(`handleTwilioVoiceWebhook` — validates the Twilio signature unless
`TWILIO_SKIP_VALIDATION=true`, extracts the caller's phone number from the
SIP `From` header, and returns TwiML that starts call recording and opens
a Media Stream WebSocket back to this engine with `project_id`/
`caller_phone`/`call_sid` as stream parameters), the recording-status
callback (`handleRecordingStatusCallback` — patches the `calls` row with
the final recording URL once Twilio finishes processing it), and the
Media Stream WebSocket handler itself (`handleTwilioConnection` — parses
`start`/`media`/`stop` frames, creates a `CallSession` on `start`, feeds
audio through `audio.ts`'s codec functions, and ends the session on
`stop`/close).

**Main exports:** `handleTwilioVoiceWebhook`, `handleRecordingStatusCallback`,
`handleTwilioConnection`.

**Depends on:** `session.ts` (`CallSession`), `logger.ts`, `audio.ts`
(`twilioAudioToOpenAI`, `openAIAudioToTwilio`), `config.ts`
(`getSupabaseUrl`, `getSupabaseHeaders`), the `twilio` npm package (request
signature validation only).

**Depended on by:** `index.ts` (registers these as the `/twilio/voice`,
`/twilio/recording-status`, and `/ws/twilio` handlers).

## handlers/browser.ts

**Purpose:** WebSocket handler for the dashboard's `test-call` page (an
internal harness to exercise a call without a real phone call) — same
`CallSession` wiring as the Twilio handler, but audio is exchanged as raw
PCM24 JSON messages instead of Twilio's μ-law media-stream format, so no
`audio.ts` codec conversion is needed here.

**Main exports:** `handleBrowserConnection`.

**Depends on:** `session.ts` (`CallSession`), `logger.ts`.

**Depended on by:** `index.ts` (registers this as the `/ws/browser` handler).
