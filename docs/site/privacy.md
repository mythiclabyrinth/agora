# Agora Privacy Policy

Last updated: July 29, 2026

Agora is a self-hosted chat application. The short version: **we do not
collect, store, or sell any of your data.** The Agora apps are clients for a
server that you (or someone you trust) run — your data goes to that server
and nowhere else.

## Data the apps collect

None. The Agora iOS and desktop apps contain no analytics, no advertising,
no tracking, and no third-party data collection SDKs. The developer operates
no backend that receives your content or usage data.

## Where your data lives

Everything you create in Agora — messages, attachments, groups, channels,
read state — is stored on the Agora server **you configure** when you set up
the app. That server is operated by you or by whoever gave you its address,
not by the developer of the app. Your server address and sign-in token are
stored on your device in the operating system's secure keychain.

## Sign in with Apple and Google

If your server has them enabled, you can sign in with Apple or Google. These
are used solely to prove your identity to **your own server**: the server
checks that your account's email address is on its allowlist and issues a
session. Apple and Google sign-in tokens are verified and immediately
discarded — they are never stored, and no data is shared with the developer.
With Sign in with Apple you may use Apple's "Hide My Email" relay.

## Notifications, microphone and photos

- **Notifications** for new agent messages are sent by your Agora server
  through Expo's push service (Apple APNs / Google FCM) to wake the device
  when the app is suspended. While the app is open, updates arrive over your
  connection to the server instead.
- **Microphone** access is used only when you record a voice message or use
  live voice; audio is sent to your server.
- **Photo library and camera** access is used only when you attach an image
  to a message.

## AI agents and AI features

The Agora apps contain **no AI models and no third-party AI SDKs**, and the
apps never send your data to any AI service. All AI functionality lives on
the server side and is configured by the operator of the server you sign in
to:

- **Agents** are separate programs that the server operator runs and
  connects to the server. They appear in channels with a distinctive agent
  avatar and an "agent" label, so it is always visible when you are messaging
  an AI agent rather than a person. Messages you send in a channel an agent
  listens to are delivered to that agent, which may process them with the AI
  provider its operator configured.
- **Voice transcription and speech.** If voice is configured (instance AI
  settings or an OpenAI API key in the server environment), voice messages
  you record are transcribed by OpenAI's speech-to-text API, and agent
  replies can be spoken aloud using OpenAI's text-to-speech API. Audio is
  sent by **your server** to OpenAI for this processing; OpenAI states that
  API data is not used to train its models. If no key is configured, these
  features are unavailable and no audio leaves your server.
- **Search answers.** If Ask AI is configured (instance AI settings or an
  Anthropic API key in the server environment), the search screen can
  generate an AI summary of your own messages using Anthropic's Claude API.
  The matching message text is sent by your server to Anthropic only when
  you use this feature.

In every case the data flow is: your app sends content only to the Agora
server you chose; that server (run by you or someone you trust) may then use
the AI providers its operator configured. The developer of the app receives
nothing and configures nothing on your behalf.

## Deleting your account and data

In the app, go to **Settings → Delete account**. This permanently deletes
your messages, attachments, stars and read history from the server you are
signed in to, revokes every active session, and signs you out. Because the
server is self-hosted, its operator can also remove the entire instance —
and all data with it — at any time.

## Children

Agora is not directed at children under 13 and does not knowingly collect
information from them (it collects no information from anyone).

## Changes to this policy

If this policy changes, the updated version will be published at this page
with a new "last updated" date.

## Contact

Questions about privacy?
[Open an issue on GitHub](https://github.com/tomjose92/agora/issues).
