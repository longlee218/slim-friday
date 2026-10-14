import { describe, expect, test } from "bun:test";
import { MASK, redactDeep, redactText, safePreview, truncate } from "../src/observability/redact";

// Fake secrets assembled at runtime so no real-looking literal sits in the location.
const cases: [string, string][] = [
  ["anthropic", "sk-ant-" + "api03-abcdefghijklmnopqrstuv"],
  ["oauth", "sk-ant-" + "oat01-ABCDEFGH12345678_-xyz"],
  ["github pat", "ghp_" + "a".repeat(36)],
  ["github fine", "github_pat_" + "A1b2C3d4E5".repeat(4)],
  ["slack", "xoxb-" + "1234567890-abcdefghij"],
  ["aws", "AKIA" + "ABCDEFGHIJKLMNOP"],
  ["discord", "MTA" + "x".repeat(21) + "." + "abcdef" + "." + "y".repeat(30)],
];

describe("redactText", () => {
  for (const [name, secret] of cases) {
    test(`masks ${name}`, () => {
      const out = redactText(`before ${secret} after`);
      expect(out).not.toContain(secret);
      expect(out).toContain(MASK);
    });
  }
  test("masks Bearer token", () => {
    expect(redactText("Authorization: Bearer abc.def-123456")).not.toContain("abc.def-123456");
  });
  test("masks env-style KEY=value but keeps the name", () => {
    const out = redactText("DB_PASSWORD=hunter2hunter2\nAPI_KEY: 'zzz999'");
    expect(out).toContain("DB_PASSWORD=" + MASK);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("zzz999");
  });
  test("masks PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redactText(pem)).toBe(MASK);
  });
  test("fake key inside a file-like string", () => {
    const file = `const a = 1;\nconst key = "${cases[0]![1]}";\nexport {a}`;
    expect(redactText(file)).not.toContain("api03");
  });
  test("leaves normal text alone", () => {
    expect(redactText("see src/a.ts:12 for details")).toBe("see src/a.ts:12 for details");
  });
});

describe("redactDeep / truncate", () => {
  test("masks nested strings and sensitive keys", () => {
    const out = redactDeep({ a: [cases[2]![1]], token: "plain", n: 1 });
    expect(JSON.stringify(out)).not.toContain("ghp_");
    expect(out.token).toBe(MASK);
    expect(out.n).toBe(1);
  });
  test("truncate caps bytes", () => {
    expect(Buffer.byteLength(truncate("x".repeat(10_000), 4096))).toBeLessThan(4200);
    expect(truncate("short")).toBe("short");
  });
  test("safePreview redacts then truncates", () => {
    const out = safePreview({ k: cases[0]![1] });
    expect(out).not.toContain("sk-ant-");
  });
});

describe("redaction gaps (H2)", () => {
  test("JSON-quoted keys", () => {
    const out = redactText('{"password":"hunter2","api_key":"abcdef123"}');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abcdef123");
  });
  test("lowercase names and unquoted yaml style", () => {
    const out = redactText("db_password = foo123\nauth_token: 'bar456'\napi_key: y789");
    for (const v of ["foo123", "bar456", "y789"]) expect(out).not.toContain(v);
  });
  test("URL credentials", () => {
    const out = redactText("DATABASE at postgres://admin:s3cretpw@db.local:5432/app ok");
    expect(out).not.toContain("s3cretpw");
    expect(out).toContain("db.local");
  });
  test("safePreview masks sensitive keys in objects and JSON", () => {
    const out = safePreview({
      file_text: 'password: "hunter2"',
      password: "plainvalue",
      nested: { api_key: "k123456" },
    });
    for (const v of ["hunter2", "plainvalue", "k123456"]) expect(out).not.toContain(v);
  });
  test("circular objects do not throw", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(safePreview(a)).toContain("[Circular]");
  });
  test("unserializable values do not throw", () => {
    expect(safePreview({ n: 10n })).toBe("[unserializable]");
  });
  test("no false positives: file:line, urls without creds, ports", () => {
    for (const t of [
      "see src/a.ts:12 and lib/b.ts:7:3",
      "https://example.com/path:80",
      "token count is high",
      "key: value",
    ])
      expect(redactText(t)).toBe(t);
  });
});

describe("command credentials (review M2)", () => {
  const masked = (text: string, secret: string) => {
    const out = redactText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(MASK);
  };
  test("curl -u / --user user:pass", () => {
    masked("curl -u admin:hunter2 https://h/x", "hunter2");
    masked("curl --user 'admin:hunter2' https://h/x", "hunter2");
    masked("curl --user=admin:hunter2 https://h/x", "hunter2");
  });
  test("Authorization headers in any case and scheme", () => {
    masked("curl -H 'Authorization: Basic dXNlcjpwYXNz' https://h", "dXNlcjpwYXNz");
    masked('curl -H "authorization: Token abc123def456" https://h', "abc123def456");
    masked("AUTHORIZATION: Bearer abcdefghijkl", "abcdefghijkl");
    masked("authorization: rawvalue99", "rawvalue99");
  });
  test("X-Api-Key and Cookie headers", () => {
    masked("curl -H 'x-api-key: k-123456' https://h", "k-123456");
    masked("curl -H 'X-Api-Key: k-123456' https://h", "k-123456");
    masked("curl -H 'Cookie: sid=abc; other=def' https://h", "sid=abc");
  });
  test("query params, env assignments, URL credentials", () => {
    masked("curl 'https://h/x?token=abc123&a=1'", "abc123");
    masked("curl 'https://h/x?a=1&password=pw12345'", "pw12345");
    masked("SECRET=topsecret1 ./run.sh", "topsecret1");
    masked("git clone https://user:pass123@github.com/o/r", "pass123");
  });
  test("low false positives: plain commands stay readable", () => {
    for (const t of [
      "ls -u foo",
      "git log -u src/a.ts",
      "tar -u -f a.tar b",
      "grep -r cookie src",
      "echo authorization is required",
    ])
      expect(redactText(t)).toBe(t);
  });
});
