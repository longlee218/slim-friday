# Trusted sources

Shared by `find-skill`, `skill-install` and `bot-design`. Checked 2026-10-24 (stars, last push, license); re-check stars and last push before you rely on one (`curl -s https://api.github.com/repos/<owner>/<repo>`).

## Trust rule
1. Official org of a known vendor (`anthropics`, `openai`, `microsoft`, `vercel-labs`, `cloudflare`, `supabase`, `getsentry`, `prisma`, `trailofbits`) → trusted.
2. Otherwise: 1000+ stars AND repo older than 6 months AND pushed in the last 6 months → trusted.
3. skills.sh installs are a weak signal only: some sources show millions of installs with under 500 stars or a repo a few weeks old. Never trust on installs alone.
4. Anything else: allowed only with a clear warning to the owner ("not from a trusted source: <why>").
5. Always read the files before recommending or installing, whatever the source.

## A. Role prompts (for writing bot instructions)
Read the closest role, take the ideas, rewrite in the shape of `bot-design/references/system-prompt.md`. Never copy a whole prompt.
| Repo | Stars | License | Use |
|---|---|---|---|
| `wshobson/agents` | 41k | MIT | 92 plugins by area (`plugins/<area>/agents/*.md`): backend, review, security, data, docs... |
| `VoltAgent/awesome-claude-code-subagents` | 26k | MIT | 100+ subagents in `categories/` (core dev, languages, infra, quality-security, data-ai, business, research) |
| `anthropics/claude-cookbooks` | 54k | MIT | Official patterns (agents, tool use, prompts) |
| `anthropics/prompt-eng-interactive-tutorial` | 39k | — | Official prompt techniques |
| `dair-ai/Prompt-Engineering-Guide` | 79k | MIT | General techniques |

## B. Skills
| Kind | Repo | Stars | Notes |
|---|---|---|---|
| Official | `anthropics/skills` | 183k | Documents, design, skill-creator |
| Official | `vercel-labs/agent-skills` | 33k | React, Next.js, web design |
| Official | `openai/skills` | 28k | Codex skills (check they fit Claude) |
| Official | `microsoft/skills`, `microsoft/azure-skills` | 3k, 2k | Microsoft SDKs, Azure |
| Official | `cloudflare/skills` | 3k | Cloudflare |
| Official | `supabase/agent-skills` | 3k | Supabase |
| Official | `getsentry/skills` | 1k | Sentry dev workflow |
| Official | `prisma/skills` | <100 | Prisma (official org, low stars) |
| Official | `trailofbits/skills` | 8k | Security research; license CC-BY-SA-4.0 (tell the owner) |
| Person | `obra/superpowers` | 305k | Dev process: brainstorm, plans, TDD, debugging, review |
| Person | `mattpocock/skills` | 302k | TypeScript and dev skills |
| List | `VoltAgent/awesome-agent-skills` | 36k | 1000+ skills from official teams: search here, install from the original repo |
| List | `ComposioHQ/awesome-claude-skills` | 78k | Curated list: search, then vet the original repo |
| List | `hesreallyhim/awesome-claude-code` | 56k | Skills, agents, hooks, MCP |
| List | `travisvn/awesome-claude-skills` | 16k | Curated list |

A list repo is for finding skills; install from the repo a skill really lives in, after vetting that repo with the trust rule.

## C. skills.sh
- Search: `curl -s "https://skills.sh/api/search?q=<query>&limit=10"` → `source`, `skillId`, `installs`.
- Page: `https://skills.sh/<source>/<skillId>`.
- Install with the `skills` CLI (see `skill-install`). The API is not documented and may change: fall back to `WebSearch site:skills.sh <query>`.
