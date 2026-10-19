import { describe, expect, it } from "vitest";
import {
  classifyIntent,
  recordHumanSend,
  shouldAutoSend,
  type LearningState
} from "../services/inbox/agent.ts";

const intentEvals: Array<[string, string, string]> = [
  ["Where can I change the colors?", "How do I update the website?", "how_to"],
  ["Connect our domain", "How can I set up DNS?", "how_to"],
  ["CSV import", "How do I import the member list?", "how_to"],
  ["Update membership", "Change the plan benefits", "how_to"],
  ["Invoice copy", "Please send last month's receipt", "billing"],
  ["Duplicate charge", "I was charged twice this month", "billing"],
  ["Payment method", "How do I update my card?", "billing"],
  ["Renewal price", "What is my annual subscription price?", "billing"],
  ["Cancel request", "Please cancel my plan before renewal", "cancellation"],
  ["Close account", "I want to close my account", "cancellation"],
  ["Website error", "The member search is broken", "bug"],
  ["Upload failure", "The profile image upload failed", "bug"],
  ["Project proposal", "Can you provide a quote for our redesign?", "sales"],
  ["Demo request", "We are interested in a new website demo", "sales"],
  ["Feature suggestion", "Could you add several office locations?", "feature_request"],
  ["New feature", "Please add a certification filter", "feature_request"],
  ["Unhappy with support", "I am frustrated and disappointed", "complaint"],
  ["Still waiting", "The promised follow-up never arrived", "complaint"],
  ["Any update?", "Following up on last week's estimate", "follow_up"],
  ["Status update", "I am checking in about our previous email", "follow_up"]
];

const blankLearning: LearningState = {
  streaks: {},
  automation: {},
  editedCount: 0,
  unchangedCount: 0,
  sentCount: 0
};

describe("Inbox Agent evaluation cases", () => {
  it.each(intentEvals)("routes email %s to %s", (subject, body, expected) => {
    expect(classifyIntent(subject, body)).toBe(expected);
  });

  it("requires 20 consecutive unedited replies before enabling automation", () => {
    let learning = blankLearning;
    for (let index = 0; index < 19; index += 1) {
      learning = recordHumanSend(learning, "how_to", "Here are the steps.", "Here are the steps.").learning;
    }
    expect(learning.automation.how_to).not.toBe(true);
    learning = recordHumanSend(learning, "how_to", "Here are the steps.", "Here are the steps.").learning;
    expect(learning.streaks.how_to).toBe(20);
    expect(learning.automation.how_to).toBe(true);
  });

  it("resets an automation streak when a human edits the draft", () => {
    const learning: LearningState = {
      ...blankLearning,
      streaks: { how_to: 20 },
      automation: { how_to: true }
    };
    const result = recordHumanSend(learning, "how_to", "Check the settings.", "Please check your settings first.");
    expect(result.edited).toBe(true);
    expect(result.learning.streaks.how_to).toBe(0);
    expect(result.learning.automation.how_to).toBe(false);
  });

  it("does not automate billing, cancellation, complaints, sales, security or unknown emails", () => {
    const learning: LearningState = {
      ...blankLearning,
      automation: {
        billing: true, cancellation: true, complaint: true, sales: true, security: true, other: true
      }
    };
    for (const category of ["billing", "cancellation", "complaint", "sales", "security", "other"] as const) {
      expect(shouldAutoSend(category, learning, 0.99)).toBe(false);
    }
  });

  it("requires confident knowledge before an approved low-risk category can auto-send", () => {
    const learning: LearningState = { ...blankLearning, automation: { how_to: true } };
    expect(shouldAutoSend("how_to", learning, 0.59)).toBe(false);
    expect(shouldAutoSend("how_to", learning, 0.6)).toBe(true);
  });

  it("counts unchanged sends and preserves independent category streaks", () => {
    const first = recordHumanSend(blankLearning, "how_to", "Answer.", "Answer.");
    const second = recordHumanSend(first.learning, "billing", "Answer.", "Answer.");
    expect(second.learning.streaks.how_to).toBe(1);
    expect(second.learning.streaks.billing).toBe(1);
    expect(second.learning.unchangedCount).toBe(2);
  });

  it("ignores case and whitespace when deciding whether a draft changed", () => {
    const result = recordHumanSend(blankLearning, "how_to", " Thanks  for asking. ", "thanks for asking.");
    expect(result.edited).toBe(false);
  });
});
