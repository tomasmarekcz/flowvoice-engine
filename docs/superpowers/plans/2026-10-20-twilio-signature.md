# LEA-59 Twilio signature validation: plan

**Goal:** engine accepts only requests really sent by Twilio (webhooks) and only streams that its own webhook opened (WebSocket), without ever rejecting a real call because of our own mistake.

**Design (agreed with the owner 2026-10-20):**
- One switch as before: `TWILIO_SKIP_VALIDATION=true` turns everything off (rollback = set it back and recreate the container). Otherwise validation is enforced from day one; every rejection is logged (`twilio.signature_rejected` / `twilio.stream_rejected`, never with secrets).
- `src/twilio-security.ts`: `requestUrl(req)` = `https://ENGINE_HOST` + `req.originalUrl` (**with the query string**, the bug that made validation fail for real calls), `guardTwilioRequest(req, res)` used by all four webhooks (voice, dial-status, recording-status, sms-status), `createStreamAuth(projectId, callSid)` / `verifyStreamAuth(...)` (HMAC with `ENGINE_INTERNAL_SECRET`, 5 minutes, bound to project and call), `assertTwilioSecurityConfigured()` at start (refuses to start with validation on but no `TWILIO_AUTH_TOKEN` / `ENGINE_INTERNAL_SECRET`; the deploy script's health check then rolls back automatically).
- TwiML for the media stream carries `<Parameter name="auth">`; `/ws/twilio` checks it on the `start` message. Dashboard test calls use `/ws/browser` with their own ticket: untouched.

**Rollout order matters:** (1) deploy new code with `TWILIO_SKIP_VALIDATION=true` still set (no behaviour change), (2) remove the variable and recreate the container, (3) four real events: call, call forwarded to the owner, recording, SMS delivery receipt. Never remove the variable while old code runs: old code builds the signed URL without the query and would reject every call.

**Tests:** valid/invalid/missing signature per webhook (with query), URL building behind the proxy, stream auth (valid, wrong project, wrong call, expired, missing), startup check, staging smoke signs the full URL and passes the stream auth.
