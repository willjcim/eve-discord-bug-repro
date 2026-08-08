# eve Discord: only the first HITL prompt in a session can be answered

Minimal reproduction of a human-in-the-loop bug in the Discord channel of
[Vercel's `eve` agent framework](https://eve.dev), pinned to **`eve@0.31.3`**
(exact, not a range — a repro that floats its dependency is useless later).

## The bug

An eve agent running on the Discord channel can only ever get **one** answer per
session. The user clicks a button on the first prompt and the agent proceeds
normally. The user clicks a button on the *second* prompt and nothing happens —
no error, no acknowledgement, no reply. The durable workflow run sits at status
`Running` forever, waiting for input that was already given.

### Root cause

Two code paths disagree about how a session is keyed. Both live in
`packages/eve/src/public/channels/discord/` in the eve repo.

**1. Outbound: the session anchors to the first message it ever posts.**
`discordChannel.ts`, `anchor()` (~line 331), called on every message the channel
posts:

```ts
if (!posted.id || state.hasMessageAnchor) return;
state.conversationId = posted.id;
state.hasMessageAnchor = true;
if (state.channelId) input.session?.continuation?.rekey(discordContinuationToken(state.channelId, posted.id));
```

The `hasMessageAnchor` guard makes this a one-shot. The session's continuation
token binds to the first posted message and never moves again.

**2. Inbound: a button click routes by the id of the message it sits on.**
`discordChannel.ts`, `handleComponentInteraction` (~line 532) passes
`conversationId: input.interaction.messageId` (~line 551), which is then used to
address the session:

```ts
from(discordContinuationToken(channelId, conversationId)).respond(...)
```

**3. Nothing re-anchors when a question is posted.** The default
`input.requested` handler in `defaults.ts` (~line 68) posts the prompt with its
components and returns. It never re-keys the session to the message it just
created.

So the first question is usually the session's first message: its id is the
anchor, the click's `messageId` matches, and the answer lands. Every later
question is a followup with a *different* message id, so its click is dispatched
to a continuation token that no session holds. The answer is delivered to
nothing and the parked run waits forever.

Both code paths are still present in the pinned `eve@0.31.3` — you can read them
in `node_modules/eve/dist/src/public/channels/discord/discordChannel.js` after
installing (the dist is minified, so search for `hasMessageAnchor` and
`messageId`).

## Prerequisites

- **Node.js 24.x** (`node --version`).
- A **Vercel account** with the [Vercel CLI](https://vercel.com/docs/cli)
  installed and logged in (`npm i -g vercel && vercel login`). The agent must be
  publicly deployed before Discord will accept it, so there is no purely local
  path through this repro.
- A **Discord server you administer**, so you can install an app into it.

## Discord setup

This is the part people get wrong. Every step matters.

### 1. Create the application

Go to the [Discord Developer Portal](https://discord.com/developers/applications)
and click **New Application**. Name it anything.

### 2. Add a bot user

Open the **Bot** tab in the left sidebar. On current portal versions the bot user
already exists; on older ones click **Add Bot**.

### 3. Collect the three credentials

| Where in the portal | Value | Environment variable |
| --- | --- | --- |
| General Information → Application ID | Application ID | `DISCORD_APPLICATION_ID` |
| General Information → Public Key | Public Key | `DISCORD_PUBLIC_KEY` |
| Bot → Reset Token | Bot Token | `DISCORD_BOT_TOKEN` |

The bot token is shown exactly once, when you reset it. Copy it immediately.
`DISCORD_PUBLIC_KEY` is what eve uses to verify that inbound interactions really
came from Discord; without it every interaction is rejected with `401`.

### 4. Install the app with the right scopes

Go to **OAuth2 → URL Generator** and tick **both**:

- `bot`
- `applications.commands`

**This is a real trap.** `applications.commands` alone is enough to make the
slash command appear in the picker, so the install looks like it worked. But
without `bot` your application has no member in the guild: it cannot read the
channel, cannot post messages, and cannot resolve the guild at all. The command
will register and then fail at the first post. Tick both.

### 5. Grant the bot permissions

In the same URL Generator, under **Bot Permissions**, tick at minimum:

- **View Channel**
- **Send Messages**

Add **Read Message History** if your agent reads prior messages (this repro does
not need it).

Open the generated URL, pick your server, and authorize.

### 6. Check channel-level permission overrides

**This one cost real debugging time.** Server-level role permissions are not the
whole story. A channel can carry an override that denies **Send Messages** to
your bot's role even though the role grants it server-wide. The symptom is an
HTTP `403` from the Discord API when the agent tries to post, and from Discord's
UI everything looks correctly configured.

Right-click the channel → **Edit Channel** → **Permissions**, find your bot's
role (or add the bot directly), and make sure **View Channel** and **Send
Messages** are explicitly allowed — a grey `/` is not an allow.

### 7. Set the Interactions Endpoint URL

**Deploy first** (see below). Discord sends a signed PING to the URL the moment
you save it and refuses to save if the response is wrong, so the endpoint has to
be live already.

Then, in **General Information → Interactions Endpoint URL**, enter:

```
https://<your-deployment>.vercel.app/eve/v1/discord
```

and **Save Changes**.

### 8. Register the slash command

```bash
cp .env.example .env    # fill in the values from step 3
npm run register-command
```

Set `DISCORD_GUILD_ID` in `.env` to register the command in a single server,
which takes effect **instantly**. Leave it empty to register globally, which
Discord can take **up to an hour** to propagate. Use a guild command while
reproducing; waiting an hour to find out you had a typo is miserable.

## Deploy

```bash
npm install
npm run typecheck
npm run build
vercel deploy --prod
```

In the Vercel project's **Settings → Environment Variables**, set:

- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`

Redeploy after adding them. You do **not** need `AI_GATEWAY_API_KEY` on Vercel —
deployments authenticate to the AI Gateway with `VERCEL_OIDC_TOKEN`
automatically. It is only in `.env.example` for running the agent outside Vercel.

## Reproduction steps

1. In a channel where the bot can post, run **`/repro`**.
2. The agent calls `step_one`, which is gated on approval. Discord shows the
   first HITL prompt with **Approve** / **Deny** buttons.
3. Click **Approve**.
   **Expected:** the agent proceeds. **Actual:** the agent proceeds. ✅ This one
   works.
4. The agent calls `step_two`, also gated on approval. Discord shows a second
   HITL prompt with its own buttons, as a new message.
5. Click **Approve** on that second prompt.
   **Expected:** the agent proceeds and replies `Done.`
   **Actual:** nothing. The buttons stop spinning, no message is posted, no error
   appears in Discord or in the Vercel function logs, and the run never
   finishes. Clicking again changes nothing. ❌

### How the repro forces two prompts

Relying on the model to spontaneously ask two questions is flaky, so this repro
does not do that. Instead it uses **two trivial tools, each declared with
`approval: always()`** (`agent/tools/step_one.ts`, `agent/tools/step_two.ts`).
eve renders every approval as a HITL prompt with buttons, so the prompts are
produced by the *framework*, not by the model's mood. Both tools are no-ops.

To keep the two prompts strictly **sequential** rather than batched into one
parallel step, `step_two` requires a `code` argument that only `step_one`'s
return value supplies. The model cannot call them in the same step because it
does not know the code until the first tool has run and been approved.

`agent/instructions.md` then pins the behavior down: call `step_one`, then
`step_two`, and write no text before the end. That last part matters — see the
nuance below.

## Confirming it in observability

The difference between the two clicks is unambiguous in the Vercel run
inspector. List the runs:

```bash
vercel agent-runs list
```

The affected run stays at status `Running`. Inspect it:

```bash
vercel agent-runs inspect <runId>
```

The answer that **works** produces a complete chain, all within about half a
second:

```
hook_received → hook_created → step_created → step_started → step_completed
```

The answer that is **lost** stops two events in:

```
hook_received → hook_disposed → (nothing, forever)
```

`hook_received` means Discord's interaction reached the deployment and the
signature verified — the click is not the problem. `hook_disposed` with no
`hook_created` after it means the runtime resolved the continuation token to no
waiting session and dropped the payload on the floor.

## Why it happens

Walk the message ids through a session:

1. `/repro` is invoked. The channel state's `conversationId` starts as the
   *interaction* id, with `hasMessageAnchor: false`.
2. The agent requests approval for `step_one`. The default `input.requested`
   handler posts the prompt. That post calls `anchor()`, which sets
   `conversationId` to the posted message's id, flips `hasMessageAnchor` to
   `true`, and re-keys the session's continuation to
   `discord:<channelId>:<message-1-id>`.
3. You click **Approve** on that message. `handleComponentInteraction` routes by
   `interaction.messageId`, which *is* message 1. The token matches, the session
   is found, the answer resolves. This is the run that works.
4. The agent requests approval for `step_two`. The handler posts a second
   message with a new id. `anchor()` is called again, sees
   `hasMessageAnchor === true`, and **returns immediately**. The session is still
   keyed to message 1.
5. You click **Approve** on message 2. The inbound path builds
   `discord:<channelId>:<message-2-id>`. No session holds that token. The
   response is dispatched into the void, the parked turn is never resumed, and
   the run waits at `session.waiting` indefinitely.

The first prompt works only by coincidence: it happens to be the first thing the
session posted.

### The nuance: even the first question can be stranded

`anchor()` binds to the first message of *any* kind, not the first *question*. If
the agent posts an ordinary assistant message before its first prompt — a
greeting, an acknowledgement, a "let me look into that" — **that** message claims
the anchor. The very first question is then already a followup with a different
id, and even prompt number one becomes unanswerable.

This is why `agent/instructions.md` forbids the model from writing anything
before the tool calls. Without that constraint the repro is noisier: sometimes
zero prompts work instead of one, depending on whether the model felt chatty. If
you want to see that variant, add "greet the user first" to the instructions and
watch the first prompt break too.

## The fix

The framework fix is to re-key the session to each question's message as it is
posted, rather than only once. It is proposed upstream as
**https://github.com/willjcim/eve/pull/1**.

This repo intentionally does **not** apply it — it pins stock published `eve` so
the broken behavior is reproducible.

### User-land workaround

Until the framework fix lands, override the `input.requested` event yourself and
re-key after each post. This is the default handler plus one call:

```ts title="agent/channels/discord.ts"
import {
  discordChannel,
  discordContinuationToken,
  renderInputRequestComponents,
} from "eve/channels/discord";

export default discordChannel({
  events: {
    async "input.requested"(event, channel) {
      for (const request of event.requests) {
        const posted = await channel.discord.post({
          components: renderInputRequestComponents(request),
          content: request.prompt,
        });
        channel.continuation?.rekey(
          discordContinuationToken(channel.discord.channelId, posted.id),
        );
      }
    },
  },
});
```

Every prompt now becomes the session's current key, so the click on any prompt
addresses a session that exists. The trade-off is that only the most recent
prompt is answerable — answering an older one still misses — which is fine when
prompts are sequential, as they are here.

## Files

```
.env.example              Credentials a stranger must supply; no secrets committed
package.json              Pins eve@0.31.3 exactly, plus the scripts below
package-lock.json         Locks the transitive tree so the repro stays reproducible
tsconfig.json             Makes `npm run typecheck` meaningful
register-command.mjs      Registers /repro with Discord (an unavoidable manual step)
agent/agent.ts            Selects anthropic/claude-sonnet-5 via AI Gateway
agent/instructions.md     Forces step_one → step_two and forbids preamble text
agent/channels/discord.ts The Discord channel at the default /eve/v1/discord route
agent/tools/step_one.ts   No-op tool, approval: always() → HITL prompt 1
agent/tools/step_two.ts   No-op tool, approval: always() → HITL prompt 2
```
