# Notification actions

Notification buttons are enabled on Android and, starting with mobile **0.1.33**,
on **warm iOS processes**, including notification actions forwarded from a paired
Apple Watch. Open the updated app and let it register push notifications before
testing a new approval. Existing cards are not retrofitted with buttons.

The iOS scope is an app that was recently opened and remains alive. Killed or
evicted processes are not supported by this JS-only implementation. Delivery or
replay after a later launch is not guaranteed; a delayed response can still submit
an ask that remains pending. Do not interpret a missing confirmation as success.
The existing foreground policy suppresses banners while Agora is active; test
notification delivery with the app backgrounded. Real phone/Watch validation is
required; successful Jest tests or Expo exports do not establish device delivery.

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

Both platforms verify migrated credentials and register categories before
advertising `notification_action_version: 1` to `POST /api/push-tokens`. Android
also registers its Expo background notification task; iOS uses the response
listener installed before the router, without registering that task. The server
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

## Locked-device storage

URL, token, and action registration use new SecureStore keys written with
`AFTER_FIRST_UNLOCK`. They can be read while locked only after the first unlock
following a device restart. The storage layer reads v2 first, migrates legacy
values by writing before deleting, and retains the old credential if migration
fails. Capability preparation verifies the new values instead of advertising
support on the strength of a fallback read. New registration bindings use the
same accessibility.

| Value | New key | Legacy keys removed by migration/logout |
| --- | --- | --- |
| URL | `agora_server_url_v2` | `agora_server_url` |
| Token | `agora_admin_key_v2` | `agora_admin_key`, `agora_owner_token` |
| Action binding | `agora_notification_registration_v2` | `agora_notification_registration_v1` |

The existing registration epoch invalidates work on account changes. Ordered
keychain operations prevent a migration write from completing after logout
deletion. Sign-out deletes all token/binding copies but deliberately retains the
server URL; Forget Server also removes both URL copies. `agora_instance_admin`
and `agora_push_token` are not read by the action executor and retain their
existing keys/accessibility and logout cleanup. They have no new v2 copies.

An unavailable credential read produces an “Open Agora to review this request”
reminder without action buttons. A changed account epoch or known foreign binding
suppresses feedback so an old callback cannot recreate another account's card.

## Verification and native iOS follow-up

Automated coverage includes vocabulary parity, malformed payloads, account/server
binding, authorization, atomic choice/cancellation races, form/table snapshots,
retry reconciliation, iOS listener and Android task registration/feedback,
keychain migration/races, and navigation/cleanup.
The OS notification controls are not React components, so Storybook cannot verify
their rendering or action delivery.

Before claiming killed-process iOS reliability:

1. Build an Expo config plugin and Swift delegate in a full Xcode environment.
   Initialize Expo's notification manager first, install the Agora forwarding
   delegate afterward, and forward all unrelated callbacks. Agora owns completion
   for its action callbacks until its bounded network work finishes. Expo's
   current delegate manager completes unconditionally after dispatch, so adding
   an ordinary Expo delegate is insufficient.
2. Read the migrated keys above from the app process. Native lookup must match
   SecureStore's service/account encoding; no app group is required.
3. Give native code exclusive ownership of iOS actions in warm and cold processes;
   JS may navigate default taps but must not submit the same action again.
4. Compile and test on iPhone and paired Watch: locked/unlocked phone, first unlock
   after restart, warm/suspended/terminated app, duplicate taps, offline/lost reply,
   expired session, account/server switch, and another device resolving the ask.

The warm-app release still needs device checks for locked-phone Watch taps,
first-unlock availability, offline retries, another member resolving an ask,
account changes, and a second pending request. Confirm whether scheduling with
a remote card's identifier replaces it or duplicates it, and whether category
registration noticeably delays first launch. Neither behavior is established by
Expo export. No native reliability or Watch screenshot claim can be established
with Jest, Storybook, or Command Line Tools alone.
