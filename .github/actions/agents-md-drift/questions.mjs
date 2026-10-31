// The JEV decision for instruction-file drift (LAB-7596): pinned model, the two
// questions and the confidence bands. These were calibrated together on a
// human-ruled set of candidate pairs; the set, the rulings, the measured
// precision and recall and the rerun procedure live in the internal palatine
// repo at scripts/agents-md-drift-calibration/. Changing anything here changes
// DIGEST below and requires rerunning that set first.
import { createHash } from "node:crypto";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DIFF_CAP = 20000;
export const TRUNCATION_MARKER = "\n[…truncated]";

// One question per request, both under the key "stale". The score of a pair is
// the higher of the two answers.
export const REQUESTS = [
  {
    "stale": {
      "type": "noul",
      "instructions": "An AGENTS.md section governs a source file that a pull request changed. The section text is the head version, already including any edits this PR made to it. Decide whether the section is stale with respect to this change. Stale means the section now contradicts the changed code, or the section explicitly maintains a list (an index, an exhaustive enumeration, a contract of owned keys) and the change adds, removes or renames an item that list should now include or drop. Not stale: the change is consistent with the section, the section does not address what changed, or the section names items only as examples or illustrations.",
      "criteria": {
        "true": "The section is stale: an agent following it at head would be misled about this changed code.",
        "false": "The section is still accurate for this changed code, or does not cover it."
      }
    }
  },
  {
    "stale": {
      "type": "noul",
      "instructions": "An AGENTS.md section governs a source file that a pull request changed. The section text is the head version, already including any edits this PR made to it. Decide whether the section is stale with respect to this change. Stale means the change makes something the section states false: a sentence the changed code now contradicts, a reference the change removes or renames, a rule the change reverses, or a list the section presents as complete that the change adds to or removes from. Not stale: the section is silent about the new code (a missing mention of new code is not staleness), the section names items only as examples, or the code breaks a rule the section states while the rule itself is still meant to hold (that is a code defect, not a stale section).",
      "criteria": {
        "true": "The section is stale: the change makes a statement in it false.",
        "false": "Every statement in the section is still true after this change, even if the section does not mention the new code."
      }
    }
  }
];

// score >= HIGH: a drift finding. MIDDLE <= score < HIGH: needs a human ruling.
export const HIGH = 0.8;
export const MIDDLE = 0.25;

// The calibration set pins this digest; a mismatch means the set was not rerun.
export const DIGEST = "0273dae56d37174f1ab7a626d9d1b6e283f8250cef933df004ab8abeba54f687";
export const questionsDigest = () =>
  createHash("sha256").update(JSON.stringify([JEV_MODEL, DIFF_CAP, TRUNCATION_MARKER, REQUESTS])).digest("hex");

export const scoreOf = (answers) => Math.max(...answers);
export const bandOf = (score) => (score >= HIGH ? "high" : score >= MIDDLE ? "middle" : "low");

// A diff as JEV reads it: at most DIFF_CAP characters, then the marker.
export const cap = (s) => (s.length <= DIFF_CAP ? s : s.slice(0, DIFF_CAP) + TRUNCATION_MARKER);
