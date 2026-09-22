import type { AssistantSettings } from "./config";
import { isWithinWorkingHours } from "./working-hours";

export type AnswerMode = NonNullable<AssistantSettings["answer_mode"]>;

export type RoutingDecision =
  | { kind: "ai" }
  | { kind: "dial"; withAiFallback: boolean };

// Only "outside_hours" and "missed_and_outside" ever ring the owner from our
// side. "always" and "missed_calls" both resolve to "ai" here — for
// missed_calls the owner's carrier already decided the call went unanswered
// before Twilio ever saw it (see docs/getting-started/call-forwarding), so
// dialing them again from here would just add a second, pointless ring cycle.
export function decideCallRouting(opts: {
  answerMode: AssistantSettings["answer_mode"];
  workingHours: AssistantSettings["working_hours"];
  timezone: string | null | undefined;
  hasOwnerPhone: boolean;
  now?: Date;
}): RoutingDecision {
  const mode = opts.answerMode ?? "missed_calls";
  if (!opts.hasOwnerPhone || (mode !== "outside_hours" && mode !== "missed_and_outside")) {
    return { kind: "ai" };
  }

  const withinHours = isWithinWorkingHours(opts.workingHours, opts.timezone, opts.now);
  if (mode === "outside_hours") {
    return withinHours ? { kind: "dial", withAiFallback: false } : { kind: "ai" };
  }
  // missed_and_outside
  return withinHours ? { kind: "dial", withAiFallback: true } : { kind: "ai" };
}
