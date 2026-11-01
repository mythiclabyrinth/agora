import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureAgentMessage, fixtureGroups, fixtureMe } from "@agora/core/testing/fixtures";
import type { FixtureRoutes } from "@agora/core/testing/FixtureApiClient";
import SearchScreen from "../../app/(app)/search";

const messages = Array.from({ length: 56 }, (_, i) => ({
  ...fixtureAgentMessage, id: 1000 + i, attachments: [], channel_name: "storybook", group_id: "product", group_name: "Product",
  ts: 1793500000 - i * 3600, snippet: `The native \u0001catalog\u0002 review, update ${i + 1}.`,
}));
const channels = Array.from({ length: 6 }, (_, i) => ({
  id: `c${i}`, name: `catalog-${i + 1}`, group_id: "product", group_name: "Product", topic: "Native catalog planning", hidden: false,
}));
const threads = Array.from({ length: 6 }, (_, i) => ({
  id: 2000 + i, alias: `Catalog review ${i + 1}`, channel_id: "general", channel_name: "storybook", group_id: "product", group_name: "Product",
  reply_count: 12 - i, last_activity: 1793500000 - i * 3600,
}));
const groups = [{ id: "product", name: "Product catalog", description: "Planning", hidden: false }];
const routes: FixtureRoutes = {
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/me": { ...fixtureMe, search_ai: false },
};
// Type "catalog" or use Results. The fixtures cover tabs, sort, scope,
// attachment filters and a second page of messages.
const scopes = ["", ...fixtureGroups.flatMap(g => [`&group_id=${g.id}`, ...g.channels.map(c => `&channel_id=${c.id}`)])];
for (const scope of scopes) {
  for (const file of ["", "&has_files=1", ...["image", "pdf", "doc", "video", "audio"].map(t => `&file_type=${t}`)]) {
    for (const sort of ["", "&sort=new"]) {
      const q = `GET /api/search?q=catalog${scope}${file}${sort}` as const;
      routes[`${q}&types=messages,channels,groups,threads&totals=1&limit=5`] = {
        query: "catalog", groups: file ? [] : groups, groups_total: file ? 0 : 1,
        channels: file ? [] : channels.slice(0, 5), channels_total: file ? 0 : channels.length,
        threads: { items: file ? [] : threads.slice(0, 5), total: file ? 0 : threads.length, offset: 0, has_more: !file },
        messages: { items: messages.slice(0, 5), total: messages.length, has_more: true, offset: 0 },
      };
      routes[`${q}&types=messages&limit=50`] = { query: "catalog", messages: { items: messages.slice(0, 50), has_more: true, offset: 0 } };
      routes[`GET /api/search?q=catalog&offset=50&types=messages${scope}${file}${sort}&limit=50`] = {
        query: "catalog", messages: { items: messages.slice(50), has_more: false, offset: 50 },
      };
    }
  }
  routes[`GET /api/search?q=catalog${scope}&types=channels&limit=50&totals=1`] = { query: "catalog", channels, channels_total: channels.length };
  routes[`GET /api/search?q=catalog${scope}&types=groups&limit=50&totals=1`] = { query: "catalog", groups, groups_total: groups.length };
  routes[`GET /api/search?q=catalog${scope}&types=threads&limit=50&totals=1`] = {
    query: "catalog", threads: { items: threads, total: threads.length, has_more: false, offset: 0 },
  };
}

const meta = {
  title: "Native/Screens/Search",
  component: SearchScreen,
  parameters: { apiRoutes: routes },
} satisfies Meta<typeof SearchScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReadyForQuery: Story = {};
export const Results: Story = { args: { initialQuery: "catalog" } };
