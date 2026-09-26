type Replacer = (match: string, groups: Array<string | undefined>) => string | null;

interface Rule {
  name: string;
  pattern: RegExp;
  replacer?: Replacer;
}

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PUBLIC_IDENTIFIER =
  /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:price|prod|cus|sub|pi|in|sb_publishable)_[A-Za-z0-9_]+)$/i;

const rule = (name: string, pattern: RegExp, replacer?: Replacer): Rule => ({ name, pattern, replacer });

const RULES: Rule[] = [
  rule('private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g),
  rule('url_credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, (_m, g) => `${g[0]}[REDACTED:url_credentials]@`),
  rule('stripe_secret', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g),
  rule('stripe_webhook_secret', /\bwhsec_[A-Za-z0-9]{16,}/g),
  rule('supabase_secret', /\bsb_secret_[A-Za-z0-9_-]{16,}/g),
  rule('anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g),
  rule('openai_key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g),
  rule('github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g),
  rule('apify_token', /\bapify_api_[A-Za-z0-9]{20,}/g),
  rule('aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g),
  rule('google_api_key', /\bAIza[0-9A-Za-z_-]{35}/g),
  rule('slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g),
  rule('jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  rule('bearer', /\b(Bearer)\s+(?!\[REDACTED:)[A-Za-z0-9._~+/=-]{20,}/g, (_m, g) => `${g[0]} [REDACTED:bearer]`),
  rule(
    'assignment',
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[:=]\s*)(["']?)([^\s"'&,;]{6,})\3/gi,
    (_m, g) => (g[3]?.startsWith('[REDACTED:') || /^\d+$/.test(g[3] ?? '') ? null : `${g[0]}${g[1]}${g[2]}[REDACTED:assignment]${g[2]}`),
  ),
  rule(
    'high_entropy',
    /\b((?:key|token|secret|password|bearer|credential)s?)\b([^\n]{0,40}?)([A-Za-z0-9_\-+/=]{32,})/gi,
    (_m, g) => {
      const candidate = g[2] ?? '';
      if (PUBLIC_IDENTIFIER.test(candidate) || shannonEntropy(candidate) < 4.0) return null;
      return `${g[0]}${g[1]}[REDACTED:high_entropy]`;
    },
  ),
];

export function redact(input: string): { text: string; findings: Record<string, number> } {
  let text = input;
  const findings: Record<string, number> = {};
  for (const { name, pattern, replacer } of RULES) {
    text = text.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as Array<string | undefined>;
      const replacement = replacer ? replacer(match, groups) : `[REDACTED:${name}]`;
      if (replacement === null) return match;
      findings[name] = (findings[name] ?? 0) + 1;
      return replacement;
    });
  }
  return { text, findings };
}

export function redactValue<T>(value: T, findings: Record<string, number>): T {
  if (typeof value === 'string') {
    const result = redact(value);
    for (const [name, count] of Object.entries(result.findings)) findings[name] = (findings[name] ?? 0) + count;
    return result.text as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, findings)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, findings);
    return out as T;
  }
  return value;
}
