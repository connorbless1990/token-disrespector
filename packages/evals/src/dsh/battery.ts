/**
 * DSH A/B quality gate — score the model's battery answers.
 *
 * Ground truth is generated with the seed (gen-seed.ts). Scoring is exact:
 * counts are integers, presence is yes/no, Q9 is the exact last line, Q12 is
 * a set comparison. A question counts as AGREEING across arms only when both
 * answers are equal after normalization; accuracy is vs ground truth.
 */
import { QUESTIONS } from "./gen-seed.ts";

export interface BatteryScore {
  /** per question: model answer, ground truth, right? */
  q: { id: string; question: string; answer: string; truth: string; right: boolean }[];
  correct: number;
  total: number;
  /** 0..1 */
  accuracy: number;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
/** Q12 answer: "router.ts,engine.ts" — order-insensitive set. */
const setEq = (a: string, b: string): boolean =>
  new Set(a.split(/[,\s]+/).filter(Boolean).sort())
    .toString() ===
  new Set(b.split(/[,\s]+/).filter(Boolean).sort()).toString();

export function scoreBattery(answerText: string, truth: Record<string, string>): BatteryScore {
  const q: BatteryScore["q"] = [];
  for (const [id, question] of Object.entries(QUESTIONS)) {
    const line = answerText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => new RegExp(`^${id}\\s*:`).test(l));
    const answer = line ? line.replace(new RegExp(`^${id}\\s*:\\s*`), "") : "(no answer)";
    let right = false;
    if (id === "Q9") {
      // exact last line (whitespace-normalized)
      right = norm(answer) === norm(truth[id]!);
    } else if (id === "Q12") {
      right = setEq(norm(answer), norm(truth[id]!));
    } else if (id === "Q15") {
      right = norm(answer).includes(norm(truth[id]!));
    } else {
      right = norm(answer) === norm(truth[id]!) || norm(answer).includes(norm(truth[id]!)!);
    }
    q.push({ id, question, answer, truth: truth[id]!, right });
  }
  const correct = q.filter((x) => x.right).length;
  return { q, correct, total: q.length, accuracy: correct / q.length };
}

/** Per-question agreement between two scored arms (the brief's ≥95% gate). */
export function agreement(a: BatteryScore, b: BatteryScore): { agree: number; total: number; disagreements: { id: string; a: string; b: string; truth: string }[] } {
  const disagreements: { id: string; a: string; b: string; truth: string }[] = [];
  let agree = 0;
  for (const qa of a.q) {
    const qb = b.q.find((x) => x.id === qa.id)!;
    if (norm(qa.answer) === norm(qb.answer)) agree++;
    else disagreements.push({ id: qa.id, a: qa.answer, b: qb.answer, truth: qa.truth });
  }
  return { agree, total: a.q.length, disagreements };
}
