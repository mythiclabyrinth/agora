/* Framework-free UI fixtures. Storybook and mobile Jest may both import
   these; keep Storybook decorators and browser/native APIs out of this file. */

import type {
  AgentInfo,
  ChannelAgent,
  Group,
  Me,
  Member,
  Message,
  MessageTemplate,
  Schedule,
  ThreadRow,
  UserInfo,
} from "../src/api/types";

export const fixtureMarkdown = [
  "## Release readiness",
  "",
  "The responsive component catalog is **ready for review**. Run `npm run storybook -w web` and check the [interaction testing guide](https://storybook.js.org/docs/writing-tests/interaction-testing).",
  "",
  "### Review checklist",
  "",
  "- Verify the layout at phone, tablet, and desktop widths",
  "- Test keyboard navigation and visible error states",
  "- Compare shared content on web, iOS, and Android",
  "",
  "| Surface | Expected result |",
  "| --- | --- |",
  "| Web / desktop | Responsive panes without horizontal overflow |",
  "| iOS / Android | Native controls with the same fixture content |",
  "",
  "> Component stories should finish in the state a reviewer needs to inspect.",
].join("\n");

export const fixtureMe: Me = {
  username: "tom",
  display_name: "Tom",
  version: "storybook",
  instance_admin: true,
  max_file_mb: 25,
  max_video_mb: 100,
  voice: false,
  search_ai: true,
};

export const fixtureGroups: Group[] = [{
  id: "product",
  name: "Product",
  description: "Product planning and implementation",
  created_by: "tom",
  created_at: 1_750_000_000,
  role: "admin",
  is_public: false,
  channels: [
    {
      id: "general",
      group_id: "product",
      name: "storybook",
      topic: "Component development and responsive review",
      created_at: 1_750_000_000,
      unread: 4,
      mentions: 1,
      last_read_id: 40,
    },
    {
      id: "responsive",
      group_id: "product",
      name: "responsive-web",
      topic: "Web and desktop layout",
      created_at: 1_750_000_010,
      unread: 0,
      mentions: 0,
    },
  ],
}];

export const fixtureAgents: AgentInfo[] = [
  {
    id: "codex",
    name: "Codex",
    source: "bridge",
    requires_mention: false,
    last_seen: 1_750_000_200,
    live: true,
    avatar: null,
  },
  {
    id: "claude",
    name: "Claude",
    source: "bridge",
    requires_mention: true,
    last_seen: 1_750_000_180,
    live: true,
    avatar: null,
  },
];

export const fixtureChannelAgents: ChannelAgent[] = fixtureAgents.map(({ id, name }) => ({ id, name }));

export const fixtureMembers: Member[] = [
  {
    channel_id: null,
    member_type: "user",
    member_id: "tom",
    role: "admin",
    added_at: 1_750_000_000,
    name: "Tom",
  },
  {
    channel_id: null,
    member_type: "user",
    member_id: "alice",
    role: "member",
    added_at: 1_750_000_020,
    name: "Alice",
  },
  {
    channel_id: "general",
    member_type: "agent",
    member_id: "codex",
    role: "member",
    added_at: 1_750_000_030,
    name: "Codex",
  },
  {
    channel_id: "general",
    member_type: "agent",
    member_id: "claude",
    role: "member",
    added_at: 1_750_000_040,
    name: "Claude",
  },
];

export const fixtureUsers: UserInfo[] = [
  {
    username: "tom",
    display_name: "Tom",
    email: "tom@example.test",
    instance_role: "admin",
    created_at: 1_750_000_000,
    disabled: false,
  },
  {
    username: "alice",
    display_name: "Alice",
    email: "alice@example.test",
    instance_role: "member",
    created_at: 1_750_000_020,
    disabled: false,
  },
];

export const fixtureRootMessage: Message = {
  id: 42,
  channel_id: "general",
  thread_id: null,
  author_type: "user",
  author_id: "tom",
  author_name: "Tom",
  text: "Can we validate the responsive component layout?",
  ts: 1_750_000_100,
  attachments: [],
  reactions: [{ emoji: "👍", users: ["tom", "alice"] }],
  reply_count: 2,
};

export const fixtureAgentMessage: Message = {
  id: 43,
  channel_id: "general",
  thread_id: null,
  author_type: "agent",
  author_id: "codex",
  author_name: "Codex",
  text: "The real panes are now rendered over deterministic fixture data.",
  ts: 1_750_000_120,
  attachments: [],
  reactions: [
    { emoji: "👍", users: ["tom", "alice", "Codex"], reactors: [
      { type: "user", id: "tom", name: "Tom" },
      { type: "user", id: "alice", name: "Alice" },
      { type: "agent", id: "codex", name: "Codex" },
    ] },
    { emoji: "🎉", users: ["alice"], reactors: [{ type: "user", id: "alice", name: "Alice" }] },
  ],
  meta: {
    tldr: "Real panes now use deterministic fixtures.",
    unfurls: [{
      url: "https://storybook.js.org/",
      site: "storybook.js.org",
      title: "Storybook",
      description: "Build and test components in isolation.",
    }],
  },
};

export const fixtureReplies: Message[] = [
  {
    id: 44,
    channel_id: "general",
    thread_id: 42,
    author_type: "agent",
    author_id: "codex",
    author_name: "Codex",
    text: "The 820px phone boundary is covered.",
    ts: 1_750_000_140,
    attachments: [],
  },
  {
    id: 45,
    channel_id: "general",
    thread_id: 42,
    author_type: "user",
    author_id: "alice",
    author_name: "Alice",
    text: "And 821px exercises the overlay layout.",
    ts: 1_750_000_160,
    attachments: [],
  },
];

export const fixtureMessages: Message[] = [fixtureRootMessage, fixtureAgentMessage];

/* Private per-user message templates for the group above. */
export const fixtureTemplates: MessageTemplate[] = [
  {
    id: "standup",
    group_id: "product",
    label: "Daily standup",
    text: "Yesterday I completed…\nToday I will…\nBlocked by…",
    created_at: 1_750_000_100,
    updated_at: 1_750_000_100,
  },
  {
    id: "release-check",
    group_id: "product",
    label: "Release checklist",
    text: "Storybook builds ✅\nPlaywright green ✅\nVersion bumped ✅",
    created_at: 1_750_000_200,
    updated_at: 1_750_000_200,
  },
];

export const fixtureThreads: ThreadRow[] = [{
  root: fixtureRootMessage,
  channel_id: "general",
  channel_name: "storybook",
  group_id: "product",
  group_name: "Product",
  reply_count: fixtureReplies.length,
  last_reply_id: fixtureReplies.at(-1)!.id,
  last_reply_ts: fixtureReplies.at(-1)!.ts,
  last_read_id: fixtureReplies[0].id,
  unread: 1,
}];

/* Synthetic six-month daily series (seeded, checked in as literals). The
   shape mirrors what agents post through `send_chart`: ~160-175 points per
   chart whose values drift by fractions of a percent, which is the case
   that needs a value axis scaled to the data instead of anchored at zero. */
const DENSE_TREND_SERIES: { name: string; dates: string; values: number[] }[] = [
  {
    name: "Series Alpha",
    dates: "01 Mar,02 Mar,03 Mar,04 Mar,05 Mar,06 Mar,07 Mar,08 Mar,09 Mar,10 Mar,11 Mar,12 Mar,13 Mar,14 Mar,15 Mar,16 Mar,17 Mar,18 Mar,19 Mar,20 Mar,21 Mar,22 Mar,23 Mar,24 Mar,25 Mar,26 Mar,27 Mar,28 Mar,29 Mar,30 Mar,31 Mar,01 Apr,02 Apr,03 Apr,04 Apr,05 Apr,06 Apr,07 Apr,08 Apr,09 Apr,10 Apr,11 Apr,12 Apr,13 Apr,14 Apr,15 Apr,16 Apr,17 Apr,18 Apr,19 Apr,20 Apr,21 Apr,22 Apr,23 Apr,24 Apr,25 Apr,26 Apr,27 Apr,28 Apr,29 Apr,30 Apr,01 May,02 May,03 May,04 May,05 May,06 May,07 May,08 May,09 May,10 May,11 May,12 May,13 May,14 May,15 May,16 May,17 May,18 May,19 May,20 May,21 May,22 May,23 May,24 May,25 May,26 May,27 May,28 May,29 May,30 May,31 May,01 Jun,02 Jun,03 Jun,04 Jun,05 Jun,06 Jun,07 Jun,08 Jun,09 Jun,10 Jun,11 Jun,12 Jun,13 Jun,14 Jun,15 Jun,16 Jun,17 Jun,18 Jun,19 Jun,20 Jun,21 Jun,22 Jun,23 Jun,24 Jun,25 Jun,26 Jun,27 Jun,28 Jun,29 Jun,30 Jun,01 Jul,02 Jul,03 Jul,04 Jul,05 Jul,06 Jul,07 Jul,08 Jul,09 Jul,10 Jul,11 Jul,12 Jul,13 Jul,14 Jul,15 Jul,16 Jul,17 Jul,18 Jul,19 Jul,20 Jul,21 Jul,22 Jul,23 Jul,24 Jul,25 Jul,26 Jul,27 Jul,28 Jul,29 Jul,30 Jul,31 Jul,01 Aug,02 Aug,03 Aug,04 Aug,05 Aug,06 Aug",
    values: [244.1019,244.2077,244.1735,244.1644,244.1483,244.1897,244.2324,244.2801,244.3083,244.3587,244.3959,244.4084,244.4724,244.6175,244.7527,244.7822,244.8054,244.9315,244.9686,245.1035,245.0835,245.1824,245.2408,245.326,245.453,245.5269,245.508,245.5399,245.5661,245.6602,245.7296,245.7723,245.7662,245.8653,245.8688,245.8474,245.9914,245.9464,245.9622,246.0619,246.1347,246.1108,246.1185,246.133,246.1457,246.1723,246.3167,246.3552,246.3899,246.453,246.5184,246.4709,246.5559,246.6876,246.7561,246.758,246.8633,246.8536,246.8149,246.8909,246.8737,246.925,246.9403,247.0556,247.129,247.0977,247.134,247.1232,247.152,247.1835,247.1978,247.2593,247.2611,247.3576,247.4823,247.5205,247.5865,247.6888,247.7574,247.7088,247.6596,247.6474,247.7119,247.6759,247.6351,247.6621,247.7139,247.8224,247.9019,248.002,248.1135,248.1263,248.2275,248.3374,248.466,248.519,248.5794,248.6574,248.6792,248.6461,248.6439,248.7652,248.8675,248.9216,248.9213,248.9269,248.9535,248.9897,248.9974,249.0079,249.1271,249.0815,249.1867,249.2085,249.1636,249.2589,249.2328,249.2852,249.3434,249.3278,249.3155,249.426,249.4184,249.5105,249.5263,249.5918,249.6523,249.6398,249.6506,249.635,249.7133,249.8189,249.8661,249.9381,250.0441,250.0185,250.0348,250.1593,250.1138,250.1909,250.3189,250.3439,250.4019,250.3861,250.3598,250.4173,250.5383,250.5279,250.5095,250.6282,250.5934,250.5489,250.6465,250.6291,250.7593,250.8228,250.9029,250.8981,250.8906],
  },
  {
    name: "Series Beta",
    dates: "13 Feb,14 Feb,15 Feb,16 Feb,17 Feb,18 Feb,19 Feb,20 Feb,21 Feb,22 Feb,23 Feb,24 Feb,25 Feb,26 Feb,27 Feb,28 Feb,01 Mar,02 Mar,03 Mar,04 Mar,05 Mar,06 Mar,07 Mar,08 Mar,09 Mar,10 Mar,11 Mar,12 Mar,13 Mar,14 Mar,15 Mar,16 Mar,17 Mar,18 Mar,19 Mar,20 Mar,21 Mar,22 Mar,23 Mar,24 Mar,25 Mar,26 Mar,27 Mar,28 Mar,29 Mar,30 Mar,31 Mar,01 Apr,02 Apr,03 Apr,04 Apr,05 Apr,06 Apr,07 Apr,08 Apr,09 Apr,10 Apr,11 Apr,12 Apr,13 Apr,14 Apr,15 Apr,16 Apr,17 Apr,18 Apr,19 Apr,20 Apr,21 Apr,22 Apr,23 Apr,24 Apr,25 Apr,26 Apr,27 Apr,28 Apr,29 Apr,30 Apr,01 May,02 May,03 May,04 May,05 May,06 May,07 May,08 May,09 May,10 May,11 May,12 May,13 May,14 May,15 May,16 May,17 May,18 May,19 May,20 May,21 May,22 May,23 May,24 May,25 May,26 May,27 May,28 May,29 May,30 May,31 May,01 Jun,02 Jun,03 Jun,04 Jun,05 Jun,06 Jun,07 Jun,08 Jun,09 Jun,10 Jun,11 Jun,12 Jun,13 Jun,14 Jun,15 Jun,16 Jun,17 Jun,18 Jun,19 Jun,20 Jun,21 Jun,22 Jun,23 Jun,24 Jun,25 Jun,26 Jun,27 Jun,28 Jun,29 Jun,30 Jun,01 Jul,02 Jul,03 Jul,04 Jul,05 Jul,06 Jul,07 Jul,08 Jul,09 Jul,10 Jul,11 Jul,12 Jul,13 Jul,14 Jul,15 Jul,16 Jul,17 Jul,18 Jul,19 Jul,20 Jul,21 Jul,22 Jul,23 Jul,24 Jul,25 Jul,26 Jul,27 Jul,28 Jul,29 Jul,30 Jul,31 Jul,01 Aug,02 Aug,03 Aug,04 Aug,05 Aug,06 Aug",
    values: [1184.0326,1184.4621,1184.4938,1185.0273,1185.679,1185.708,1185.4723,1185.5591,1185.3606,1185.2537,1185.5472,1185.9086,1186.2948,1186.635,1186.9888,1186.9198,1187.2833,1187.8389,1187.8652,1187.6336,1188.0733,1187.999,1187.8007,1188.1653,1188.1613,1188.3425,1188.9408,1189.291,1189.642,1189.722,1189.6166,1189.8508,1189.7594,1189.7243,1190.0142,1190.0643,1189.8876,1190.4372,1190.3024,1190.5289,1190.53,1191.2343,1191.4848,1191.969,1191.9531,1192.6078,1192.4082,1192.353,1192.1699,1192.8288,1193.3856,1193.1486,1192.9621,1193.2039,1193.3933,1193.819,1194.3932,1195.0303,1195.2076,1195.8391,1196.294,1196.322,1196.5848,1197.273,1197.0855,1197.7846,1198.3272,1198.4887,1198.4753,1198.5735,1198.8828,1198.7441,1199.0506,1198.8945,1199.4225,1199.5619,1199.6267,1199.81,1199.7222,1200.4035,1200.6898,1201.3281,1201.3094,1201.8848,1202.2351,1202.2143,1202.0575,1201.9298,1201.7383,1201.8131,1201.9549,1201.8694,1201.8026,1202.1148,1202.4171,1202.7327,1202.5747,1202.7355,1202.5993,1203.0168,1202.8769,1203.175,1203.294,1203.945,1204.0911,1204.3145,1204.4573,1205.0288,1204.9091,1204.7355,1204.9486,1205.1417,1205.2379,1205.8983,1205.6813,1205.8351,1206.0955,1206.205,1206.8163,1206.9109,1207.272,1207.9397,1208.2587,1208.8996,1209.2256,1209.0078,1209.3705,1209.4401,1210.0784,1210.7378,1211.0866,1210.9574,1210.8631,1211.1635,1211.4443,1211.6827,1211.7027,1211.8996,1211.9885,1211.994,1212.2037,1212.4972,1213.0322,1213.1808,1213.6231,1214.2611,1214.435,1214.7802,1214.5813,1214.6657,1214.7022,1215.1133,1214.874,1215.3949,1215.3096,1215.1802,1215.1537,1215.1634,1215.7915,1215.695,1215.5463,1215.9247,1216.5733,1216.9181,1217.2153,1217.6323,1218.3271,1218.906,1219.0332,1219.3922,1219.2958,1219.3113,1219.6247,1219.5548,1219.4002],
  },
  {
    name: "Series Gamma",
    dates: "22 Feb,23 Feb,24 Feb,25 Feb,26 Feb,27 Feb,28 Feb,01 Mar,02 Mar,03 Mar,04 Mar,05 Mar,06 Mar,07 Mar,08 Mar,09 Mar,10 Mar,11 Mar,12 Mar,13 Mar,14 Mar,15 Mar,16 Mar,17 Mar,18 Mar,19 Mar,20 Mar,21 Mar,22 Mar,23 Mar,24 Mar,25 Mar,26 Mar,27 Mar,28 Mar,29 Mar,30 Mar,31 Mar,01 Apr,02 Apr,03 Apr,04 Apr,05 Apr,06 Apr,07 Apr,08 Apr,09 Apr,10 Apr,11 Apr,12 Apr,13 Apr,14 Apr,15 Apr,16 Apr,17 Apr,18 Apr,19 Apr,20 Apr,21 Apr,22 Apr,23 Apr,24 Apr,25 Apr,26 Apr,27 Apr,28 Apr,29 Apr,30 Apr,01 May,02 May,03 May,04 May,05 May,06 May,07 May,08 May,09 May,10 May,11 May,12 May,13 May,14 May,15 May,16 May,17 May,18 May,19 May,20 May,21 May,22 May,23 May,24 May,25 May,26 May,27 May,28 May,29 May,30 May,31 May,01 Jun,02 Jun,03 Jun,04 Jun,05 Jun,06 Jun,07 Jun,08 Jun,09 Jun,10 Jun,11 Jun,12 Jun,13 Jun,14 Jun,15 Jun,16 Jun,17 Jun,18 Jun,19 Jun,20 Jun,21 Jun,22 Jun,23 Jun,24 Jun,25 Jun,26 Jun,27 Jun,28 Jun,29 Jun,30 Jun,01 Jul,02 Jul,03 Jul,04 Jul,05 Jul,06 Jul,07 Jul,08 Jul,09 Jul,10 Jul,11 Jul,12 Jul,13 Jul,14 Jul,15 Jul,16 Jul,17 Jul,18 Jul,19 Jul,20 Jul,21 Jul,22 Jul,23 Jul,24 Jul,25 Jul,26 Jul,27 Jul,28 Jul,29 Jul,30 Jul,31 Jul,01 Aug,02 Aug,03 Aug,04 Aug,05 Aug,06 Aug",
    values: [3412.429,3414.1535,3414.9732,3414.4017,3416.3242,3416.6043,3418.2164,3418.7266,3420.4073,3420.5204,3420.8292,3421.4196,3422.644,3422.908,3424.3561,3424.8544,3424.2453,3423.9813,3425.8731,3426.17,3427.1062,3426.7696,3428.124,3429.2273,3430.6671,3431.48,3433.1304,3432.9632,3433.5669,3433.5435,3435.2944,3434.7115,3436.1365,3435.8345,3435.8538,3436.9453,3437.3387,3438.699,3439.1848,3439.2605,3440.0363,3440.4072,3442.4438,3442.4292,3443.1824,3443.4032,3444.8509,3444.3824,3445.7735,3446.3275,3447.9981,3448.293,3448.4864,3449.6306,3450.709,3450.4481,3451.0469,3451.6583,3452.2011,3452.5297,3453.8728,3455.086,3455.4005,3455.381,3457.2386,3457.7513,3457.0809,3458.4007,3458.5901,3459.4171,3460.3377,3462.1223,3462.7846,3462.1474,3462.6368,3463.7256,3463.2051,3463.215,3464.4569,3464.3493,3465.6988,3466.1999,3465.9661,3468.0071,3469.1672,3470.3975,3471.7316,3472.2327,3473.0793,3473.4583,3472.8199,3473.5899,3475.5095,3477.4638,3476.8584,3476.9972,3476.7189,3478.6046,3480.6089,3482.4966,3482.8821,3483.9492,3483.941,3484.7336,3485.2902,3486.804,3487.6331,3487.4293,3488.4126,3487.9235,3487.6958,3488.3166,3488.3986,3490.2431,3490.2167,3489.8738,3490.9806,3490.7208,3490.8913,3492.971,3494.507,3494.6749,3495.7775,3497.4137,3497.1016,3498.2643,3499.071,3499.7248,3499.9226,3500.899,3501.6112,3501.1481,3500.9666,3502.248,3503.9058,3503.5981,3503.9804,3503.9332,3505.84,3505.7001,3506.094,3506.3109,3507.5467,3507.3408,3509.3749,3509.3418,3511.0732,3512.2172,3512.1065,3513.8954,3513.2123,3514.6685,3516.1022,3515.4138,3514.9544,3516.2284,3517.4539,3518.695,3518.0406,3519.3784,3521.4338,3521.5641,3521.1483,3522.0548,3523.7833,3525.4487],
  },
  {
    name: "Series Delta",
    dates: "26 Feb,27 Feb,28 Feb,01 Mar,02 Mar,03 Mar,04 Mar,05 Mar,06 Mar,07 Mar,08 Mar,09 Mar,10 Mar,11 Mar,12 Mar,13 Mar,14 Mar,15 Mar,16 Mar,17 Mar,18 Mar,19 Mar,20 Mar,21 Mar,22 Mar,23 Mar,24 Mar,25 Mar,26 Mar,27 Mar,28 Mar,29 Mar,30 Mar,31 Mar,01 Apr,02 Apr,03 Apr,04 Apr,05 Apr,06 Apr,07 Apr,08 Apr,09 Apr,10 Apr,11 Apr,12 Apr,13 Apr,14 Apr,15 Apr,16 Apr,17 Apr,18 Apr,19 Apr,20 Apr,21 Apr,22 Apr,23 Apr,24 Apr,25 Apr,26 Apr,27 Apr,28 Apr,29 Apr,30 Apr,01 May,02 May,03 May,04 May,05 May,06 May,07 May,08 May,09 May,10 May,11 May,12 May,13 May,14 May,15 May,16 May,17 May,18 May,19 May,20 May,21 May,22 May,23 May,24 May,25 May,26 May,27 May,28 May,29 May,30 May,31 May,01 Jun,02 Jun,03 Jun,04 Jun,05 Jun,06 Jun,07 Jun,08 Jun,09 Jun,10 Jun,11 Jun,12 Jun,13 Jun,14 Jun,15 Jun,16 Jun,17 Jun,18 Jun,19 Jun,20 Jun,21 Jun,22 Jun,23 Jun,24 Jun,25 Jun,26 Jun,27 Jun,28 Jun,29 Jun,30 Jun,01 Jul,02 Jul,03 Jul,04 Jul,05 Jul,06 Jul,07 Jul,08 Jul,09 Jul,10 Jul,11 Jul,12 Jul,13 Jul,14 Jul,15 Jul,16 Jul,17 Jul,18 Jul,19 Jul,20 Jul,21 Jul,22 Jul,23 Jul,24 Jul,25 Jul,26 Jul,27 Jul,28 Jul,29 Jul,30 Jul,31 Jul,01 Aug,02 Aug,03 Aug,04 Aug,05 Aug,06 Aug",
    values: [872.5185,872.6497,872.8715,872.9533,873.319,873.2889,873.3527,873.6948,873.871,874.2596,874.198,874.4928,874.8102,875.0196,875.03,875.2178,875.556,875.6031,876.0995,876.4982,876.4762,876.9266,876.8875,877.3545,877.4811,877.9949,878.4845,878.5044,878.8808,879.1238,878.9871,878.8566,878.8689,879.0845,879.1221,879.3711,879.2158,879.7237,880.168,880.3083,880.1977,880.2983,880.4105,880.6082,880.8568,881.0206,881.4252,881.4923,881.3537,881.7711,881.8779,882.0051,882.2326,882.1223,882.0801,882.3967,882.5859,882.4311,882.923,883.1962,883.1902,883.3474,883.2905,883.5409,883.757,883.8636,884.2841,884.1103,884.2218,884.6027,884.5746,884.7563,884.6183,884.7361,884.8484,884.8172,884.9033,884.737,884.5721,884.817,885.2323,885.4393,885.8507,885.7195,885.5427,885.4907,885.9778,886.1698,886.5076,886.621,886.9195,886.7969,886.6303,887.0991,887.1264,887.2501,887.6885,888.0657,887.9495,888.236,888.6174,888.7153,888.6053,888.8947,888.7596,888.6838,888.6223,888.4541,888.9561,889.1108,889.4148,889.8281,889.8198,889.7169,889.8648,890.1135,889.9671,889.7971,890.0288,890.3913,890.4851,890.5126,890.9882,891.027,891.1899,891.0742,891.4831,891.7611,892.042,892.3134,892.2576,892.2358,892.2896,892.1882,892.3088,892.5428,892.3944,892.4759,892.7439,892.8359,893.1835,893.2144,893.6575,893.8891,894.1865,894.614,894.694,894.8419,894.6858,894.9074,895.404,895.5764,896.1052,896.1097,895.9977,895.9314,896.1865,896.2961,896.2658,896.2541,896.7201,896.6622],
  },
];

export const fixtureDenseTrendCharts = DENSE_TREND_SERIES.map(series => JSON.stringify({
  title: { text: `${series.name} — 6-month trend` },
  tooltip: { trigger: "axis" },
  legend: { show: false },
  grid: { top: 58, left: 8, right: 16, bottom: 8, containLabel: true },
  // Narrow-variance series read as a flat line unless the value axis scales
  // to the data instead of anchoring at zero.
  xAxis: { type: "category", name: "", data: series.dates.split(",") },
  yAxis: { type: "value", name: "Value", scale: true },
  series: [{ name: "Value", type: "line", data: series.values }],
}));

export const fixtureDenseTrendMessage = [
  "📊 Daily Metrics Tracker — 06 Aug 2026",
  "",
  "| # | Metric | Samples | Latest | Daily Δ |",
  "|---|---|---:|---:|---:|",
  "| 1 | Series Alpha | 159 | 250.89 | −0.01 |",
  "| 2 | Series Beta | 175 | 1,219.40 | −0.15 |",
  "| 3 | Series Gamma | 166 | 3,525.45 | +1.67 |",
  "| 4 | Series Delta | 162 | 896.66 | −0.06 |",
  "",
  "Aggregate drift over the window: +4.2%",
  "",
  ...fixtureDenseTrendCharts.flatMap(source => ["```echarts", source, "```", ""]),
].join("\n");

/* Schedules: a daily loop post in a thread, a 6-hourly channel watchdog, and
   a paused one whose owner lost access — the three states the panes show.
   Times are fixed so stories render deterministically. */
const scheduleBase = {
  owner: "tom",
  owner_name: "Tom",
  channel_id: "general",
  channel_name: "storybook",
  channel_kind: "normal",
  group_id: "product",
  last_error: null,
  created_at: 1_750_000_000,
  updated_at: 1_750_000_000,
  created_by: "tom",
  updated_by: "tom",
  can_manage: true,
  is_owner: true,
} satisfies Partial<Schedule>;

export const fixtureSchedules: Schedule[] = [
  {
    ...scheduleBase,
    id: "sch-loop",
    thread_id: 42,
    thread_title: "Responsive layout loop",
    text: "@claude LOOP responsive-review · run 12 · check the layout matrix and re-arm.",
    schedule: { kind: "cron", expr: "0 7 * * 1-5" },
    run_at: 1_750_057_200,
    next_runs: [1_750_057_200, 1_750_143_600, 1_750_230_000],
    status: "active",
    last_run_at: 1_749_970_800,
    via_agent: "claude-cli",
  },
  {
    ...scheduleBase,
    id: "sch-watchdog",
    thread_id: null,
    thread_title: null,
    text: "@claude watchdog: list loops that are not armed and not done.",
    schedule: { kind: "interval", seconds: 21_600 },
    run_at: 1_750_021_200,
    next_runs: [1_750_021_200, 1_750_042_800, 1_750_064_400],
    status: "active",
    last_run_at: 1_749_999_600,
    via_agent: "codex-cli",
  },
  {
    ...scheduleBase,
    id: "sch-paused",
    owner: "alice",
    owner_name: "Alice",
    thread_id: null,
    thread_title: null,
    text: "@cursor weekly dependency report",
    schedule: { kind: "once", at: 1_750_100_000 },
    run_at: 1_750_100_000,
    next_runs: [1_750_100_000],
    status: "paused",
    last_run_at: null,
    last_error: "alice can no longer post in #storybook",
    via_agent: null,
    can_manage: false,
    is_owner: false,
  },
];
