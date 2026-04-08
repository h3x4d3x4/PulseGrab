# PulseGrab — Open Source Launch Plan

A step-by-step guide to going public, building a user base, and setting up donations.

---

## Overview

Get PulseGrab in front of the self-hosting community, establish yourself as the authoritative maintainer, and create passive donation income. Three phases: **prepare → launch → sustain**.

---

## Phase 1 — Prepare the Repository

### 1.1 Choose a License

Add a `LICENSE` file to the repo root. Recommended: **MIT License**.

- MIT allows anyone to use, copy, and fork — but requires attribution (your name stays on it)
- This is the norm for userscripts; a restrictive license just discourages adoption
- Avoid GPL unless you want to get into license enforcement

### 1.2 Update `.gitignore`

Make sure `.venv/` and `.claude/` are excluded before going public.

```
.venv/
.claude/
*.DS_Store
```

### 1.3 Update the Script Header

The `// ==UserScript==` block is what Greasy Fork and Tampermonkey display. Add these fields:

```js
// @namespace    https://github.com/YOUR_USERNAME/PulseGrab
// @author       Hexadexa
// @homepageURL  https://hexadexa.io
// @supportURL   https://github.com/YOUR_USERNAME/PulseGrab/issues
// @updateURL    https://github.com/YOUR_USERNAME/PulseGrab/raw/main/releases/PulseGrab%20v1.0.2.js
// @downloadURL  https://github.com/YOUR_USERNAME/PulseGrab/raw/main/releases/PulseGrab%20v1.0.2.js
// @icon         https://raw.githubusercontent.com/YOUR_USERNAME/PulseGrab/main/assets/pulsegrab_logo.png
// @connect      api.github.com
```

- `@updateURL` / `@downloadURL` enable Tampermonkey auto-update from your GitHub
- `@connect api.github.com` is required by Greasy Fork — they enforce disclosure of all external requests

### 1.4 Polish the README

The current README is solid. Before going public, add:

- **Badges row** at the top (version, license, Greasy Fork installs once live):
  ```markdown
  [![Version](https://img.shields.io/badge/version-1.0.2-brightgreen)](releases/)
  [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
  [![Ko-fi](https://img.shields.io/badge/donate-Ko--fi-ff5e5b)](https://ko-fi.com/YOUR_USERNAME)
  ```
- **Ko-fi / donation button** — right below the intro paragraph, above the feature list. Placement matters: most people won't scroll to the bottom.
- **Screenshot or demo GIF** — a 30-second screen recording of the Download Manager in action will dramatically increase installs. Use Kap (macOS) or QuickTime + `ffmpeg` to convert to GIF.

### 1.5 Set Up GitHub Releases (Not Just Files in /releases/)

Right now the script is just a file in a folder. GitHub Releases matter because:

- The in-app update checker already uses the GitHub Releases API — it needs actual Releases
- Greasy Fork can pull from Releases
- Users get email notifications when subscribed

For each version: GitHub → Releases → Draft new release → tag `v1.0.2` → attach the `.js` file → paste the changelog.

### 1.6 Set Up Donations

**Ko-fi** (easier, no approval process, immediate):
- Create account at ko-fi.com
- Set a goal (e.g., "Cover server costs")
- Add the link to README, landing page, and script About modal

**GitHub Sponsors** (better long-term, shows on profile, lower fees):
- Apply at github.com/sponsors (takes a few weeks)
- Worth doing alongside Ko-fi

Add `.github/FUNDING.yml` so GitHub shows the Sponsor button:

```yaml
ko_fi: YOUR_KO_FI_USERNAME
github: YOUR_GITHUB_USERNAME
```

---

## Phase 2 — Launch

### 2.1 Make the GitHub Repo Public

Settings → Danger Zone → Change visibility → Public.

Before flipping, double-check:
- No API keys, tokens, or credentials in the git history (`git log -p` to scan)
- `.claude/` and `.venv/` are gitignored

### 2.2 Submit to Greasy Fork

Greasy Fork is the #1 discovery channel for userscripts — hundreds of thousands of active users.

1. Create an account at greasyfork.org
2. Profile → Post a new script
3. Paste the script source or link to raw GitHub URL
4. Fill out:
   - **Name**: PulseGrab - Universal Download Manager for Emby, Plex & Jellyfin
   - **Description**: 2–3 sentences. Lead with the problem it solves, not the feature list.
   - **Additional info**: Link to GitHub repo and hexadexa.io
5. Categories: `Media`, `Utilities`
6. Submit (usually approved within 24–48 hours)

### 2.3 Post to Reddit

Post the same day the repo goes public. Different wording for each sub (identical posts get removed as spam).

| Subreddit | ~Members | Notes |
|-----------|----------|-------|
| r/selfhosted | 400k | Most important — loves tools like this |
| r/emby | 20k | Direct target audience |
| r/PleX | 250k | Large and active |
| r/jellyfin | 50k | Smaller but passionate |
| r/DataHoarder | 500k | Loves anything download-related |

**Post format that works on these subs:**

```
Title: [Tool] PulseGrab — download anything from Emby/Plex/Jellyfin directly in the browser

Body:
- What it is (1 sentence)
- What problem it solves (1 sentence)
- Key features (short bullet list)
- Screenshot or GIF
- Links to GitHub + Greasy Fork install
```

### 2.4 Post to Forums & Discord

- **Emby Community Forums** (forums.emby.media) — Tools & Plugins section
- **Jellyfin Forum** — active community
- **ServeTheHome Forums** — popular with NAS/self-hosting crowd
- **Linuxserver.io Discord** — huge self-hosting Discord, has a #tools channel

### 2.5 Submit to Awesome Lists

Curated GitHub lists that drive long-tail installs for years:

- `awesome-selfhosted` — submit a PR under the Media section
- `awesome-plex`, `awesome-jellyfin` — smaller but targeted

---

## Phase 3 — Sustain

### 3.1 Handle Issues Fast (First 2 Weeks Are Critical)

If someone files a bug and you respond within a day, they'll recommend the tool. If it sits for a week, the Reddit post dies. Turn on GitHub notifications for the first month.

### 3.2 Watch for API Breakage

Emby, Plex, and Jellyfin all update regularly. When a server update breaks the script, being the person who fixes it fast is the moat — no fork can compete with active maintenance.

Subscribe to:
- Emby blog / changelog
- Plex release notes
- Jellyfin GitHub releases

### 3.3 Donation Conversion Tips

- Add a non-intrusive "if this saved you time, consider a coffee" note in the About modal
- Don't nag on every load — once in About is enough
- Show a donation link when the update checker fires — users are grateful in that moment

### 3.4 Optional: Changelog Newsletter

A free Substack or Buttondown email list for release notes. Builds direct contact with users independent of Reddit/GitHub. Useful later if you ever announce a paid companion tool.

---

## Checklist

### Before Going Public
- [ ] Add `LICENSE` (MIT)
- [ ] Update `.gitignore` (exclude `.venv/`, `.claude/`)
- [ ] Update script header: `@namespace`, `@author`, `@homepageURL`, `@supportURL`, `@updateURL`, `@downloadURL`, `@icon`, `@connect`
- [ ] Add donation badge + Ko-fi link to README
- [ ] Add screenshot or demo GIF to README
- [ ] Create GitHub Release for v1.0.2 with `.js` attached
- [ ] Create `.github/FUNDING.yml`
- [ ] Set up Ko-fi account
- [ ] Apply for GitHub Sponsors
- [ ] Scan git history for credentials (`git log -p | grep -i "token\|key\|secret\|password"`)

### Launch Day
- [ ] Make GitHub repo public
- [ ] Submit to Greasy Fork
- [ ] Post to r/selfhosted
- [ ] Post to r/emby, r/PleX, r/jellyfin (different wording each)
- [ ] Post to r/DataHoarder
- [ ] Post to Emby Community Forums

### Week 1
- [ ] Submit PR to `awesome-selfhosted`
- [ ] Post to ServeTheHome / Linuxserver Discord
- [ ] Respond to all GitHub issues and Reddit comments
- [ ] Track Greasy Fork install count

---

## Realistic Expectations

| Milestone | Timeframe |
|-----------|-----------|
| First 100 Greasy Fork installs | 1–3 days after Reddit posts |
| First donation | 1–2 weeks |
| 1,000 installs | 2–4 weeks |
| $50–100/month in donations | 3–6 months with consistent maintenance |
| Sponsorship interest | ~5,000+ installs |

The self-hosting community rewards actively maintained tools. The install curve is fast at launch, then slow-and-steady from search and word-of-mouth.
