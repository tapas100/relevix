/**
 * AiNarrator — AI augmentation layer for Relevix.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Input  : structured RootCauseData  (NEVER raw logs)               │
 * │  Output : AiNarrative  { explanation, summary, actions }           │
 * │  Model  : gpt-4o-mini  (temperature: 0 → deterministic)            │
 * │  Tokens : ≤ 150 completion  +  ~200 prompt  = ≤ 350 total/call     │
 * │  Fallback: deterministic text from existing rule-engine metadata    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Anti-hallucination controls
 * ───────────────────────────
 *  1. temperature = 0           — maximally greedy/deterministic decoding.
 *  2. System prompt says "only use facts from the JSON payload".
 *  3. Prompt exposes pre-computed explanation + recommendations —
 *     the model re-words, it does NOT invent new diagnoses.
 *  4. JSON output format enforced via response_format: json_object.
 *  5. If the model output cannot be parsed the fallback runs instead.
 *
 * Token minimisation
 * ──────────────────
 *  • Only 9 fields are sent in the user payload (no raw logs, no signals).
 *  • max_tokens = 150 hard-caps the completion.
 *  • System prompt is < 120 tokens (measured; see SYSTEM_PROMPT below).
 */

import type { RootCauseData, AiNarrative, Severity } from '@relevix/types';
import { getMetrics } from '../plugins/metrics.js';

// ─── Public configuration ─────────────────────────────────────────────────────

export interface AiNarratorConfig {
  apiKey: string | undefined;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  enabled: boolean;
}

// ─── Prompt design ────────────────────────────────────────────────────────────

/**
 * SYSTEM PROMPT  (~110 tokens)
 *
 * Design notes:
 *  - Role is tightly scoped to "infrastructure SRE assistant".
 *  - Explicitly forbids inventing facts not present in the JSON.
 *  - Requires strict JSON output — prevents markdown, prose, apologies.
 *  - Caps field lengths to control token spend.
 */
const SYSTEM_PROMPT = `\
You are an expert SRE assistant. You receive structured infrastructure incident data in JSON.
Output ONLY valid JSON with exactly these fields:
  "explanation": string  (≤ 2 sentences, technical, what happened and why)
  "summary":     string  (≤ 25 words, plain English for a status page)
  "actions":     string[] (exactly 3 items, prioritised next steps)

Rules:
- Use ONLY facts present in the input JSON. Never invent metrics or service names.
- Be precise. No filler phrases like "It seems" or "You may want to".
- If confidence < 0.5 qualify statements with "possibly" or "likely".`.trim();

/**
 * Builds the user-facing prompt payload.
 *
 * Only the fields that carry diagnostic signal are included — this keeps the
 * prompt under ~200 tokens regardless of how many supporting insights exist.
 *
 * Fields included:
 *   ruleId, severity, confidence, explanation, affectedComponents,
 *   recommendations (top 3), timeline, supporting (top 2: ruleId + severity)
 */
function buildUserPayload(data: RootCauseData): string {
  const rc = data.rootCause;

  if (!rc) {
    return JSON.stringify({ status: 'no_incident', tenantId: data.tenantId });
  }

  const payload = {
    ruleId:             rc.ruleId,
    severity:           rc.severity,
    confidence:         rc.confidence,
    explanation:        rc.explanation,
    affectedComponents: rc.affectedComponents,
    recommendations:    rc.recommendations.slice(0, 3),
    timeline:           rc.timeline,
    // Compact supporting evidence — just rank + ruleId + severity + composite
    supporting: data.supporting.slice(0, 2).map((s) => ({
      rank:      s.rank,
      ruleId:    s.insight.ruleId,
      severity:  s.insight.severity,
      composite: s.components.composite,
    })),
  };

  return JSON.stringify(payload);
}

// ─── OpenAI wire types (subset — avoids requiring the full SDK) ───────────────

interface OpenAIChatRequest {
  model: string;
  temperature: 0;
  max_tokens: number;
  response_format: { type: 'json_object' };
  messages: Array<{ role: 'system' | 'user'; content: string }>;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ─── Parsed AI output ─────────────────────────────────────────────────────────

interface AiOutput {
  explanation: string;
  summary: string;
  actions: string[];
}

function isAiOutput(v: unknown): v is AiOutput {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['explanation'] === 'string' &&
    typeof o['summary'] === 'string' &&
    Array.isArray(o['actions']) &&
    (o['actions'] as unknown[]).every((a) => typeof a === 'string')
  );
}

// ─── Deterministic fallback ───────────────────────────────────────────────────
//
// When the AI call fails (network, timeout, parse error, disabled) we build
// a narrative purely from the structured data already in RootCauseData.
// This text is always coherent and never hallucinates because it uses only
// the rule-engine's pre-validated fields.

const SEVERITY_SUMMARY: Record<Severity, string> = {
  page:     'Critical production incident detected — immediate action required.',
  critical: 'Critical issue detected — alert the on-call team.',
  warning:  'Warning-level anomaly detected — monitor closely.',
  info:     'Informational signal detected — schedule investigation.',
};

function buildFallbackNarrative(data: RootCauseData): AiNarrative {
  const rc = data.rootCause;
  const now = new Date().toISOString();

  if (!rc) {
    return {
      explanation: 'No active incidents detected for the current observation window.',
      summary:     'System is operating normally — no incidents found.',
      actions:     ['Continue monitoring', 'Review historical trends', 'Verify alerting rules are active'],
      source:      'fallback',
      generatedAt: now,
    };
  }

  const confidencePct = Math.round(rc.confidence * 100);
  const qualifier     = rc.confidence < 0.5 ? 'Possibly: ' : '';

  return {
    explanation: `${qualifier}${rc.explanation} Affected components: ${rc.affectedComponents.join(', ')} (confidence ${String(confidencePct)}%).`,
    summary:     SEVERITY_SUMMARY[rc.severity],
    actions:     rc.recommendations.slice(0, 3),
    source:      'fallback',
    generatedAt: now,
  };
}

// ─── AiNarrator ──────────────────────────────────────────────────────────────

export class AiNarrator {
  private readonly config: AiNarratorConfig;

  constructor(config: AiNarratorConfig) {
    this.config = config;
  }

  /**
   * Generates a narrative for a structured RootCauseData payload.
   *
   * Guarantees a result — always returns either an AI narrative or the
   * deterministic fallback. Never throws.
   */
  async narrate(data: RootCauseData): Promise<AiNarrative> {
    if (!this.config.enabled || !this.config.apiKey) {
      getMetrics().openaiRequestsTotal.labels('fallback').inc();
      return buildFallbackNarrative(data);
    }

    try {
      const result = await this.callOpenAI(data);
      getMetrics().openaiRequestsTotal.labels('success').inc();
      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.toLowerCase().includes('abort');
      getMetrics().openaiRequestsTotal.labels(isTimeout ? 'timeout' : 'error').inc();
      // Swallow all AI errors — fall through to deterministic fallback
      return buildFallbackNarrative(data);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async callOpenAI(data: RootCauseData): Promise<AiNarrative> {
    const body: OpenAIChatRequest = {
      model:           this.config.model,
      temperature:     0,            // deterministic
      max_tokens:      this.config.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPayload(data) },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let raw: OpenAIChatResponse;
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.config.apiKey!}`,
        },
        body:   JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${String(res.status)}: ${text}`);
      }

      raw = (await res.json()) as OpenAIChatResponse;
    } finally {
      clearTimeout(timer);
    }

    const content = raw.choices[0]?.message.content ?? '';
    const parsed  = JSON.parse(content) as unknown;

    // Track token consumption for cost monitoring
    if (raw.usage?.completion_tokens) {
      getMetrics().openaiTokensTotal.inc(raw.usage.completion_tokens);
    }

    if (!isAiOutput(parsed)) {
      throw new Error('AI response did not match expected schema');
    }

    return {
      explanation: parsed.explanation,
      summary:     parsed.summary,
      actions:     parsed.actions.slice(0, 3),
      source:      'ai',
      generatedAt: new Date().toISOString(),
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAiNarrator(cfg: {
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL: string;
  OPENAI_MAX_TOKENS: number;
  AI_NARRATOR_TIMEOUT_MS: number;
  AI_NARRATOR_ENABLED: boolean;
}): AiNarrator {
  return new AiNarrator({
    apiKey:    cfg.OPENAI_API_KEY,
    model:     cfg.OPENAI_MODEL,
    maxTokens: cfg.OPENAI_MAX_TOKENS,
    timeoutMs: cfg.AI_NARRATOR_TIMEOUT_MS,
    enabled:   cfg.AI_NARRATOR_ENABLED,
  });
}
