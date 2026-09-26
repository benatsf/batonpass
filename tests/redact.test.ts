import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactValue, shannonEntropy } from '../src/redact.ts';

// Secret-shaped values are assembled at runtime so no literal is committed.
const body = (n: number) => Array.from({ length: n }, (_, i) => 'aB3dE5fG7hJ9kL2mN4pQ6rS8tUvWxYz'[(i * 7) % 31]).join('');
const cases: Array<[string, string]> = [
  ['stripe_secret', 'sk_' + 'live_' + body(24)],
  ['stripe_secret', 'rk_' + 'test_' + body(24)],
  ['stripe_webhook_secret', 'whsec_' + body(24)],
  ['supabase_secret', 'sb_' + 'secret_' + body(24)],
  ['anthropic_key', 'sk-' + 'ant-' + body(30)],
  ['openai_key', 'sk-' + 'proj-' + body(30)],
  ['github_token', 'gh' + 'p_' + body(36)],
  ['apify_token', 'apify' + '_api_' + body(30)],
  ['aws_access_key', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'],
  ['google_api_key', 'AI' + 'za' + body(35)],
  ['slack_token', 'xo' + 'xb-' + body(24)],
  ['jwt', 'ey' + 'J' + body(20) + '.' + 'ey' + body(20) + '.' + body(20)],
];

for (const [rule, secret] of cases) {
  test(`redacts ${rule}`, () => {
    const { text, findings } = redact(`value: ${secret} end`);
    assert.ok(!text.includes(secret), text);
    assert.match(text, new RegExp(`\\[REDACTED:${rule}\\]`));
    assert.equal(findings[rule], 1);
  });
}

test('redacts PEM private keys, URL credentials, bearer tokens and assignments', () => {
  const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----';
  const input = [
    pem,
    'postgres://admin:' + 'hunter2pass@db.example.com:5432/app',
    'Authorization: Bearer ' + body(40),
    'password = "' + 'correct-horse-battery' + '"',
  ].join('\n');
  const { text, findings } = redact(input);
  assert.match(text, /\[REDACTED:private_key\]/);
  assert.match(text, /postgres:\/\/\[REDACTED:url_credentials\]@db\.example\.com/);
  assert.match(text, /Bearer \[REDACTED:bearer\]/);
  assert.match(text, /password = "\[REDACTED:assignment\]"/);
  assert.equal(findings.private_key, 1);
});

test('redacts a high-entropy value next to a secret keyword', () => {
  const token = 'Qx7' + 'Lp2Zr9Vt4Kw8Mn3Bs6Hy1Jd5Fg0Ce2Au';
  const { text } = redact(`the deploy token is ${token}`);
  assert.match(text, /\[REDACTED:high_entropy\]/);
});

test('keeps public identifiers and ordinary text intact', () => {
  const keep = [
    'price_1UCDaVGzwHv4lPx9JH9ZRsDk',
    'sb_publishable_of0Jw6EGYSrVinqus1OImA_46R2KfoQ publishable key',
    'commit 541849081a3c4b5d6e7f8a9b0c1d2e3f4a5b6c7d token',
    'session 01a047e4-a867-7e41-ba95-85ce29ade72a',
    'max_tokens: 2000 and tokens: 5',
    'Merged PR #51 into main.',
  ];
  for (const line of keep) assert.equal(redact(line).text, line);
});

test('is idempotent', () => {
  const once = redact('key: ' + 'sk_' + 'live_' + body(24)).text;
  assert.equal(redact(once).text, once);
});

test('redactValue scrubs nested strings', () => {
  const findings: Record<string, number> = {};
  const out = redactValue({ args: ['--token', 'gh' + 'p_' + body(36)], n: 3 }, findings);
  assert.deepEqual(out.args[0], '--token');
  assert.match(String(out.args[1]), /\[REDACTED:github_token\]/);
  assert.equal(out.n, 3);
  assert.equal(findings.github_token, 1);
});

test('shannonEntropy distinguishes random from repetitive text', () => {
  assert.ok(shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') < 1);
  assert.ok(shannonEntropy('Qx7Lp2Zr9Vt4Kw8Mn3Bs6Hy1Jd5Fg0Ce') > 4);
});

test('redacts env-style, JSON, camelCase and command-line secret assignments', () => {
  const pw = 'Xk9' + 'mQ2vLp7w';
  const lines: Array<[string, string]> = [
    ['DATABASE_PASSWORD=' + pw, 'DATABASE_PASSWORD=[REDACTED:assignment]'],
    ['export NEXTAUTH_SECRET=' + body(32), 'export NEXTAUTH_SECRET=[REDACTED:assignment]'],
    ['TYPESAFE_API_KEY=' + body(24), 'TYPESAFE_API_KEY=[REDACTED:assignment]'],
    ['{"password": "' + pw + '"}', '{"password": "[REDACTED:assignment]"}'],
    ['const stripeApiKey = "' + body(20) + '";', 'const stripeApiKey = "[REDACTED:assignment]";'],
    ['supabase link --password ' + pw, 'supabase link --password [REDACTED:assignment]'],
    ['gh auth login --with-token=' + body(20), 'gh auth login --with-token=[REDACTED:assignment]'],
  ];
  for (const [input, expected] of lines) assert.equal(redact(input).text, expected, input);
});

test('keeps variable references and ordinary words next to secret names', () => {
  for (const line of ['DATABASE_PASSWORD=$DATABASE_PASSWORD', 'apiKey: process.env.API_KEY', 'token=${TOKEN}', 'the token rotated successfully', 'max_tokens: 2000']) {
    assert.equal(redact(line).text, line);
  }
});

test('redacts a private key block that was cut before its END line', () => {
  const cut = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + body(64) + '\n' + body(64);
  const { text } = redact(`Write key.pem ${cut}`);
  assert.equal(text, 'Write key.pem [REDACTED:private_key]');
});
