---
name: loops-filecointldr-builder-challenge-cycle-2
description: >-
  Build for the FilecoinTLDR Builder Challenge - Cycle 2 hackathon on Loops House: ideate with the AI
  mentor, query sponsor knowledge graphs (graph-RAG over their docs), create
  and update the project submission, save ideation artifacts, and evaluate the
  project against each sponsor's judging criteria. Use this skill whenever the
  user mentions FilecoinTLDR Builder Challenge - Cycle 2, this hackathon, its sponsors or bounties,
  submitting or improving their hackathon project, sponsor docs/SDKs, judging,
  or asks "what should I build" — even if they never say "loops".
requires_bin: loops
---

# FilecoinTLDR Builder Challenge - Cycle 2 — Loops House skill

You are helping a builder compete in ONE hackathon: `filecointldr-builder-challenge-cycle-2`. This skill carries everything you need — the event data, ready-to-run `loops` commands, and the workflow below. Commands are pre-filled with the right slugs; only replace `<angle-bracket>` placeholders. Never invent or substitute ids: a user has at most one project per hackathon (being a team member counts), so the platform always resolves *their* project from the session — no project id exists anywhere in this skill.

The user has no project here yet. Create one with `loops project create` when they're ready to submit; until then, ideate freely.

## How to work

Follow this sequence — each step's output feeds the next:

1. **Check auth** with `loops auth status` before any other command or at the start of a session. Sessions expire; assuming one exists wastes the user's time on confusing failures.
2. **Orient**: read the event data below (stage, deadlines, sponsors). Run `loops project get --hackathonSlug filecointldr-builder-challenge-cycle-2` to see where the user's submission stands.
3. **Ideate or research**: brainstorm with the mentor (`hackathon ideate`) and ground sponsor-specific facts with `knowledge query` — never assert what a sponsor's SDK does from memory when you can cite their knowledge graph.
4. **Persist**: save promising directions as artifacts; create or update the submission as the project takes shape.
5. **Evaluate before the deadline**: run `loops evaluate` per targeted sponsor and act on the feedback — that's what the judges will probe.

Command outputs are structured (add `--json` for machine-readable form) and often end with a **suggested next command (CTA)** — prefer following it over guessing. On `NOT_AUTHENTICATED`, run the auth flow; on `credits_exhausted`, stop and tell the user (don't retry).

## Authentication

```sh
loops auth status                        # run FIRST — who am I?
```

If not authenticated, the CLI isn't installed-and-logged-in yet. Install once with `npm install -g loopshouse`, then offer the user these login options:

- **Google**: `loops auth login --provider google` — opens the browser.
- **GitHub**: `loops auth login --provider github` — opens the browser.
- **Email one-time code**: `loops auth login --email <you@example.com>` sends a 6-digit code, then `loops auth verify --email <you@example.com> --code <123456>`.

In headless contexts the browser flows print a URL for a human to open. Re-run `loops auth status` to confirm before continuing.

## Event & sponsor data

Your ground truth for this event, as one TOON document (TOON = compact JSON: `key: value` lines; a uniform array renders as a `name[N]{col1,col2,…}:` header followed by one comma-separated row per element):

```toon
hackathon:
  slug: filecointldr-builder-challenge-cycle-2
  name: FilecoinTLDR Builder Challenge - Cycle 2
  tagline: Filecoin TL;DR aims to simplify Filecoin ecosystem news.
  theme: null
  stage: registration_open
  stageMeaning: Registration open — enroll and start ideating
  timezone: UTC
  startsAt: "Jul 6, 2026, 12:00 AM (UTC)"
  submissionDeadline: "Jul 10, 2026, 11:59 PM (UTC)"
  registrationDeadline: "Jul 3, 2026, 11:59 PM (UTC)"
  description: "FilecoinTLDR Builder Challenges is a series of AI-guided mini hackathons for non-builders, first-time builders, and builders of all experience levels. **The goal is simple: Use AI to hack together a working prototype while leveraging the Filecoin stack.** Participants will use tools like **Claude Code**, along with provided markdown files and prompting frameworks, to brainstorm, plan, build, debug, and ship small Filecoin-powered prototypes. This is not about following a fixed tutorial or building the same app as everyone else. Each challenge gives participants a clear theme, but leaves room for creativity. The goal is to build something small, working, and memorable where Filecoin is part of the product experience, not just hidden backend storage. Have a question or stuck on your build? Join the Discord Channel: [FilecoinTLDR Builder Challenges](https://discord.gg/rAC3jBXQrh) **Program goal** The goal of FilecoinTLDR Builder Challenges is to help more people start building with Filecoin by using AI as their build partner. Each challenge is: - AI-guided – participants use Claude Code and provided markdown files to plan and build - hands-on – participants create a real working demo - focused – each challenge has one clear theme or build direction - practical – projects should be small enough to build in a short sprint - showcase-driven – participants share what they built publicly **[Completed]Cycle 1 Challenge Task: Build a Filecoin-Powered Mini App With One Clear Mechanic** …"
sponsors[1]:
  - slug: filecointldr
    name: FilecoinTLDR
    tier: null
    prizePoolUsd: 250
    tagline: null
    website: "https://filecointldr.io/"
    description: "Filecoin TL;DR aims to simplify Filecoin ecosystem news. FilecoinTLDR Builder Challenges are a series of mini hackathons for non-builders and builders of all experience levels. Filecoin TLDR Builder Challenge Cycle 2: Build an AI Agent That Uses Filecoin Core Idea: Build an agent, agent workflow, or agent tool that uses Filecoin for memory, logs, datasets, proofs, or storage."
    requirements[3]: "Submissions should include a project title, short description, live demo link, repo link, a short explanation of how the app uses FOC / the Filecoin stack, and a link to a public X post sharing what was built.","Since this challenge is focused on building an AI agent that uses Filecoin with clear mechanic, submissions should also explain the Agent’s main mechanic and how the agent, agent workflow, or agent tool use Filecoin for memory, logs, datasets, proofs, or storage. Participants should include a short AI build log describing how they used AI to brainstorm, plan, build, or debug their prototype.","The X post must include the live demo link, either a screenshot or short demo video, and tag @Filecoin and @FilecoinTLDR."
    bounties[3]{name,amountUsd,description}:
      1st Prize,125,"Winners will receive rewards in USDFC (a stablecoin on the Filecoin network), which can be converted to FIL upon receipt."
      2nd Prize,75,"Winners will receive rewards in USDFC (a stablecoin on the Filecoin network), which can be converted to FIL upon receipt."
      3rd Prize,50,"Winners will receive rewards in USDFC (a stablecoin on the Filecoin network), which can be converted to FIL upon receipt."
    judgingCriteria[5]{name,weightPercent,description}:
      Meaningful use of Filecoin,30,"Does the project actually use Filecoin, FOC, Synapse SDK, PDP, retrieval, storage, payments, or another relevant Filecoin primitive in a meaningful way?"
      Working demo quality,25,Does the app or prototype work? Can judges see the core flow clearly? Is it more than a mockup or fake demo?
      Creativity / usefulness of the idea,20,"Is the idea interesting, memorable, useful, or novel? Does it avoid being just another “upload a file” app?"
      AI-guided build process,10,"Did the participant use AI meaningfully to brainstorm, plan, build, debug, or structure the project?"
      Clarity of explanation + public showcase,15,"Is the project easy to understand? Is the X post, demo video, README, or submission explanation clear and compelling?"
```

Mind `hackathon.stage` and the deadlines: they are snapshots from when the skill was generated and don't update — sanity-check timing before planning multi-day work.

## Credits

**1 credit = one ideator turn OR one knowledge-graph query.** Everything else (project/artifact commands, the evaluator prompt) is free. Spend credits on load-bearing questions, not browsing — and check the balance when planning a research burst:

```sh
loops credits --hackathonSlug filecointldr-builder-challenge-cycle-2
```

## Ideate with the AI mentor

The mentor knows this hackathon's live sponsors, bounties, and judging criteria. Conversations persist locally per hackathon (`~/.loops/sessions/`) and continue automatically — each call just sends one more message, so ask follow-ups freely instead of cramming everything into one prompt.

```sh
loops hackathon ideate --hackathonSlug filecointldr-builder-challenge-cycle-2 -m "<your prompt>"
loops hackathon ideate --hackathonSlug filecointldr-builder-challenge-cycle-2 -m "<follow-up>"               # same conversation
loops hackathon ideate --hackathonSlug filecointldr-builder-challenge-cycle-2 --withProject -m "<prompt>"    # mentor sees the user's project
loops hackathon ideate --hackathonSlug filecointldr-builder-challenge-cycle-2 --new -m "<fresh start>"       # discard the session first
loops hackathon session --hackathonSlug filecointldr-builder-challenge-cycle-2            # show the stored conversation (--clear to delete)
```

Use `--withProject` once a project exists — feedback grounded in what's actually built beats generic advice.

## Sponsor knowledge graphs (graph-RAG)

Each sponsor above has a knowledge graph built from their docs, SDKs, and bounty materials. A query returns a **cited evidence block** (entities, relationships, chunks, sources) — read the evidence and compose the answer yourself, citing it. This is how you avoid hallucinating sponsor APIs. 1 credit per query. One ready command per sponsor:

```sh
# FilecoinTLDR
loops knowledge query --hackathonSlug filecointldr-builder-challenge-cycle-2 -s filecointldr -q "<your question about FilecoinTLDR>"
```

## Manage the project

A project IS the submission, the user has at most one here, and the platform resolves it from the session — no ids, no listings.

```sh
loops project get --hackathonSlug filecointldr-builder-challenge-cycle-2       # current state (exists=false if none yet)
loops project create --hackathonSlug filecointldr-builder-challenge-cycle-2 --name "<name>" --repoUrl <url> --tagline "<one-liner>"
loops project update --hackathonSlug filecointldr-builder-challenge-cycle-2 --description "<new description>"
```

**Update is a PATCH**: only the fields you pass change — an update with just `--tagline` cannot wipe the repo URL or bounty picks. Available fields: `--name`, `--tagline`, `--pitch`, `--description`, `--repoUrl`, `--demoUrl`, `--videoUrl`, `--bountyIds <id> --bountyIds <id>`.

## Ideation artifacts (scratchpad)

Persist ideas, problems, and tech-stack notes against this hackathon — they appear in the user's web playground too, so save anything worth keeping rather than letting it die in the conversation. Kinds: `idea`, `problem`, `tech-stack`, `note`.

```sh
loops artifact list --hackathonSlug filecointldr-builder-challenge-cycle-2
loops artifact save --hackathonSlug filecointldr-builder-challenge-cycle-2 --name "<title>" --kind idea --body "<markdown body>"
loops artifact update --hackathonSlug filecointldr-builder-challenge-cycle-2 --id <artifactId> --body "<updated markdown>"
loops artifact remove --hackathonSlug filecointldr-builder-challenge-cycle-2 --id <artifactId>
```

## Evaluate the project against a sponsor

Fetch a self-contained evaluator prompt for one sponsor (free; the user's project record is included automatically), then **execute the prompt yourself inside the project repo** — it assumes the code access you have. It walks that sponsor's judging criteria and bounty requirements and produces alignment feedback: what's genuinely strong, what's missing, where to focus. Run it for every sponsor the project targets, well before the deadline.

```sh
loops evaluate --hackathonSlug filecointldr-builder-challenge-cycle-2 -s <sponsorSlug>
```

Take sponsor slugs from the TOON data above. Report the feedback to the user, then reflect agreed improvements via `loops project update`.
