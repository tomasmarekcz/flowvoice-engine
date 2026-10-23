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
(`_service_names`, active service names for the prompt). Also includes
`greeting_enabled` / `greeting_message` for the optional opening greeting
feature and `knowledge_top_n` (number | null) for how many Qdrant chunks
are returned per `search_knowledge` call (defaults to 5 if null), and
`voice_engine` (`"standard"` | `"live"`, optional — a missing value means
Standard) which selects the voice engine in `session-factory.ts`. Fields
prefixed `_` are joined/derived, not columns on `assistant_settings` itself.

**Main exports:** `getSupabaseUrl()`, `getSupabaseHeaders()`,
`loadAssistantSettings(projectId)`, `AssistantSettings` (interface).

**Depends on:** `logger.ts`; talks directly to the Supabase REST API
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars) — no ORM.

**Depended on by:** `session.ts` (loads settings at call start),
`handlers/twilio.ts` and `call-logger.ts` (Supabase URL/headers for direct
writes), `prompt.ts` (consumes `AssistantSettings` to build the prompt).

## knowledge.ts

**Purpose:** `searchKnowledge()` — embeds a natural-language query using
OpenAI `text-embedding-3-small`, then searches the Qdrant `documents`
collection filtered by `project_id`, and returns the top-N chunks plus
the number of embedding tokens consumed. Called during live calls by
`tools.ts` when the `search_knowledge` tool fires.

**Main exports:** `searchKnowledge(query, projectId, topN)` →
`Promise<KnowledgeSearchResult>`, `KnowledgeChunk` (interface: `{ text,
filename, score }`), `KnowledgeSearchResult` (interface: `{ chunks:
KnowledgeChunk[]; embeddingTokens: number }`).

**Depends on:** `@qdrant/js-client-rest` (`QDRANT_URL`,
`QDRANT_API_KEY` env vars), `openai` (`OPENAI_API_KEY`).

**Depended on by:** `tools.ts` (`search_knowledge` handler).

## session.ts

**Purpose:** `CallSession` — the core per-call state machine. Loads
assistant settings, opens the OpenAI Realtime WebSocket, sends the
`session.update` with instructions/tools/voice, relays audio and events
between the transport (Twilio or browser) and OpenAI via callbacks,
dispatches tool calls, and on call end generates the summary, sends SMS,
and (if enabled) triggers the owner email notification. When
`greeting_enabled` is true, fires `response.create` on the
`session.updated` event so the assistant speaks first at call start.
Passes `settings.knowledge_top_n` (defaulting to 5) to `executeTool` so
the `search_knowledge` handler knows how many Qdrant chunks to return.
Accumulates per-call token usage in a private `usageAccum` field: listens
to `response.done` events for `input_token_details` / `output_token_details`
(audio and text tokens from the Realtime API) and adds `embeddingTokens`
returned by each `executeTool` call; passes the assembled `TokenUsage`
object to `finalizeCall()` at call end.

This is the **Standard** voice engine (`gpt-realtime-2`, PCM 24 kHz). It
implements `VoiceSession` (`audioFormat` is `"pcm24"`). The optional fifth
constructor argument `preloadedSettings` lets `session-factory.ts` pass in
settings it already loaded; when it is not `undefined` (`null` counts),
`start()` does not load them again.

**Main exports:** `CallSession` (class: `start()`, `handleClientAudio()`,
`handleClientEvent()`, `handleTwilioMark()`, `end()`), `formatOwnerSms`
(shared with `live-session.ts`), `SessionCallbacks` (re-exported type from
`session-types.ts`).

**Depends on:** `call-logger.ts` (`CallLogger`, `generateCallSummary`,
`SmsOptions`), `config.ts` (`loadAssistantSettings`, `AssistantSettings`),
`prompt.ts` (`buildPromptFromSettings`, `buildTools`), `tools.ts`
(`executeTool`), `sms.ts` (`sendSmsNotifications`), `session-types.ts`,
`logger.ts`.

**Depended on by:** `session-factory.ts` (Twilio calls) and
`handlers/browser.ts` (the browser test call always uses this engine),
`live-session.ts` (`formatOwnerSms`).

## session-types.ts

**Purpose:** Shared types for the two voice engines. `AudioFormat`
(`"pcm24"` for Standard, `"mulaw8"` for Live), `SessionCallbacks`
(`sendAudio(audio, format?)` where an omitted `format` means PCM 24 kHz,
`sendJson`, `sendMark`, `endCall`) and `VoiceSession` (the surface the
Twilio handler uses: `audioFormat`, `start()`, `handleClientAudio()`,
`handleTwilioMark()`, `end()`).

**Main exports:** `AudioFormat`, `SessionCallbacks`, `VoiceSession`.

**Depended on by:** `session.ts`, `live-session.ts`, `session-factory.ts`,
`handlers/twilio.ts`.

## session-factory.ts

**Purpose:** `startCallSession()` — loads the assistant settings once and
returns an already-started session: `LiveCallSession` when
`settings.voice_engine === "live"`, otherwise `CallSession` (given the
loaded settings). If the Live session fails to start (socket error, close
before `session.started`, or start timeout) it is aborted and the call is
answered by `CallSession` instead, so a caller never hears silence.

**Main exports:** `startCallSession(projectId, callerPhone, twilioCallSid, callbacks)`.

**Depends on:** `config.ts`, `session.ts`, `live-session.ts`,
`session-types.ts`, `logger.ts`.

**Depended on by:** `handlers/twilio.ts`.

## live-protocol.ts

**Purpose:** Pure helpers for the GPT-Live (`gpt-live-1`) wire protocol, so
the message shapes are tested in one place: `buildLiveSessionStart()` (the
`session.start` message — 8 kHz mu-law audio, a short conversation prompt for
the voice model, and Responses delegation carrying the business prompt without
the greeting rule, the tools from `buildTools()`, `parallel_tool_calls: false`
and, when `end_call` is enabled, a rule telling the backend to call it in the
same turn as its closing sentence), `buildLiveGreetingInstruction()`,
`extractFunctionCall()` (parses `response.event` → `response.output_item.done`),
`buildToolResultMessages()` (`response.item.create` plus optional
`response.create`), `pickLiveVoice()` and `TranscriptAccumulator` (merges
transcript deltas into per-speaker utterances). Model names come from
`LIVE_MODEL` (default `gpt-live-1`) and `LIVE_BACKEND_MODEL` (default
`gpt-5.6-luna`).

**Main exports:** `LIVE_ENDPOINT`, `LIVE_VOICES`, `LIVE_CONVERSATION_PROMPT`,
`liveModel`, `liveBackendModel`, `pickLiveVoice`, `buildLiveGreetingInstruction`,
`buildLiveSessionStart`, `extractFunctionCall`, `buildToolResultMessages`,
`TranscriptAccumulator`.

**Depends on:** `prompt.ts`, `config.ts` (type), `call-logger.ts` (type).

**Depended on by:** `live-session.ts`.

## live-session.ts

**Purpose:** `LiveCallSession` — the **Natural (Beta)** voice engine
(`gpt-live-1`, G.711 mu-law 8 kHz, so Twilio audio passes through without
transcoding). Connects to `wss://api.openai.com/v1/live/sessions`; `start()`
resolves after `session.started` (rejects on socket error/close or after 4 s)
and only then creates the `calls` row and sends the greeting instruction. The
voice model only speaks; reasoning and tool calls are delegated to an OpenAI
backend model. Tool calls arrive as `response.event` items and are run with
the existing `executeTool`, then answered with `response.item.create` and
`response.create`. `end_call` returns its result without continuing, then
hangs up through a Twilio mark once no output audio has arrived for 1.2 s.
Transcript deltas are accumulated and, together with the tool calls, handed to
the shared `CallLogger`; `end()`/`end_call` finalize exactly once (summary, SMS,
email, `calls` row). `abort()` closes the socket without finalizing (used for
the fallback). Usage arrives as `session.usage.updated` (seconds) and is only
logged; `billable_minutes` comes from the call duration.

**Main exports:** `LiveCallSession` (`start()`, `handleClientAudio()`,
`handleTwilioMark()`, `abort()`, `end()`), `LiveSessionDeps` (injectable
`connect` and `executeTool` for tests and the harness).

**Depends on:** `live-protocol.ts`, `call-logger.ts`, `session.ts`
(`formatOwnerSms`), `session-types.ts`, `tools.ts`, `sms.ts`, `config.ts`
(type), `logger.ts`, `ws`.

**Depended on by:** `session-factory.ts`, `scripts/live-harness.ts`.

## scripts/live-harness.ts

**Purpose:** Local test driver, not part of the running service. Streams a
recorded mu-law WAV into a `LiveCallSession` with fake callbacks and stubbed
tools (or `--real-tools`), prints events (`--raw` shows every server event),
measures the reply delay and saves the reply audio as a WAV. Run with
`npx ts-node src/scripts/live-harness.ts caller.wav`; needs `OPENAI_API_KEY`
and costs a few cents per run.

**Depends on:** `live-session.ts`, `config.ts`.

## tools.ts

**Purpose:** `executeTool()` — dispatches a named tool call (as requested
by the OpenAI Realtime model) to the corresponding handler. HTTP-backed
tools (`get_available_slots`, `get_services`, `get_resources`,
`get_day_availability`, `web_search`, `create_calendar_event` (including
decoding a `slot_id` fallback), `create_enquiry`) call the `flowvoice`
dashboard API. `search_knowledge` is handled locally via `knowledge.ts`
(Qdrant + OpenAI embeddings — no HTTP hop to the dashboard). `end_call`
is handled entirely inside `session.ts`, not here.

**Main exports:** `executeTool(name, args, projectId, calendarProjectId, dbCallId?, knowledgeTopN?)` →
`Promise<{ result: unknown; embeddingTokens: number }>`. All branches return
`embeddingTokens: 0` except `search_knowledge`, which propagates the value
from `searchKnowledge()`.

**Depends on:** `logger.ts`, `knowledge.ts`; HTTP calls into the `flowvoice`
dashboard's `/api/calendar/slots`, `/api/services`, `/api/resources`,
`/api/calendar/windows`, `/api/web-search`, `/api/calendar/events`,
`/api/enquiries` routes (see that repo's `docs/technical.md`).

**Depended on by:** `session.ts` (`executeToolCall`).

## prompt.ts

**Purpose:** Builds the actual instructions string sent to OpenAI for a
call, assembled from up to five sections: (1) universal base prompt
(default in the prompt registry, see "prompts/" below; can be overridden
per environment from Admin → AI Settings), (2) business-context block from
`AssistantSettings` (name, industry, description, website, language,
active service names, today's date in `Europe/Prague`), (3) tools
preamble, (4) optional client-editable business instructions, (5) optional
`===CALL START===` greeting rule — only appended when `greeting_enabled`
is true and `greeting_message` is non-empty, and skipped when
`buildPromptFromSettings` is called with `{ includeGreeting: false }` (the
Live engine's backend model does not speak, so it must not get that rule).
Also builds the tools array
via `buildTools()`, which now includes `search_knowledge` when the
`business_knowledge` capability is on, with a description that mentions
the configured `knowledge_top_n` value.

**Main exports:** `buildPromptFromSettings(settings, callerPhone?, opts?, snapshot?)`,
`buildTools(settings, snapshot?)`, `OpenAITool` (interface). The wording of every
section and of every tool and parameter description comes from the registry
through the `snapshot` (default: `emptySnapshot()` = code defaults); the code
still decides which tools exist, their names, parameter types and `required`.

**Depends on:** `config.ts` (`AssistantSettings` type only), `enquiry-rules.ts`
(the conditions, e-mail and details sentences of the `create_enquiry` tool).

**Depended on by:** `session.ts` (`start()`, to build `instructions` and
`tools` for the `session.update` message).

## enquiry-rules.ts (LEA-101, LEA-33)

**Purpose:** The one place that turns the business's enquiry settings into rules
for the assistant. The `create_enquiry` tool (during the call) and the
after-call check (`call-logger.ts`) both read these rules, so an enquiry is
created under exactly the same conditions in both places. Without it the two
would drift apart: before LEA-33 the after-call check used its own fixed
criteria and ignored the owner's settings.

**Main exports:** `buildEnquiryRules(settings)` → `{ conditions, emailRequired, details }`;
`enquiryEmailNote`, `enquiryDetailsNote` (sentences for the live tool, the
assistant has to ask during the call) and `enquiryDetailsNoteAfterCall` (for the
after-call check, which can only report what was said).

**Rules:**
- `conditions` come from `assistant_settings.enquiries_trigger`: `cant_help`,
  `wants_booking`, `wants_quote`, `wants_human`, `custom` (text from
  `enquiries_trigger_custom`). `needs_support` was merged into `cant_help` in the
  database; the engine still knows the sentence so a setting saved by an old
  dashboard version does not break. An unknown value is passed through as text.
- `details` is `assistant_settings.enquiries_extra_info` with whitespace collapsed
  and cut to 500 characters (`MAX_DETAILS_LENGTH`). It is free text for the
  assistant, not a required tool parameter.

**Depends on:** `config.ts` (type only).

**Depended on by:** `prompt.ts`, `call-logger.ts`.

## call-logger.ts

**Purpose:** `CallLogger` — writes the `calls` row for a call to Supabase
directly (via REST, not through the dashboard API) at call start
(`createCall`), accumulates the transcript and tool-call log as OpenAI/
client events arrive, and exposes `generateCallSummary()` to produce the
post-call title/summary/SMS/email text via GPT once the call ends.
`generateCallSummary()` now also returns `summaryInputTokens` and
`summaryOutputTokens` from the GPT response's `usage` object. It also decides
whether a business-owner enquiry has to be created after the call (see
"After-call enquiry" below). `finalizeCall()`
accepts an optional `TokenUsage` parameter and patches all 7 token-count
columns on the `calls` row (realtime audio in/out, realtime text in/out,
summary in/out, search embedding).

**Main exports:** `CallLogger` (class: `createCall()`,
`handleOpenAIEvent()`, `handleClientEvent()`, `finalizeCall(tokenUsage?)`,
`callId`, `transcript`, `callDurationSeconds`), `generateCallSummary()`,
`prepareEnquiryCheck()`, `maybeCreatePostCallEnquiry()`,
`TokenUsage` (interface), `ZERO_TOKEN_USAGE` (constant), `SmsOptions`,
`TranscriptEntry`.

**After-call enquiry (safety net):**
1. Before the summary is generated, `session.ts` and `live-session.ts` call
   `prepareEnquiryCheck(settings, callId, projectId)`. It returns `null` (no
   check) when the Enquiries capability is off, when there is no call or project
   id, or when an enquiry with this `call_id` already exists (the assistant
   created it during the call). Otherwise it returns the rules from
   `enquiry-rules.ts`. If the lookup itself fails, the check still runs (a
   possible duplicate is better than a lost enquiry).
2. With `null`, the summary prompt does not mention enquiries at all, which also
   saves tokens. With rules, the prompt lists the business's conditions (the same
   sentences as the live tool) and asks for `create_enquiry`, title, description,
   `enquiry_customer_name` and `enquiry_customer_email`.
3. `maybeCreatePostCallEnquiry()` posts the enquiry to the dashboard
   (`/api/enquiries`) with the same fields as the live tool: title, description,
   name and e-mail (only what the customer said), the caller's phone, status
   `new`. It does not send an enquiry type: the type was removed in LEA-33.

**Depends on:** `config.ts` (`getSupabaseUrl`, `getSupabaseHeaders`),
`enquiry-rules.ts`, `logger.ts`.

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

## twilio-security.ts (LEA-59)

**Purpose:** keeps strangers from starting calls. All four Twilio webhooks
(`/twilio/voice`, `/twilio/voice/dial-status`, `/twilio/recording-status`,
`/twilio/sms-status`) call `guardTwilioRequest`, which checks Twilio's
`X-Twilio-Signature` against `TWILIO_AUTH_TOKEN`, the **full** URL Twilio
called (`https://ENGINE_HOST` + `req.originalUrl`, query string included)
and the form fields. A rejected request gets 403 and a
`twilio.signature_rejected` log line (reason, expected URL, project, call;
never the signature or token). The TwiML `<Stream>` also carries an `auth`
parameter, an HMAC (`ENGINE_INTERNAL_SECRET`, 5 minutes, bound to project and
call) that `/ws/twilio` checks on the `start` message
(`twilio.stream_rejected`). Dashboard test calls use `/ws/browser` with their
own ticket and are not affected. `TWILIO_SKIP_VALIDATION=true` switches both
checks off (the one-minute rollback; also for local development). With
validation on, the engine refuses to start without `TWILIO_AUTH_TOKEN` and
`ENGINE_INTERNAL_SECRET`, so the deploy script's health check rolls back.

**Production rollout order:** deploy the new engine while
`TWILIO_SKIP_VALIDATION=true` is still set, then remove the variable and
recreate the container, then check one call, one call forwarded to the owner,
one recording and one SMS receipt. Never remove the variable while the old
engine runs (it signs the URL without the query string and would reject every
call).

## handlers/twilio.ts

**Purpose:** Express handler for the Twilio Voice webhook
(`handleTwilioVoiceWebhook` — validates the Twilio signature (see
`twilio-security.ts`) unless `TWILIO_SKIP_VALIDATION=true`, extracts the caller's phone number from the
SIP `From` header, and returns TwiML that starts call recording and opens
a Media Stream WebSocket back to this engine with `project_id`/
`caller_phone`/`call_sid` as stream parameters), the recording-status
callback (`handleRecordingStatusCallback` — patches the `calls` row with
the final recording URL once Twilio finishes processing it), and the
Media Stream WebSocket handler itself (`handleTwilioConnection` — parses
`start`/`media`/`stop` frames, starts a session through
`session-factory.ts` on `start`, feeds audio through `audio.ts`'s codec
functions only when the session expects PCM 24 kHz (Live takes mu-law as is),
and ends the session on `stop`/close).

**Main exports:** `handleTwilioVoiceWebhook`, `handleRecordingStatusCallback`,
`handleTwilioConnection`.

**Depends on:** `session-factory.ts` (`startCallSession`), `session-types.ts`,
`logger.ts`, `audio.ts` (`twilioAudioToOpenAI`, `openAIAudioToTwilio`), `config.ts`
(`getSupabaseUrl`, `getSupabaseHeaders`), the `twilio` npm package (request
signature validation only).

**Depended on by:** `index.ts` (registers these as the `/twilio/voice`,
`/twilio/recording-status`, and `/ws/twilio` handlers).

## handlers/browser.ts

**Purpose:** WebSocket handler for the test call (LEA-84): the owner scans the
QR code in the dashboard and talks to the assistant from the phone page `/t/<token>`.
Same `CallSession` wiring as the Twilio handler, but audio is exchanged as raw
PCM24 JSON messages instead of Twilio's μ-law media-stream format, so no
`audio.ts` codec conversion is needed here. It only accepts `?ticket=`, a
one-time ticket signed by the dashboard with `ENGINE_INTERNAL_SECRET`
(`test-call-ticket.ts`): project, the phone number the owner typed (used as the
caller number) and the time limit (600 s, with a warning event 60 s before) come from the ticket. At most
`MAX_CONCURRENT_TEST_CALLS` (10) run at once. Test calls are recognised by
having no Twilio call SID; they never SMS the typed number. The call runs the same
engine as a real one (`startCallSession`: Standard or Live); Live speaks 8 kHz
mu-law, so the browser's 24 kHz audio is converted both ways (`audio.ts`).

**Main exports:** `handleBrowserConnection`.

**Depends on:** `session-factory.ts`, `audio.ts`, `test-call-ticket.ts`, `billing.ts`, `logger.ts`.

**Depended on by:** `index.ts` (registers this as the `/ws/browser` handler).

## prompts/ and handlers/prompt-preview.ts (LEA-63)

**Purpose:** Every text the engine sends to OpenAI has its default in
`src/prompts/registry.ts` and can be overridden per environment from the
dashboard's Admin → AI Settings (edit on staging, promote to production with
the GitHub workflow "Promote prompts to production", one-click rollback).
Feature page with the full design, data model and runbook:
`flowvoice/docs/features/ai-settings-prompts.md`.

- `core.ts`: verbatim copy of the dashboard's `src/lib/prompts/core.ts`
  (`definePrompt`, `renderTemplate`, `validateOverride`, `createSnapshot`,
  `emptySnapshot`). `tests/prompts-core-parity.test.ts` keeps both identical
  when the repos sit side by side. Placeholders are `{{name}}`, values are inserted
  literally.
- `registry.ts`: `ENGINE_PROMPTS` (instructions: Standard and Live voice,
  business context, caller phone, customer instructions wrapper, greeting,
  ending the call; post-call: summary head, language, owner SMS, caller SMS,
  owner e-mail, enquiry check (uses `{{conditions}}` and `{{details_note}}`),
  JSON tail, default SMS instructions) and
  `ENGINE_TOOLS` (a description for every tool and every parameter). 52
  definitions in total. Each has a mandatory `usedWhen` (shown in the admin).
  `tests/prompts-registry.test.ts` fails when `buildTools()` produces a tool
  or parameter that has no registered description.
- `store.ts`: `scheduleRegistration()` (from `index.ts`: registers at start and every 6 h so `last_seen_at` stays fresh) and `registerPrompts()` (upserts metadata
  and `code_default` into `admin.ai_prompts`, never the version pointers),
  `getSnapshot()` (active overrides, cached 60 s, refreshed every 30 s by
  `index.ts` so a call never waits; falls back to the last good rows, then to
  code defaults, and logs `prompts.load_failed` / `prompts.override_invalid`),
  `recordUsage()` (once per version and process into
  `admin.ai_prompt_version_usage`, the Promote gate "tried on staging").
- The snapshot is created **once per call** in `session-factory.ts` (parallel
  to `loadAssistantSettings`) and passed to `CallSession` /
  `LiveCallSession`, which use it for the call's prompts, the greeting and
  the post-call summary. A running call keeps its snapshot.
- Without overrides every assembled prompt is byte-identical to the
  pre-registry code: `tests/prompts-golden.test.ts` compares all outputs with
  `tests/fixtures/prompts-golden.json` (captured before the refactor, fixed
  clock). If you change a default on purpose, regenerate that fixture in the
  same change and say so.
- `handlers/prompt-preview.ts`: `POST /internal/prompt-preview {project_id,
  mask_customer?}` returns the standard prompt, the Live voice and backend
  prompts and the tool list for a project with the current overrides; the
  customer's own instructions and greeting are replaced by markers. Same
  protection as `/internal/active-calls` (`X-Internal-Secret`, not proxied by
  nginx).

**Depends on:** `config.ts` (Supabase URL and headers), `logger.ts`.

**Depended on by:** `prompt.ts`, `live-protocol.ts`, `call-logger.ts`,
`session-factory.ts`, `session.ts`, `live-session.ts`, `index.ts`.

**Last verified:** 2026-10-22, engine `721ee54`, dashboard `0feb235`. **Issues:** LEA-63.
