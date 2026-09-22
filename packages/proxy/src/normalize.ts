/**
 * Wire-shape ↔ engine-shape bridge.
 *
 * The engine speaks OpenAI chat-completions messages (string or part-array
 * content). The Copilot API uses that shape for /chat/completions and the
 * OpenAI-Responses `input` shape for /responses (a list of heterogeneous
 * items: messages, function calls, reasoning…).
 *
 * Normalization rules:
 *  - chat: `messages` must be an array; items pass through as EngineMessage.
 *  - responses: a string item is a user message; object items with a
 *    `content` (string or parts) are messages; anything else
 *    (function_call, reasoning, item refs, …) is NOT a message and is left
 *    byte-for-byte untouched — we only ever replace the `content` field of
 *    a message item the engine actually changed.
 */
import type { EngineMessage } from "@ctxroom/core";

export type CompressibleRoute = "chat" | "responses";

/** Which routes get compression (spec: everything else is byte-transparent). */
export function compressibleRoute(path: string): CompressibleRoute | null {
  if (path === "/chat/completions" || path === "/v1/chat/completions") return "chat";
  if (path === "/responses") return "responses";
  return null;
}

export interface ParsedBody {
  parsed: Record<string, unknown>;
  /** Indices (in the wire list) of messages, paired with engine messages. */
  messagePairs: { wireIndex: number; wire: unknown; message: EngineMessage }[];
  /** Wire list the engine messages came from ("messages" | "input"). */
  wireKey: "messages" | "input";
}

/** Parse one request body into engine messages, or null when not message-bearing. */
export function parseBody(body: Record<string, unknown>, route: CompressibleRoute): ParsedBody | null {
  if (route === "chat") {
    const messages = body.messages;
    if (!Array.isArray(messages)) return null;
    return {
      parsed: body,
      wireKey: "messages",
      messagePairs: messages.map((m, wireIndex) => ({ wireIndex, wire: m, message: m as EngineMessage })),
    };
  }
  const input = body.input;
  if (typeof input === "string") {
    // A bare string input is one big user message.
    return {
      parsed: body,
      wireKey: "input",
      messagePairs: [{ wireIndex: -1, wire: null, message: { role: "user", content: input } }],
    };
  }
  if (!Array.isArray(input)) return null;
  const messagePairs: ParsedBody["messagePairs"] = [];
  input.forEach((item, wireIndex) => {
    const message = toEngineMessage(item);
    if (message) messagePairs.push({ wireIndex, wire: item, message });
  });
  if (messagePairs.length === 0) return null;
  return { parsed: body, wireKey: "input", messagePairs };
}

/** Write engine results back into the wire body in place. Returns changed count. */
export function applyBody(body: ParsedBody, resultMessages: EngineMessage[]): number {
  let changed = 0;
  const list = body.parsed[body.wireKey];
  if (body.wireKey === "messages") {
    // Shallow copies: non-content fields keep their original values/order.
    body.parsed.messages = resultMessages;
    changed = 1;
    return changed;
  }
  if (!Array.isArray(list)) {
    // Bare string input: the engine's single user message is the replacement.
    const first = resultMessages[0];
    if (first && typeof first.content === "string") {
      body.parsed.input = first.content;
      changed = 1;
    }
    return changed;
  }
  // Responses input array: replace only the message items the engine changed.
  const items = list as unknown[];
  resultMessages.forEach((msg, j) => {
    const pair = body.messagePairs[j];
    if (!pair || pair.wireIndex < 0) return;
    const newContent = msg.content;
    const original = pair.wire;
    // A bare string item is a user message; the replacement is a string.
    if (typeof original === "string") {
      if (newContent === original) return; // engine left it alone
      if (typeof newContent === "string") {
        items[pair.wireIndex] = newContent;
        changed++;
      }
      return;
    }
    if (!original || typeof original !== "object" || Array.isArray(original)) return;
    const orig = original as Record<string, unknown>;
    if (newContent === orig.content) return; // engine left it alone
    items[pair.wireIndex] = { ...orig, content: newContent };
    changed++;
  });
  body.parsed.input = items;
  return changed;
}

/** One /responses input item → engine message (null for non-message items). */
function toEngineMessage(item: unknown): EngineMessage | null {
  if (typeof item === "string") return { role: "user", content: item };
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const it = item as Record<string, unknown>;
  // Heterogeneous Responses items (function_call, reasoning, message_ref…)
  // carry no model-visible text we should route through compressors.
  if (typeof it.type === "string" && it.type !== "message") return null;
  const content = it.content;
  if (typeof content !== "string" && !Array.isArray(content)) return null;
  const role = typeof it.role === "string" ? it.role : "user";
  return { ...it, role, content: content as EngineMessage["content"] };
}
