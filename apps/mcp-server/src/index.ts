/**
 * Relevix MCP Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Exposes Relevix infrastructure intelligence as MCP tools so AI agents
 * (Claude, GPT-4o, Cursor, etc.) can call them during conversations.
 *
 * Transport: stdio (default for MCP — agent spawns this process).
 *
 * Tools exposed:
 * ┌─────────────────────────┬────────────────────────────────────────────────┐
 * │ Tool                    │ Maps to                                        │
 * ├─────────────────────────┼────────────────────────────────────────────────┤
 * │ relevix_insights        │ GET  /v1/insights                              │
 * │ relevix_analyze         │ GET  /v1/root-cause + /v1/explain (parallel)   │
 * │ relevix_compare         │ GET  /v1/insights × 2  (parallel)              │
 * │ relevix_search          │ POST /v1/search/insights                       │
 * │ relevix_explain         │ GET  /v1/explain                               │
 * │ relevix_health          │ GET  /health                                   │
 * └─────────────────────────┴────────────────────────────────────────────────┘
 *
 * Configuration (env vars):
 *   RELEVIX_API_URL    Gateway base URL (default: http://localhost:3001)
 *   RELEVIX_TOKEN      JWT bearer token (required)
 *
 * Usage with Claude Desktop (add to claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "relevix": {
 *         "command": "node",
 *         "args": ["/path/to/relevix/apps/mcp-server/dist/index.js"],
 *         "env": {
 *           "RELEVIX_API_URL": "http://localhost:3001",
 *           "RELEVIX_TOKEN":   "eyJ..."
 *         }
 *       }
 *     }
 *   }
 *
 * Usage with Cursor / any MCP-compatible host:
 *   Spawn process: node dist/index.js
 *   Pipe stdin/stdout as MCP transport.
 */

import { Server }   from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  InsightsData,
  RootCauseData,
  ExplainData,
  InsightSearchResponse,
  HealthCheckResponse,
  ApiSuccess,
  ApiError,
  Severity,
} from '@relevix/types';

// ─── Config ───────────────────────────────────────────────────────────────────

const API_URL = (process.env['RELEVIX_API_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');
const TOKEN   = process.env['RELEVIX_TOKEN'] ?? '';

// ─── HTTP client ──────────────────────────────────────────────────────────────

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!TOKEN) throw new Error('RELEVIX_TOKEN env var is not set');

  const res  = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });

  const body = (await res.json()) as ApiSuccess<T> | ApiError;
  if (!res.ok || !body.ok) {
    throw new Error(
      body.ok === false
        ? (body as ApiError).error.message
        : `HTTP ${String(res.status)}`,
    );
  }
  return (body as ApiSuccess<T>).data;
}

function qs(p: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'relevix', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [

    // ── 1. relevix_insights ────────────────────────────────────────────────
    {
      name:        'relevix_insights',
      description: 'List ranked infrastructure insights for the current tenant. ' +
                   'Optionally filter by service name and limit the count. ' +
                   'Returns severity, confidence score, composite score, and when each insight was fired.',
      inputSchema: {
        type: 'object',
        properties: {
          service: {
            type:        'string',
            description: 'Filter insights to a specific service (e.g. "checkout", "payment").',
          },
          limit: {
            type:        'integer',
            minimum:     1,
            maximum:     50,
            default:     10,
            description: 'Maximum number of insights to return.',
          },
        },
      },
    },

    // ── 2. relevix_analyze ─────────────────────────────────────────────────
    {
      name:        'relevix_analyze',
      description: 'Deep-dive analysis of the current infrastructure state. ' +
                   'Returns the root cause (most probable cause of incidents), AI-generated explanation, ' +
                   'human-readable summary, and prioritised remediation actions. ' +
                   'Use this when a user asks "what is wrong?", "why is X slow?", or "what should I do?".',
      inputSchema: {
        type: 'object',
        properties: {
          service: {
            type:        'string',
            description: 'Scope analysis to a specific service.',
          },
        },
      },
    },

    // ── 3. relevix_compare ─────────────────────────────────────────────────
    {
      name:        'relevix_compare',
      description: 'Compare the active insights and root causes of two services side-by-side. ' +
                   'Useful for questions like "is nginx or haproxy healthier?", ' +
                   '"which of checkout vs payment has more issues?", etc.',
      inputSchema: {
        type:     'object',
        required: ['serviceA', 'serviceB'],
        properties: {
          serviceA: {
            type:        'string',
            description: 'First service to compare (e.g. "nginx").',
          },
          serviceB: {
            type:        'string',
            description: 'Second service to compare (e.g. "haproxy").',
          },
        },
      },
    },

    // ── 4. relevix_search ──────────────────────────────────────────────────
    {
      name:        'relevix_search',
      description: 'Full-text search over indexed infrastructure insights. ' +
                   'Supports natural language queries like "latency spike last hour", ' +
                   '"cascading failure", "error rate above threshold". ' +
                   'Returns scored, highlighted results.',
      inputSchema: {
        type:     'object',
        required: ['query'],
        properties: {
          query: {
            type:        'string',
            description: 'Search query. Supports Elasticsearch simple_query_string syntax.',
          },
          service: {
            type:        'string',
            description: 'Restrict results to a specific service.',
          },
          minSeverity: {
            type:        'string',
            enum:        ['page', 'critical', 'warning', 'info'],
            description: 'Only return insights at or above this severity.',
          },
          limit: {
            type:        'integer',
            minimum:     1,
            maximum:     50,
            default:     10,
            description: 'Maximum number of results.',
          },
        },
      },
    },

    // ── 5. relevix_explain ─────────────────────────────────────────────────
    {
      name:        'relevix_explain',
      description: 'Get an AI-generated plain-English narrative for the current incident. ' +
                   'Returns a 1-2 sentence technical explanation and a ≤25-word status-page summary. ' +
                   'Source field indicates whether the text came from the AI model or a deterministic fallback.',
      inputSchema: {
        type: 'object',
        properties: {
          service: {
            type:        'string',
            description: 'Scope explanation to a specific service.',
          },
        },
      },
    },

    // ── 6. relevix_health ──────────────────────────────────────────────────
    {
      name:        'relevix_health',
      description: 'Check the health of the Relevix API gateway and its dependencies ' +
                   '(Redis, rule-engine). Returns status: "ok" | "degraded" | "down".',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },

  ],
}));

import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ── Tool execution ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {

      // ── relevix_insights ────────────────────────────────────────────────
      case 'relevix_insights': {
        const p = args as { service?: string; limit?: number };
        const data = await apiRequest<InsightsData>(
          `/v1/insights${qs({ service: p.service, limit: p.limit ?? 10 })}`,
        );
        return {
          content: [{
            type: 'text',
            text: formatInsights(data),
          }],
        };
      }

      // ── relevix_analyze ─────────────────────────────────────────────────
      case 'relevix_analyze': {
        const p = args as { service?: string };
        const [rc, explain] = await Promise.all([
          apiRequest<RootCauseData>(`/v1/root-cause${qs({ service: p.service })}`),
          apiRequest<ExplainData>(`/v1/explain${qs({ service: p.service })}`),
        ]);
        return {
          content: [{
            type: 'text',
            text: formatAnalysis(rc, explain),
          }],
        };
      }

      // ── relevix_compare ─────────────────────────────────────────────────
      case 'relevix_compare': {
        const p = args as { serviceA: string; serviceB: string };
        const [insA, insB, rcA, rcB] = await Promise.all([
          apiRequest<InsightsData>(`/v1/insights${qs({ service: p.serviceA, limit: 5 })}`),
          apiRequest<InsightsData>(`/v1/insights${qs({ service: p.serviceB, limit: 5 })}`),
          apiRequest<RootCauseData>(`/v1/root-cause${qs({ service: p.serviceA })}`),
          apiRequest<RootCauseData>(`/v1/root-cause${qs({ service: p.serviceB })}`),
        ]);
        return {
          content: [{
            type: 'text',
            text: formatComparison(p.serviceA, p.serviceB, insA, insB, rcA, rcB),
          }],
        };
      }

      // ── relevix_search ──────────────────────────────────────────────────
      case 'relevix_search': {
        const p = args as { query: string; service?: string; minSeverity?: Severity; limit?: number };
        const result = await apiRequest<InsightSearchResponse>('/v1/search/insights', {
          method: 'POST',
          body:   JSON.stringify({
            q:     p.query,
            limit: p.limit ?? 10,
            ...(p.service     && { service: p.service }),
            ...(p.minSeverity && { minSeverity: p.minSeverity }),
          }),
        });
        return {
          content: [{
            type: 'text',
            text: formatSearch(result),
          }],
        };
      }

      // ── relevix_explain ─────────────────────────────────────────────────
      case 'relevix_explain': {
        const p = args as { service?: string };
        const data = await apiRequest<ExplainData>(`/v1/explain${qs({ service: p.service })}`);
        return {
          content: [{
            type: 'text',
            text: formatExplain(data),
          }],
        };
      }

      // ── relevix_health ──────────────────────────────────────────────────
      case 'relevix_health': {
        const data = await apiRequest<HealthCheckResponse>('/health');
        return {
          content: [{
            type: 'text',
            text: `Relevix Gateway: ${data.status.toUpperCase()}\nUptime: ${String(Math.floor(data.uptime / 60))} min\nChecks: ${JSON.stringify(data.checks, null, 2)}`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

  } catch (err) {
    return {
      content: [{
        type:  'text',
        text:  `Error: ${String(err instanceof Error ? err.message : err)}`,
      }],
      isError: true,
    };
  }
});

// ─── Formatters (plain text — LLM-friendly, no ANSI) ─────────────────────────

function pct(n: number): string { return `${String(Math.round(n * 100))}%`; }

function formatInsights(data: InsightsData): string {
  if (data.insights.length === 0) return 'No active insights found.';

  const lines = [
    `Insights for ${data.service ?? 'all services'} (${String(data.total)} total, computed ${data.computedAt}):`,
    '',
  ];

  for (const ri of data.insights) {
    const { insight: ins, components: c } = ri;
    lines.push(
      `#${String(ri.rank)} [${ins.severity.toUpperCase()}] ${ins.ruleName}`,
      `  Rule ID:    ${ins.ruleId}`,
      `  Confidence: ${pct(ins.confidence)}  Composite: ${pct(c.composite)}  Recency: ${pct(c.recency)}  Impact: ${pct(c.impact)}`,
      `  Fired:      ${ins.firedAt}`,
      '',
    );
  }

  return lines.join('\n');
}

function formatAnalysis(rc: RootCauseData, ex: ExplainData): string {
  const lines: string[] = [
    `Analysis for ${rc.service ?? 'all services'} (${rc.computedAt}):`,
    '',
  ];

  // AI narrative
  lines.push(
    `── AI Narrative (source: ${ex.narrative.source}) ──`,
    `Summary:     ${ex.narrative.summary}`,
    `Explanation: ${ex.narrative.explanation}`,
    '',
    'Next actions:',
    ...ex.narrative.actions.map((a, i) => `  ${String(i + 1)}. ${a}`),
    '',
  );

  // Root cause
  if (!rc.rootCause) {
    lines.push('Root Cause: None — system looks healthy.');
  } else {
    const r = rc.rootCause;
    lines.push(
      `── Root Cause ──`,
      `Rule:        ${r.ruleId}  [${r.severity.toUpperCase()}]`,
      `Confidence:  ${pct(r.confidence)}`,
      `Explanation: ${r.explanation}`,
      `Affected:    ${r.affectedComponents.join(', ')}`,
      `Detected:    ${r.timeline.detectedAt}`,
      '',
      'Recommendations:',
      ...r.recommendations.map((rec, i) => `  ${String(i + 1)}. ${rec}`),
    );
  }

  // Supporting
  if (rc.supporting.length > 0) {
    lines.push('', '── Supporting Signals ──');
    for (const ri of rc.supporting) {
      lines.push(`  [${ri.insight.severity.toUpperCase()}] ${ri.insight.ruleName} — composite ${pct(ri.components.composite)}`);
    }
  }

  return lines.join('\n');
}

function formatComparison(
  svcA: string, svcB: string,
  insA: InsightsData, insB: InsightsData,
  rcA: RootCauseData, rcB: RootCauseData,
): string {
  const lines: string[] = [
    `Comparison: ${svcA} vs ${svcB}`,
    '',
    `${svcA}: ${String(insA.total)} active insights`,
    `${svcB}: ${String(insB.total)} active insights`,
    '',
  ];

  const max = Math.max(insA.insights.length, insB.insights.length);
  for (let i = 0; i < max; i++) {
    const a = insA.insights[i];
    const b = insB.insights[i];
    const aStr = a ? `[${a.insight.severity.toUpperCase()}] ${a.insight.ruleName} (${pct(a.components.composite)})` : '—';
    const bStr = b ? `[${b.insight.severity.toUpperCase()}] ${b.insight.ruleName} (${pct(b.components.composite)})` : '—';
    lines.push(`  #${String(i + 1)}  ${svcA}: ${aStr}`);
    lines.push(`      ${svcB}: ${bStr}`);
    lines.push('');
  }

  const winner = insA.total <= insB.total ? svcA : svcB;
  lines.push(`Verdict: ${winner} has fewer active issues.`);

  lines.push('', `── Root Cause: ${svcA} ──`);
  lines.push(rcA.rootCause ? `[${rcA.rootCause.severity.toUpperCase()}] ${rcA.rootCause.explanation}` : 'None detected.');

  lines.push('', `── Root Cause: ${svcB} ──`);
  lines.push(rcB.rootCause ? `[${rcB.rootCause.severity.toUpperCase()}] ${rcB.rootCause.explanation}` : 'None detected.');

  return lines.join('\n');
}

function formatSearch(result: InsightSearchResponse): string {
  if (result.hits.length === 0) return `No results found. (took ${String(result.took)}ms)`;

  const lines = [
    `${String(result.total)} results (took ${String(result.took)}ms):`,
    '',
  ];

  for (const hit of result.hits) {
    const doc = hit.document;
    lines.push(
      `[${doc.severity.toUpperCase()}] ${doc.ruleName}  (score: ${hit.score.toFixed(2)})`,
      `  ${doc.explanation}`,
      `  Fired: ${doc.firedAt}  Service: ${doc.service ?? 'n/a'}`,
      '',
    );
  }

  return lines.join('\n');
}

function formatExplain(data: ExplainData): string {
  const n = data.narrative;
  return [
    `Explanation for ${data.service ?? 'all services'} (source: ${n.source}):`,
    '',
    `Summary:     ${n.summary}`,
    `Explanation: ${n.explanation}`,
    '',
    'Next actions:',
    ...n.actions.map((a, i) => `  ${String(i + 1)}. ${a}`),
  ].join('\n');
}

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
