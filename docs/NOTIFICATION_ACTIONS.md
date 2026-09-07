# Notification actions

This first implementation enables notification buttons on **Android development
and production builds**. iOS continues to receive tap-to-open notifications.
The native iOS handler and locked-device keychain migration are a separate,
build-gated follow-up; this change does **not** enable Apple Watch approvals.
No release versions are bumped in this preparatory PR.

## Authoring buttons

Options, form buttons, and table-level buttons may include:

```json
{
  "id": "release",
  "label": "Submit",
  "notification": {
    "enabled": true,
    "label": "Submit",
    "role": "confirm"
  }
}
```

The optional notification label is an explicit short title chosen by the author;
the in-app title does not change. It is never inferred from ids or styling.
Roles are `confirm`, `cancel`, and `destructive`; a destructive role or `danger`
style selects the matching pre-registered destructive-action category.
Authored order is preserved.

Options default to enabled. Form buttons and editable table buttons require
`enabled: true`. Tables with only readonly columns default to enabled. Explicit
`enabled: false` wins, and malformed notification metadata disables the shortcut.
Per-row actions retain metadata for protocol compatibility but are not exposed
as notification buttons. Forms with no usable fields remain invalid.

Opting in on an editable form/table authorizes submitting its **current shared
server state**, including blank values and other members' edits. It does not
submit a draft still on a device or require that all fields be filled. Table-level
submission includes only unresolved rows. Authors should use this opt-in only
when that behavior is appropriate for the action.

The complete effective label tuple must match
`packages/core/src/notifications/categories.json`. Unrecognized combinations
fall back to tap-to-open, and an oversized set is never truncated. Category ids
are immutable and versioned; new label tuples require a mobile build registering
them. Shared Rust/TypeScript fixtures pin labels, order, and operation bindings.
The Claude bridge explicitly supplies “Always allow this tool” as the notification
label while preserving “Always allow <tool> (this session)” in the conversation.

## Delivery and execution

Android registers categories and its Expo background notification task before
advertising `notification_action_version: 1` to `POST /api/push-tokens`. The server
returns a non-secret `notification_action_context`. A refresh preserves that
context only for the same device/account when the client supplies the prior
context; sign-out/server changes invalidate the local binding. Older clients
register normally and receive no category or action envelope.

Push `data.notification_actions` contains `version`, `context`, `category`, and
ordered `actions`. Each action has `kind`, `id`, `interaction_id`, `label`, and
`destructive`. Native category identifiers use `agora.v1.<tuple>.d<mask>`;
action identifiers use `agora.action.0` through `agora.action.3`.

The client maps a slot to its explicit operation, verifies the current registration,
and calls `POST /api/messages/{message_id}/notification_action` with:

```json
{
  "version": 1,
  "context": "the registration context",
  "category": "agora.v1.submit.d0",
  "action": {
    "kind": "form_submit",
    "id": "release",
    "interaction_id": "release-form-42",
    "label": "Submit",
    "destructive": false
  }
}
```

The endpoint requires ordinary user authentication and message visibility, checks
registration ownership and the current binding/eligibility, and dispatches to the
existing hub methods. It never accepts a URL or credential from the push. Option
selection and agent cancellation now use the same atomic store lock; concurrent
submissions cannot overwrite one another.

Success returns `{message, outcome: "recorded"}`. A duplicate with the same user
and choice returns `already_recorded`; a different completed choice returns 409.
The client posts first, uses the message returned with a conflict, and fetches
state only when needed to reconcile a conflict or lost response. Feedback says
“Response sent,” which means Agora recorded the choice, not that the agent
executed it. Offline agents can miss the live frame,
as with existing in-app submissions.

Pending interaction pushes use `msg:<message_id>` collapse ids and Android tags.
A separate per-channel allowance permits six pending-interaction alerts per
ten seconds. Overflow uses the existing conversation throttle and a tap-to-open
summary; excess asks remain in the conversation. Ordinary notifications retain
their existing five-second per-channel throttle.

Reading a conversation does not clear its pending cards. While the app is alive,
WebSocket updates dismiss resolved cards; reconnect/unread reconciliation fetches
pending messages outside the loaded pages. Deleted/inaccessible requests are
removed on reconciliation. A killed app cannot instantly remove a card resolved
on another device; a later action checks server state before submitting.

## Verification and iOS follow-up

Automated coverage includes vocabulary parity, malformed payloads, account/server
binding, authorization, atomic choice/cancellation races, form/table snapshots,
retry reconciliation, Android task registration/feedback, and navigation/cleanup.
The OS notification controls are not React components, so Storybook cannot verify
their rendering or action delivery.

Before enabling iOS action capability:

1. Build an Expo config plugin and Swift delegate in a full Xcode environment.
   Initialize Expo's notification manager first, install the Agora forwarding
   delegate afterward, and forward all unrelated callbacks. Agora owns completion
   for its action callbacks until its bounded network work finishes. Expo's
   current delegate manager completes unconditionally after dispatch, so adding
   an ordinary Expo delegate is insufficient.
2. Rotate URL/token keychain entries to new keys with `AFTER_FIRST_UNLOCK` using
   write-before-delete migration. SecureStore updates existing item values without
   updating their accessibility; repeating `setItemAsync` on old keys is not a
   migration. The app-process handler needs no app group. Native lookup must match
   SecureStore's service/account encoding, and all sign-in/sign-out writers must
   use the new keys consistently.
3. Give native code exclusive ownership of iOS actions in warm and cold processes;
   JS may navigate default taps but must not submit the same action again.
4. Compile and test on iPhone and paired Watch: locked/unlocked phone, first unlock
   after restart, warm/suspended/terminated app, duplicate taps, offline/lost reply,
   expired session, account/server switch, and another device resolving the ask.

Until those checks pass, leave iOS capability disabled. No native reliability or
Watch screenshot claim can be established with Jest, Storybook, or Command Line
Tools alone.
