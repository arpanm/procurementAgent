/**
 * Store for the per-platform GUIDED-RAG KNOWLEDGE layer (frontend half).
 *
 * Caches curated {@link KnowledgeDoc}s, fetches them from the backend `/knowledge` endpoint via a
 * pluggable transport, and ALWAYS falls back to the built-in defaults on any error or invalid payload.
 * The contract with the agents is: this never throws — a flaky/garbage backend can't crash extraction.
 */
import type { PlatformId } from "../domain/types";
import type {
  KnowledgeDoc,
  KnowledgeHints,
  KnowledgeNote,
  KnowledgePolicies,
} from "./PlatformKnowledge";
import { defaultKnowledge } from "./defaults";

/**
 * Pluggable HTTP transport for the knowledge endpoint. Kept deliberately decoupled from
 * `HttpBackendClient` so the knowledge layer can be wired to any client (or a fake in tests).
 */
export interface KnowledgeTransport {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** What the platform agents consume. */
export interface PlatformKnowledgeStore {
  /** Resolve the curated doc for a platform (cache → backend → default). Never throws. */
  getKnowledge(platform: PlatformId): Promise<KnowledgeDoc>;
  /** Best-effort record of a runtime observation for a platform. Never throws. */
  recordObservation(platform: PlatformId, note: { kind: string; text: string }): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Coerce an unknown into a string[]: drops non-strings, returns `fallback` when not an array. */
function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === "string");
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePolicies(value: unknown, fallback: KnowledgePolicies): KnowledgePolicies {
  const raw = isObject(value) ? value : {};
  return {
    priceFromDetailPage: asBoolean(raw.priceFromDetailPage, fallback.priceFromDetailPage),
    trustListingPrice: asBoolean(raw.trustListingPrice, fallback.trustListingPrice),
  };
}

function normalizeHints(value: unknown, fallback: KnowledgeHints): KnowledgeHints {
  const raw = isObject(value) ? value : {};
  return {
    rejectTokens: asStringArray(raw.rejectTokens, fallback.rejectTokens),
    processedVariantTokens: asStringArray(
      raw.processedVariantTokens,
      fallback.processedVariantTokens,
    ),
    atcTokens: asStringArray(raw.atcTokens, fallback.atcTokens),
    addedTokens: asStringArray(raw.addedTokens, fallback.addedTokens),
    searchNotes: asStringArray(raw.searchNotes, fallback.searchNotes),
  };
}

function normalizeNotes(value: unknown): KnowledgeNote[] {
  if (!Array.isArray(value)) return [];
  const notes: KnowledgeNote[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    notes.push({
      at: typeof entry.at === "string" ? entry.at : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      text: typeof entry.text === "string" ? entry.text : "",
    });
  }
  return notes;
}

/**
 * Normalize an arbitrary backend payload into a valid {@link KnowledgeDoc}, filling any missing or
 * malformed field from the platform default. Guarantees a fully-populated doc so agents never see
 * `undefined` hints/policies.
 */
export function normalizeKnowledgeDoc(value: unknown, platform: PlatformId): KnowledgeDoc {
  const fallback = defaultKnowledge(platform);
  const raw = isObject(value) ? value : {};
  return {
    platform,
    version: typeof raw.version === "number" ? raw.version : fallback.version,
    policies: normalizePolicies(raw.policies, fallback.policies),
    hints: normalizeHints(raw.hints, fallback.hints),
    notes: normalizeNotes(raw.notes),
  };
}

export class DefaultKnowledgeStore implements PlatformKnowledgeStore {
  private readonly transport?: KnowledgeTransport;
  private readonly cache = new Map<PlatformId, KnowledgeDoc>();

  constructor(opts?: { transport?: KnowledgeTransport }) {
    this.transport = opts?.transport;
  }

  async getKnowledge(platform: PlatformId): Promise<KnowledgeDoc> {
    const cached = this.cache.get(platform);
    if (cached) return cached;

    let doc: KnowledgeDoc;
    if (this.transport) {
      try {
        const payload = await this.transport.get("/knowledge/" + platform);
        doc = normalizeKnowledgeDoc(payload, platform);
      } catch {
        doc = defaultKnowledge(platform);
      }
    } else {
      doc = defaultKnowledge(platform);
    }

    this.cache.set(platform, doc);
    return doc;
  }

  async recordObservation(
    platform: PlatformId,
    note: { kind: string; text: string },
  ): Promise<void> {
    const cached = this.cache.get(platform);
    if (cached) {
      cached.notes.push({ at: new Date().toISOString(), kind: note.kind, text: note.text });
    }
    if (!this.transport) return;
    try {
      await this.transport.post("/knowledge/" + platform + "/observations", note);
    } catch {
      // Best-effort: observations are advisory; never let a failed post crash an agent.
    }
  }
}
