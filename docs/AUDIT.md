# Phase 0 audit — Instagram growth dashboard (@rayeschiller)

Date: 2026-11-13. Nothing was written to Notion. No application code exists yet.

## Who did what

| Work | Model |
|---|---|
| Plan, briefs, verification, this report | Fable (lead) |
| Standup Jokes + Joke Versions inspection | Sonnet |
| Short Form Clips + Viral Content Dashboard inspection | Sonnet |
| Meta Instagram API research | Opus |

## How findings were verified

- Notion: the lead re-fetched four pages directly and they matched the agents' reports
  (version `3ff9226c…afcabe0`, clips `20e9226c…74ad03` and `2ae9226c…4ef2b1`, the Playbook page).
- Meta API: NOT verified against the live docs. `developers.facebook.com` is blocked from this
  environment, so the research rests on search-engine excerpts of the docs plus third-party
  corroboration. Every API claim below must be confirmed by a real API call in Phase 1.

## Notion: what exists

| Database | Rows | Role |
|---|---|---|
| Standup Jokes (`collection://0c83aa91…`) | 116 | Joke scripts in page bodies |
| Short Form Clips (`collection://5b7f244a…`, titled "Sketch Database") | 178 | Clip scripts; Type = Sketch / Storytime / Text Overlay / Trend / Crowdwork |
| Joke Versions (`collection://b100310c…`) | not counted (query quota) | One row per published post: IG URL, Post date, Views, Follows, Saves, Shares, Caption, transcript in body |

- Joke Versions relates to both Standup Jokes (`Joke`) and Short Form Clips (`Short Form Clip`).
  `Versions follows (total)` / `Versions views (total)` are rollup sums of the version rows.
- Standup Jokes statuses are different from the ones in the brief: Raw Ideas, Drafting, Tweaking,
  Testing, Polished, Topical, Retired, Archived Draft. The Idea → Posted pipeline belongs to
  Short Form Clips only. Both sets will be preserved as they are.
- Short Form Clips status counts: Posted 89, Idea 47, Writing 31, Archived 4, Editing 2,
  Ready to Film 2, empty 3.
- No separate Instagram posts/analytics database exists, so none will be duplicated. A separate
  "Joke Tracker" database belongs to the AI-account experiment and is out of scope.

## How `IG follows` is populated today

- Plain number fields on both databases. No formula, rollup, automation or documented sync.
- Written in bulk passes: `IG checked` is 2026-10-04 or 2026-10-05 on every populated row, and
  rows were modified seconds apart (e.g. 2026-10-20 17:24:26–40 UTC). That pattern is a script or
  agent, not typing, but who wrote them is unproven: Notion version history before ~2026-11-09
  is outside the plan's retention.
- Coverage: 13 of 116 jokes, 58 of 178 clips.
- Joke Versions notes say "Views/follows/shares/saves pending IG Insights pull", so the intended
  source is Instagram's own Insights screen. Posts are scheduled through Metricool.
- A bot integration named "Instinct" edited the `Versions` relation on 2026-11-09 and 11-11.

### Data problems the app must handle

1. Duplicate posts: the same reel is attached to more than one clip row with identical metrics
   (three pairs found in the Viral view alone; 55 distinct URLs across 59 populated rows).
   Summing `IG follows` across rows (23,796) overcounts.
2. The same post can sit in a joke's own IG fields and in a linked version (G-O-T-T: 100 follows
   in both). Adding the two double-counts.
3. A joke's `IG matched post` can be a different reel from its versions ("Not straight":
   matched post has 442,690 views; its original version has 2,357,164).
4. One clip stores another account's reel URL (`/cheftova/reel/Dd1Wy0-x5px/`).
5. URL formats vary (`/reel/`, `/reels/`, `/p/`, with and without `/rayeschiller/`); some are
   empty strings. Identifiers are shortcodes, not media IDs.
6. `IG follows = 0` exists as a real stored value and must not be treated as missing.
7. Titles and notes sometimes contain raw `<p>`/`<b>` markup.

## Instagram API: what is available (unverified until Phase 1)

| Data | Available | Notes |
|---|---|---|
| Current follower count (`followers_count`) | Yes | Integer; no history, so the app must snapshot it |
| Daily new followers (`follower_count` insight) | Yes, last 30 days only | Not a net count |
| Per-post views, reach, likes, comments, shares, saves | Yes | Reels and feed |
| Reel average and total watch time | Yes | |
| Per-post follows on feed posts and stories | Reported yes | |
| **Per-Reel follows** | **Reported no** | API returns "does not support the follows metric for this media product type" |
| Video file for transcription (`media_url`) | Sometimes | Omitted for reels with licensed/library audio |
| Webhook for new posts | None found | Poll instead |

- Recommended auth: Instagram API with Instagram Login, app in Development mode with the
  account as a tester. No Facebook Page, no App Review. 60-day token, refreshed on a schedule.
- Follower history before the first snapshot cannot be reconstructed as exact counts.
- No third-party tool was confirmed to expose exact per-Reel follows; Metricool's and other
  vendors' docs could not be reached.

## Consequence for the non-negotiable

Almost all of the account's content is Reels, and the official API is reported not to return
follows for Reels. Under the no-estimation rule, per-Reel follows will read "Unavailable" unless
a verified figure is supplied from Instagram's in-app Insights. Existing Notion values can be
shown as "Notion snapshot, checked <date>", never as live API data.

## Can be automated immediately (once credentials exist)

- Exact follower count snapshots and daily/weekly/monthly net change, pace to 100K.
- Per-post views, reach, likes, comments, shares, saves, watch time, with snapshots.
- Notion read sync of scripts, statuses, versions; matching posts by shortcode.
- AI analysis, ideas and briefing on that data.

## Requires the account owner

1. Confirm the Instagram account is a professional (Creator/Business) account.
2. Create a Meta developer app with the Instagram product; add the account as a tester;
   supply app ID and secret.
3. Create a Notion internal integration, share the three databases with it, supply the token.
4. Provide a Postgres database (Neon or Vercel Postgres), a Vercel project, an Anthropic API key.
5. Allow `graph.instagram.com`, `api.notion.com` and `developers.facebook.com` in this
   environment so integrations can be tested against the real APIs.
6. Say how the October `IG follows` values were obtained, and decide how per-Reel follows
   should be handled.

## Not yet checked

Joke Versions row count, rollup values, the Standup Jokes `Formula` definition, a full
duplicate-URL scan, per-tag Topic totals (Notion query quota ran out), and all Meta doc pages.
