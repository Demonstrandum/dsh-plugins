# A client-bundle rebuild kills pending question/approval prompts in every open session

**Symptom (2026-09-21).** An agent in one session called `ask_user_question`
and, ~3 minutes later, got

```
Error: no user-questions answerer accepted the request   (UserQuestionError, code NO_PROVIDER)
```

then said "The question prompt isn't available in this session" and fell
back to plain text. The prompt facility itself was fine: the very next
`ask_user_question` in another session rendered and was answered normally.
Nothing to do with the upstream rebase that had happened earlier that day —
the whole code path (`user-questions` → `api-remotes` waterfall forwarding →
gateway → `ui-user-questions` client) was byte-identical before and after it.

**Root cause (confirmed by timestamps).** Another session was fixing a Dock-app
bug and rebuilt a *client* bundle installed in the live profile:

```
pnpm --filter @deepseek-ai/dsh-api-session-controller exec tsdown --env.DSH_BUILD_FACE client
```

Build complete 02:22:17.9 → the pending question failed 02:22:18.3 (390 ms).
Mechanism:

1. The live GUI's `client-hmr` hot-swaps a rebuilt client bundle in every
   connected browser (Dock app, Safari tabs, phone) without a refresh.
2. `session-controller`'s client half owns the `sessions` service. Reloading
   it tears down every client plugin that `inject`s `sessions` — including
   `ui-session` and `ui-user-questions` (and `ui-approval`).
3. `ui-session.registerPendingInteraction` documents that "plugin teardown
   delegates" any still-pending interaction: `ui-user-questions` calls
   `pending.delegate()` → its Remote-Event listener returns `next()`.
4. The gateway client replies `{kind:'next'}` to the Host. In
   `packages/api/gateway/src/index.ts` (`receiveRemoteEventResult`) a `next`
   from the **last** client holding the delivery settles the waterfall as
   `next`, and `UserQuestionService.ask` then hits its fallback:
   `NO_PROVIDER` — "no answerer accepted". Nobody declined; the UI was
   simply swapped out under the question.

Same applies to `approval/request` (`ui-approval` mirrors the lifecycle):
a pending approval dies as "no approval answerer" and fails closed.

Note the contrast: a client that *disconnects* (tab closed, reload) is
handled well — the gateway withdraws its delivery without settling and
**re-delivers every pending request to the next client that connects**
(`index.ts` `remoteEventStream`, `for (const pending …) deliverRemoteEvent`).
Only the in-page plugin reload declines.

**Decision (2026-09-21): no fork fix.** A handover-across-reload fix was
drafted (park the unanswered request on `globalThis` under a `Symbol.for`
key on teardown; the reloaded plugin instance adopts and re-presents it while
the Host waterfall stays pending; 15 s grace then delegate as before) and
reverted: ~150 lines across `ui-user-questions` + a mirror in `ui-approval`,
in files upstream actively edits (they changed `ui-user-questions/src/client/index.ts`
in the 2026-09-18 rebase), for a dev-only hazard with a mild outcome. It is an
upstream bug (HMR and prompt lifecycle are both upstream features); if it
becomes worth fixing, file it there with the mechanism above.

**How to avoid / recognise it**

| You see | It means | Do |
|---|---|---|
| `NO_PROVIDER` on `ask_user_question` seconds after a `tsdown … client` / `pnpm watch` rebuild of a live-profile bundle | the reload declined the prompt | just ask again — the facility is intact |
| `NO_PROVIDER` with no rebuild anywhere | genuinely no client resolves that agent | check the GUI is open and the session is visible; check the gateway/remotes plugins loaded |
| approval request "fails closed" right after a rebuild | same mechanism on `approval/request` | retry the tool call |

- Rebuilding a client bundle that is in the live profile (anything under
  `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`, or a
  `packages/**/lib/client.js` of the fork the live server serves) interrupts
  pending prompts in **all** open sessions, not just the one you are in. Do
  it in the preview server (`~/.dsh-preview`, [PREVIEWING.md](../PREVIEWING.md))
  or at a moment when no session is waiting on the user.
- The 3-minute gap between ask and failure in the transcript is just how long
  the question sat unanswered before the rebuild; it is not a timeout.
- Diagnosing this kind of thing: `transcript_grep` the error text across
  sessions, `transcript_read … fmt:jsonl` for millisecond `time` fields, and
  correlate with `git log --format=%ci` and `find -newermt` on the checkout.
  "Approval prompts are disabled in this session" in the runtime context is
  the configured `never` policy, not evidence of this fault.
