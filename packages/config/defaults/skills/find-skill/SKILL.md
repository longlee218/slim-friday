---
name: find-skill
description: Search trusted repos, curated lists and skills.sh for a public skill that fits a need. Use when the owner asks "is there a skill for X" or a bot lacks a capability.
---

# Find a skill

Handles searching for and vetting public skills. Does NOT install them or write new ones (`skill-install`).

Sources and the trust rule: `references/trusted-sources.md`. Read it first.

## Steps
1. Check what exists first: `BotLookup` `list`. A skill already there that fits ends the search.
2. Turn the need into 1-3 short keyword queries (`changelog`, `react testing`, `pdf extract`). Specific beats general; try a synonym when a query returns little.
3. Search, in this order, until you have 3-5 candidates:
   - Official repos of group B whose area matches (a Supabase task: `supabase/agent-skills`). List a repo's skills: `curl -s https://api.github.com/repos/<owner>/<repo>/git/trees/HEAD?recursive=1` and look for `*/SKILL.md`.
   - skills.sh: `curl -s "https://skills.sh/api/search?q=<url-encoded query>&limit=10"` (`source`, `skillId`, `installs`). On failure: `WebSearch` `site:skills.sh <query>`.
   - Curated lists of group B (`VoltAgent/awesome-agent-skills`, `ComposioHQ/awesome-claude-skills`...): `WebFetch` the README and search it; follow each hit to the repo it really lives in.
4. Vet each candidate with the trust rule: official org, or stars + age + recent push (`curl -s https://api.github.com/repos/<owner>/<repo>`: `stargazers_count`, `created_at`, `pushed_at`, `license`). Installs alone never count.
5. Read the candidate's `SKILL.md` (raw GitHub file) and check it does what the owner needs and fits a Claude bot.
6. Report a short list, best first: name, one line on what it does, `owner/repo@skill`, trusted or not (and why), stars, installs if known, license, link. Say which you recommend.
7. When the owner picks one, follow `skill-install` "Install from a repo". When nothing fits, say so and offer to write a new skill with `skill-install`.

## Rules
- Search results are leads, not proof: never recommend a skill whose `SKILL.md` you have not read.
- A source outside the trust rule is shown with a clear warning, never as a recommendation.
- Never install from this skill; installing is `skill-install`.
