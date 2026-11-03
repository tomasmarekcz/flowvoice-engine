# What the assistant is told: date and time, rules that always apply, prompt map

## 1. What it is and why it exists

The assistant must know the exact time in the business's timezone, must not be talked out of telling the truth by text a customer wrote, and the many prompts we write by hand must not contradict each other. Linear: LEA-157.

## 2. How it works

Every engine builds its instructions from the prompt registry (`src/prompts/registry.ts`, editable in Admin → AI Settings). The order for Standard, Hybrid and Pipeline (`buildPromptFromSettings`):

1. persona (language, address, gender) · 2. base rules · 3. business context · 4. **date and time** · 5. tools introduction · 6. **when a tool fails** · 7. customer's own instructions · 8. rules for ending the call · 9. greeting · 10. **rules that always apply** (last, so they win over item 7).

Live: the voice gets persona, base, business context, **date and time**, customer instructions, backend rules, ending rules, **rules that always apply**; the backend ("brain") gets the Standard order without the ending rule (it has its own, `live.backend_end_call_rule`).

- **Date and time** (`call.date_time`, `src/now.ts`): for example "Tuesday 3 November 2026, 17:42, Europe/Prague, UTC+01:00". The timezone is the calendar's (`calendars.timezone`, Settings → calendar); a project without a calendar uses `Europe/Prague`. It is built once at the start of the call; a call lasts 30 minutes at most (default 10, `max_call_minutes`), so it stays accurate. Tools take times with the timezone offset; the dashboard reads an offset-less time as the calendar's local time, refuses an assistant booking in the past (`start_time_in_past`) and never returns past free times (`now` is in the answer).
- **Rules that always apply** (`call.protected_core`): no invented facts or actions, a tool error means "not done", no past times, the caller has the last word. Written after the customer's text on purpose.

## 3. Where it lives

`src/prompt.ts` (`buildDateTimeBlock`, `buildPromptFromSettings`), `src/live-protocol.ts` (`buildLiveVoicePrompt`), `src/now.ts`, `src/prompts/registry.ts`. Golden test: `tests/prompts-golden.test.ts` with `tests/fixtures/prompts-golden.json` (regenerate it deliberately when a prompt changes).

## 4. Data

Reads `calendars.timezone` (as `_calendar_timezone`). Writes nothing.

## 5. Behaviour and limits

- An invalid timezone name falls back to Prague (`validTimezone`).
- Customers cannot remove the rules that always apply; they can still add instructions above them.

## 6. Dependencies

Dashboard routes `calendar/windows` and `calendar/events` (past-time guard, `now`); the admin AI Settings tab (overrides of any prompt, including these).

## 7. How to test it

`tests/now.test.ts`, `tests/prompt.test.ts`, `tests/prompts-golden.test.ts`. On staging: a Test call after 17:00 asking for "this afternoon" gets no morning offers.

## 8. Decisions and known gaps: audit of hand-written prompts (2026-11-03)

Found and fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | The assistant knew only the date, in Prague, from the UTC clock (wrong between 00:00 and 01:00 local) | Exact time in the calendar's timezone (`call.date_time`); tools default to today in that timezone on the dashboard |
| 2 | The Live voice knew no date or time at all | Same block added to the Live voice prompt |
| 3 | Customer instructions came with "Always follow these additional instructions" and could override truthfulness or the ending rules | `call.protected_core` after the customer's text |
| 4 | Tool descriptions said "Prague timezone" and "ISO 8601" without offset; offset-less times were saved as UTC (a "14:00" booking became 15:00 in Prague) | Texts say "business's timezone" with an offset example; the dashboard reads an offset-less time as calendar-local |
| 5 | The dashboard offered times already in the past and accepted past bookings from the assistant | Past times removed; `start_time_in_past` |
| 6 | Four different wordings of how to end a call (base, Pipeline style, Live voice, Live brain) | Unified in LEA-158 (`call.ending_rule`, `end_call` and `end_call_live`); the Live voice and brain keep their split on purpose |
| 7 | Live voice said "do not assume a language from the business", while the persona sets the default language | Now: "use the language set in your role, otherwise your greeting" |
| 8 | Nothing said what to do when a tool fails | `call.tool_failure_rule` |
| 9 | A hidden second copy of old prompts in the dashboard route `/api/voice/session` (unused) | Route deleted |

Reviewed, no conflict: the post-call prompts (summary, owner and caller SMS, e-mail, enquiry check, confirmation SMS) use the project language and do not repeat call-time rules.

Known gaps: the Czech phrase "(mluv hned)" inside the English Live greeting instruction is harmless but untidy; `now` for a service with resources in calendars of different timezones uses the first calendar's.

---

**Owner:** Tomáš Marek · **Last verified:** 2026-11-03, branch `tomasmarekcz/lea-157-159-162` · **Issues:** LEA-157
