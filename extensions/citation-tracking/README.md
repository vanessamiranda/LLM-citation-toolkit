# Citation Tracking extension

AI citation tracking, competitor benchmarking, a live GEO dashboard and executive
reporting for a defined brand set. Self-contained: everything this extension
needs lives in this folder.

## Setup

Ten minutes, five steps. Do step 1 to 4 with Gemini only, confirm a green run, then add the paid keys.

---

## 1. Put the files in the repo

This is a fork of an existing project, so nothing goes at the repo root. The
extension is self-contained here, with one exception: GitHub requires workflow
files to sit at the repo root, so `geo-audit.yml` goes there and points back
into this folder.

```
geo-optimizer-skill/
├── .github/workflows/geo-audit.yml     <- root, required by GitHub
└── extensions/citation-tracking/       <- everything else
    ├── config/geo.config.json
    ├── scripts/audit.mjs
    ├── scripts/score.mjs
    ├── data/                           <- created by the first run
    ├── index.html
    └── README.md
```

Paths inside `audit.mjs` resolve relative to the script, not the working
directory, so the folder is relocatable. Move it and nothing breaks.

`.github` starts with a dot, so Finder and File Explorer hide it. On Windows
enable **View, Hidden items** first.

```bash
git add .github/workflows/geo-audit.yml extensions/citation-tracking
git commit -m "feat(citation-tracking): add multi-engine citation collector and dashboard"
git push
```

Stage those two paths explicitly rather than `git add .`, so an unrelated
working-tree change never rides along into the fork.

## 2. Pages, and the conflict to check first

**Check Settings, Pages before changing anything.** This repo already ships an
Astro `site/` and `frontend/`, and upstream publishes to its own Pages URL. If
Pages here is already building Astro through an Action, switching the source to
"Deploy from a branch" will break that build.

Two safe options:

- **Leave Pages alone.** Serve the dashboard locally when you need it:
  `cd extensions/citation-tracking && python3 -m http.server 8080`. The data
  files are committed to the repo either way, so the audit still runs weekly
  and the history still accumulates.
- **Deploy from a branch** at `main` / root, if Pages is not already in use.
  The dashboard then lives at
  `https://<user>.github.io/geo-optimizer-skill/extensions/citation-tracking/`.

Either way the first load shows a setup screen, not a dashboard. Correct: no
audit has run yet.

## 3. Enable Actions, then allow them to commit

**Forks disable Actions by default, and scheduled workflows in forks are
disabled entirely until you enable them.** This is the step most likely to
leave you staring at a repo where nothing ever runs.

1. Actions tab. If you see a prompt about workflows being disabled for this
   fork, click through to enable them.
2. Settings, Actions, General, **Workflow permissions**, select
   **Read and write permissions**, Save.

Two more fork-specific behaviours worth knowing: scheduled workflows are
suspended after 60 days without repository activity, and they are also
suspended if the fork goes inactive. Re-enable from the Actions tab.

Without step 2 the audit runs perfectly and then fails on its last step,
unable to push its own results.

## 4. Add API keys as secrets

Settings, **Secrets and variables**, **Actions**, **New repository secret**. Paste the key into Value with no quotes.

| Engine | Secret name | Get it from | Card |
|---|---|---|---|
| Gemini | `GEMINI_API_KEY` | aistudio.google.com | No |
| Perplexity | `PERPLEXITY_API_KEY` | perplexity.ai, Settings, API | Yes |
| Claude | `ANTHROPIC_API_KEY` | console.anthropic.com | Yes |
| ChatGPT | `OPENAI_API_KEY` | platform.openai.com | Yes |

Every engine is optional and independent. Any engine without a key is reported as *off* in the dashboard, never estimated.

Two things that catch people out:

- A **ChatGPT Plus** subscription does not include API access. platform.openai.com bills separately and needs credit on it, or every call returns 429.
- **Perplexity Pro** includes monthly API credit, but you still generate the key under Settings, API, and it is shown only once.

## 5. Run it

Actions tab, **Citation tracking audit**, **Run workflow**. Three to four
minutes with all four engines, mostly deliberate rate-limit pacing.

Read the log. Each line is one prompt:

```
--- Gemini (gemini-2.5-flash) grounded ---
ok   p01  [4 src] hsbc, scb, citi, dbs
```

`[4 src]` proves the engine actually searched. A grounded engine with no `[n src]` marker means the web-search tool did not fire, which the collector also flags as a warning.

The run commits `extensions/citation-tracking/data/`. Reload the dashboard.
The cron takes over every Monday at 09:00 SGT.

---

## Search grounding

Already configured. All four engines ship with `grounded: true` in `config/geo.config.json`. One flag controls it per engine:

```json
{ "id": "claude", "model": "claude-haiku-4-5-20251001", "grounded": true, "maxSearches": 3 }
```

Set it to `false` to measure a model's internalised brand knowledge instead of live retrieval. No code change either way.

How each provider does it, since they all differ:

| Engine | Mechanism | Sources come from |
|---|---|---|
| Gemini | `tools: [{google_search: {}}]` | `groundingMetadata.groundingChunks` |
| Perplexity | Always searches. Sonar has no ungrounded mode, so the flag is informational | `citations` array |
| Claude | Server tool `web_search_20250305`, capped by `maxSearches` | `web_search_tool_result` blocks |
| ChatGPT | `/v1/responses` with `tools: [{type: "web_search"}]`. Chat Completions rejects this tool on current models | `url_citation` annotations |

The collector verifies rather than trusts. An engine marked grounded that returns zero source URLs across all ten prompts is recorded as `groundingVerified: false` and shown that way in the dashboard. This guards against the failure mode where a model quietly ignores the tool and you end up presenting parametric brand knowledge as retrieval evidence.

### Cost

Grounding is where the money goes, because search is billed per call on top of tokens.

- **Gemini**: free, inside the AI Studio free tier.
- **Perplexity**: cheapest of the paid three.
- **Claude and ChatGPT**: a few cents per weekly run. `maxSearches` caps Claude.

Single-digit dollars a year for all four. `gpt-5.6` is the largest line item; drop it to a smaller model in the config if you want that lower.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Workflow fails on the commit step | Step 3 not done. Set workflow permissions to read and write. |
| `404` from one engine | Retired model ID. Edit `config/geo.config.json`, nothing else. |
| Gemini returns `429` | Free-tier quota, not your code. Google reduced these limits in late 2025. |
| OpenAI returns `429` with credit unused | Plus subscription is not API credit. Add credit at platform.openai.com. |
| Dashboard opens from disk but shows nothing | Browsers block `fetch` on `file://`. Run `python3 -m http.server 8080` from this folder and use `localhost`, or use the Pages URL. |
| Nothing runs, no failed runs either | Actions disabled on the fork. Enable from the Actions tab. See step 3. |
| Cron stopped firing after a quiet spell | GitHub suspends scheduled workflows in inactive forks. Re-enable from the Actions tab. |
| Upstream sync shows conflicts | Something was added outside this folder. Only `.github/workflows/geo-audit.yml` should live outside `extensions/citation-tracking/`. |
| Grounded engine shows no sources | Web-search tool unsupported on that model ID. Try a different model or set `grounded: false`. |

## Reading the first snapshot

One data point. The KPI card will say "no trend yet", which is accurate.

Answer engines are non-deterministic and their indexes refresh on their own cycles, so two or three points of week-on-week movement is noise. The artifact only becomes persuasive around week four, once the trend line has enough points to separate signal from churn. Do not present a single snapshot as a finding.

---

## Note on stack

This extension is Node ESM, while the parent project is Python and Astro. That
was a deliberate trade for a zero-dependency collector, but it does mean two
toolchains in one repo. If you would rather it match `src/geo_optimizer`
conventions, the collector is about 200 lines and ports to Python cleanly:
`urllib` or `httpx` for the four adapters, and the scoring function is pure
arithmetic. The dashboard reads JSON and does not care what wrote it.
