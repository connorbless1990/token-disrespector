/**
 * Send-form tracking — the KV-cache stability mechanism.
 *
 * Reality of agent clients: the Copilot CLI (and Claude Code & friends) keep
 * their *own* copy of the conversation and resend the full message list on
 * every turn — with the ORIGINAL tool output in it, regardless of what the
 * proxy forwarded last time.
 *
 * The provider's KV cache is a byte-prefix cache. If the bytes we send at
 * position k differ from what it last saw, reuse dies from k onward.
 *
 * Resolution: the registry remembers, per session, per message:
 *   - the hash of what the client SENT us (incoming);
 *   - what we actually FORWARDED (outgoing: the compressed replacement, or
 *     null for unchanged).
 *
 * On the next request, if the client resends the same content, we forward
 * the same outgoing bytes → the prefix is byte-identical to the provider's
 * last view → the warm cache survives, and a big tool result that was
 * compressed at birth stays compressed (and window-shrinking) for the whole
 * session. Deterministic compressors make the re-forwarded bytes identical
 * even after a proxy restart.
 */
import { createHash } from "node:crypto";
import type { EngineMessage } from "./types.ts";

const LRU_SIZE = 64;

function hash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Stable conversation identity derived from the request itself. */
export function sessionKey(messages: EngineMessage[]): string {
  let system = "";
  let firstUser = "";
  for (const m of messages) {
    const t = messageText(m);
    if (m.role === "system" && !system) system = t;
    if ((m.role === "user" || m.role === "developer") && !firstUser) firstUser = t;
  }
  return hash((system || "∅") + "\x00" + (firstUser || "∅")).slice(0, 32);
}

export function messageText(m: EngineMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("\x1f");
  }
  return "";
}

/** Hash of one message as the client sent it (role + content). */
export function incomingHash(m: EngineMessage): string {
  return hash(m.role + "\x1e" + messageText(m));
}

/** What the proxy forwarded for one message: string content, or per-part texts. */
export type ForwardText = string | string[] | null;

/** A message's remembered send form. */
export interface SentForm {
  /** Hash of the client-sent content (role + text). */
  incoming: string;
  /** Replacement for string content, or null when forwarded unchanged. */
  outgoing: string | null;
  /** Replacement texts for an array-content message (parallel to its text parts). */
  outgoingParts: string[] | null;
  /** Shape of the original content: "string" | "parts" | "none". */
  shape: "string" | "parts" | "none";
}

interface SessionState {
  key: string;
  /** Ordered per-message send forms, most recent request last. */
  history: SentForm[][];
}

/** Text parts of an array-content message (non-text parts → null). */
export function originalParts(m: EngineMessage): (string | null)[] {
  if (!Array.isArray(m.content)) return [];
  return m.content.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : null));
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private lastMessages: EngineMessage[] | undefined;

  /**
   * Reconcile this request against the session's remembered send forms.
   *
   * Returns, for each message index, the text to forward (a replacement when
   * one was established for exactly this content, else the original text) and
   * which indices are *new* (never seen in this session) — the true live
   * zone eligible for fresh compression.
   *
   * Callers must feed the returned forwarding decisions back through
   * `record()` after the request is resolved.
   */
  reconcile(messages: EngineMessage[]): {
    forwardTexts: ForwardText[];
    liveStart: number;
  } {
    const key = sessionKey(messages);
    const session = this.sessions.get(key) ?? { key, history: [] };
    const latest = session.history[session.history.length - 1];

    const inHashes = messages.map(incomingHash);
    let matched = 0;
    if (latest) {
      // longest prefix of messages that matches the last request's forms
      const n = Math.min(latest.length, messages.length);
      for (let i = 0; i < n; i++) {
        if (latest[i].incoming === inHashes[i]) matched = i + 1;
        else break;
      }
      // If the client shrank the conversation (its own compaction), the
      // prefix match simply ends earlier — safe.
    }

    const forwardTexts: ForwardText[] = new Array(messages.length).fill(null);
    for (let i = 0; i < messages.length; i++) {
      if (i < matched && latest) {
        // Re-send exactly what we forwarded before (compressed or not) so
        // the provider's cached prefix matches byte-for-byte.
        forwardTexts[i] =
          latest[i].shape === "parts" ? latest[i].outgoingParts : latest[i].outgoing;
      } else {
        forwardTexts[i] = null; // new: forward as-is (compression happens downstream)
      }
    }

    this.touch(session);
    return { forwardTexts, liveStart: matched };
  }

  /** The session's latest request's send forms (for budget-mode skip logic). */
  latestForms(): SentForm[] | undefined {
    if (!this.lastMessages) return undefined;
    const s = this.sessions.get(sessionKey(this.lastMessages));
    return s?.history[s.history.length - 1];
  }

  /**
   * Record this request's actual forwarding forms as the session's latest.
   * `forwardTexts[i] === null` means "forwarded unchanged".
   */
  record(messages: EngineMessage[], forwardTexts: ForwardText[]): void {
    const key = sessionKey(messages);
    let session = this.sessions.get(key);
    if (!session) {
      session = { key, history: [] };
      if (this.sessions.size >= LRU_SIZE) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(key, session);
    }
    this.lastMessages = messages;
    session.history.push(
      messages.map((m, i) => {
        const original = messageText(m);
        const fwd = forwardTexts[i];
        const shape: SentForm["shape"] =
          typeof m.content === "string" ? "string" : Array.isArray(m.content) ? "parts" : "none";
        if (fwd === null || fwd === undefined) {
          return { incoming: incomingHash(m), outgoing: null, outgoingParts: null, shape };
        }
        if (shape === "parts" && Array.isArray(fwd)) {
          const unchanged = fwd.every((t, j) => t === (originalParts(m)[j] ?? t));
          return {
            incoming: incomingHash(m),
            outgoing: null,
            outgoingParts: unchanged ? null : fwd,
            shape,
          };
        }
        const unchanged = fwd === original;
        return {
          incoming: incomingHash(m),
          outgoing: unchanged ? null : (fwd as string),
          outgoingParts: null,
          shape,
        };
      })
    );
    if (session.history.length > 4) session.history.shift();
  }

  private touch(session: SessionState): void {
    if (!this.sessions.has(session.key)) {
      if (this.sessions.size >= LRU_SIZE) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(session.key, session);
      return;
    }
    // refresh LRU position
    this.sessions.delete(session.key);
    this.sessions.set(session.key, session);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/**
 * Budget mode: eligible indices (oldest first) when the estimated request
 * exceeds the configured token budget. Already-forwarded-compressed messages
 * (outgoing !== null in the session's latest forms) are skipped: their bytes
 * are the provider's cached bytes and must not change.
 */
export function budgetEligible(
  messages: EngineMessage[],
  forwardTexts: ForwardText[],
  latestForms: SentForm[] | undefined,
  estimateFor: (text: string, role: string) => number,
  budget: number
): number[] {
  let total = 0;
  for (let i = 0; i < messages.length; i++) {
    const fwd = forwardTexts[i];
    const t =
      fwd === null
        ? messageText(messages[i])
        : Array.isArray(fwd)
          ? fwd.join("\n")
          : fwd;
    total += estimateFor(t, messages[i].role);
  }
  if (total <= budget) return [];
  const eligible: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system" || m.role === "developer") continue; // invariant I1
    if (latestForms?.[i]?.outgoing || latestForms?.[i]?.outgoingParts) continue; // already compressed — frozen
    eligible.push(i);
  }
  return eligible;
}
