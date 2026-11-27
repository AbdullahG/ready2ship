# Review modes: Lookout and Dive

Ready2Ship reviews a pull request in one of two modes. Each repository picks its mode in a `.ready2ship.yml` file; repositories without one get Lookout.

| | 🔭 Lookout | 🤿 Dive |
|---|---|---|
| What the model sees | The PR's diff | The diff, plus any file in the repository at the PR's head |
| How | One model call | An agent: it reads files, lists directories and searches the code (`grep`), then a second call checks every finding against the code and drops the ones it doesn't support |
| Good at | Bugs visible in the changed lines | Bugs that depend on code outside the diff: callers of a changed function, types, config |
| Typical input tokens per review | 10K–30K | 100K–1M (see [Cost](#cost)) |
| Time | Seconds | One to a few minutes |

Use Lookout everywhere and Dive on the repositories where a missed bug is expensive (payments, auth, infrastructure).

## Choosing a mode

Commit `.ready2ship.yml` to the root of the repository's **default branch**:

```yaml
review:
  mode: dive            # lookout | dive   (quick and deep work too)
  include: ["**/*.java"]
  exclude: ["**/generated/**"]
dive:
  models: ["gemini-2.5-pro"]
  maxToolCalls: 50
  maxFiles: 100
  maxLinesPerFile: 5000
  maxInputTokens: 2000000
```

Every key is optional. The file is read from the default branch on every review; a change to it inside a pull request has no effect until it is merged, so nobody can switch a repository to Dive, or raise its limits, from their own PR. This file is the only place these settings live: they can't be changed from the dashboard or with environment variables.

### Options

| Key | Default | Meaning |
|---|---|---|
| `review.mode` | `lookout` | `lookout` (or `quick`) or `dive` (or `deep`) |
| `review.include` | everything | Glob patterns. When set, only matching files are reviewed and Dive may only read matching files |
| `review.exclude` | nothing | Glob patterns that are never reviewed or read. Wins over `include` |
| `dive.models` | the instance's `GEMINI_MODELS` | Gemini models Dive tries, in order |
| `dive.maxToolCalls` | 50 | Tool calls (read, list, search) one Dive may make |
| `dive.maxFiles` | 100 | Different files one Dive may read |
| `dive.maxLinesPerFile` | 5,000 | Lines returned per read; longer files are read in ranges |
| `dive.maxInputTokens` | 2,000,000 | Input tokens summed over every model call of one Dive. This is the setting that caps the bill |

Lockfiles, minified files, `dist/`, `build/` and generated code are never reviewed, whatever the patterns say.

If the file can't be used (invalid YAML, an unknown mode, a negative limit), the review is **cancelled** before any AI call and the PR's summary comment says what is wrong. Unknown keys are reported as warnings and otherwise ignored.

## A one-off Dive

On any PR, someone with write access to the repository can comment, as the whole comment:

```
@your-app dive
```

`@your-app deep`, `deep review` and plain `dive` work too, in the conversation or in a review thread. Ready2Ship reacts with 👀 and dives into the PR's current head with the repository's `.ready2ship.yml` limits. Comments from people without write access are ignored, so outside contributors on a public repository can't spend your tokens. A push after the comment doesn't cancel the requested Dive.

## When a Dive stops

Dive never falls back to Lookout. It is **cancelled**, and the PR's summary comment says why, when:

- it would pass `maxInputTokens`, `maxToolCalls` or `maxFiles`, or the conversation would outgrow the model's context window;
- the AI key is rejected;
- the AI service still fails after one retry 30 s later.

A cancelled Dive posts no approval or change request. The PR shows as **Cancelled** in the dashboard with the reason and the tokens it used.

## Retrying a review

Any review, Lookout or Dive, that fails on a temporary error (AI service overloaded, network, GitHub 5xx) is retried once, 30 seconds later. If that fails too, or the review stops for any other reason (an invalid `.ready2ship.yml`, a spent Dive budget, a missing key, a crash), the PR's summary comment says so and ends with:

```
To retry: comment @your-app retry
```

`@your-app retry` (or `retry review`) reviews the PR's current head again. A review that was asked for with `@your-app dive` is retried as a Dive; any other review follows `.ready2ship.yml` as it is now, so fix the file or raise the limit first. Like `dive`, it is ignored from people without write access.

## Cost

You pay Google for the tokens, with your own key. Every summary comment ends with what the review used, for example:

```
🤿 Dive · 23 tool calls · 41 files read · ~640K input tokens · source: clone · config: .ready2ship.yml
```

The PR page in the dashboard shows the same numbers. Input tokens dominate: each step of the agent sends the whole conversation so far again, so a Dive that reads many files costs much more than one that reads a few. Rough sizes:

| Review | Input tokens |
|---|---|
| Lookout | 10K–30K |
| Dive, small change, a few files read | 100K–300K |
| Dive, wide change, many files read | 500K–2M (capped by `maxInputTokens`) |

Multiply by your model's price per million input tokens ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)) for the cost. To spend less: narrow `review.include`, exclude vendored code, lower `maxInputTokens`, or keep Dive for the repositories that need it and use the comment command elsewhere.

## How Dive reads the repository

Ready2Ship fetches only the PR's head commit (`git fetch --depth 1` of `refs/pull/<n>/head`, which also works for PRs from forks) into a temporary directory with the installation's token, and deletes it when the review ends. The token is passed in an HTTP header through the environment; it is never written to disk or logged. Paths can't leave the checkout.

Repositories over 500 MB, or a checkout that fails, are read through the GitHub API instead: Dive still reads files and lists directories but can't search, and the summary says `source: api (no grep)`.

Repository content is treated as data: the agent is told to ignore instructions it finds in files or the diff.

## Running it

- The Docker image includes `git`. Without Docker, `git` must be on the `PATH`.
- A Dive holds one worker slot for its whole run (minutes). With the default `JOB_CONCURRENCY=2`, one Dive leaves one slot for everything else; raise it if Dive repositories are busy.
- On Cloud Run `/tmp` is memory: give the service at least 2 GiB if you use Dive.
- A Dive interrupted by a restart or deploy, or retried after a temporary AI or GitHub failure (one retry), starts over and spends its tokens again: in the worst case about 2 × `maxInputTokens`. A spent budget is never retried automatically.

## Measuring

Each finding records the mode that produced it, so you can compare how often each mode's findings get acted on (fixed with `fix it` or resolved):

```js
// mongosh "$MONGODB_URI"
db.getSiblingDB("ready2ship").review_findings.aggregate([
  { $match: { reviewMode: { $exists: true } } },
  { $group: { _id: "$reviewMode", total: { $sum: 1 }, acted: { $sum: { $cond: [{ $in: ["$status", ["fixed", "resolved"]] }, 1, 0] } } } },
  { $project: { total: 1, acceptanceRate: { $divide: ["$acted", "$total"] } } },
])
```

`pull_requests.lastReview` holds each PR's latest mode, trigger, token usage and cancel reason.
