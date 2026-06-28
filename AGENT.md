# FlowVoice Engine — Agent Notes

## Architecture

The engine is a Node.js/TypeScript Express server running in Docker on EC2.

- Entry point: `src/index.ts`
- Voice call flow: Twilio webhook → TwiML → WebSocket → OpenAI Realtime API
- Post-call: `session.end()` → `generateCallSummary()` → `sendSmsNotifications()` → `finalizeCall()`
- All Supabase calls use plain `fetch` (no SDK)
- All Twilio calls use plain `fetch` (no SDK, except signature validation)

## Environment Variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (bypasses RLS) |
| `OPENAI_API_KEY` | OpenAI API key (Realtime + chat completions) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (webhook validation + SMS) |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (SMS sending) |
| `TWILIO_SMS_FROM` | Alphanumeric sender ID for SMS (default: `FlowVoice`) |
| `ENGINE_HOST` | Public hostname (e.g. `leadoro.io`) — sets wss/https protocols |
| `TWILIO_SKIP_VALIDATION` | Set to `true` in dev to skip Twilio signature check |
| `FRONTEND_API_URL` | URL of Next.js frontend for tool call API routes (default: `http://localhost:3000`) |

## TODO — Future work

### Recording storage

- [ ] **Auto-delete Twilio recordings after 30 days:** Add a GitHub Actions scheduled workflow (cron `0 3 * * *`) that calls a Next.js API route `POST /api/cron/cleanup-recordings`. That route queries Supabase for `calls` where `recording_sid IS NOT NULL AND started_at < NOW() - INTERVAL '30 days'`, then calls `DELETE https://api.twilio.com/2010-04-01/Accounts/{SID}/Recordings/{recording_sid}` (Basic auth with `TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`) for each, and NULLs `recording_sid` in Supabase.

- [ ] **S3 backup of recordings:** After Twilio recording callback in `/twilio/recording-status`, download the MP3 (authenticated GET to `RecordingUrl.mp3`), upload to AWS S3 using `@aws-sdk/client-s3` `PutObjectCommand`, save the S3 public URL to `calls.recording_url`, then delete from Twilio. Requires new env vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_REGION`. This makes recordings independent of Twilio retention.
