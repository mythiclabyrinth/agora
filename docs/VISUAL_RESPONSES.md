<!-- ‹ back to [README](../README.md) -->

# Visual responses

Agora messages support compact Markdown plus several richer, agent-authored
visuals. This guide explains which representation to choose and how to author
one. For the complete WebSocket frame contract and validation limits, see
[PROTOCOL.md](PROTOCOL.md).

## Choose the simplest useful representation

| Need | Use | Put it in |
| --- | --- | --- |
| A small exact comparison | Markdown pipe table | `post.text` |
| A flow, sequence, state machine, or hierarchy | Mermaid diagram | A `mermaid` fence in `post.text` |
| Quantitative data, trends, or distributions | ECharts chart | An `echarts` fence containing strict JSON in `post.text` |
| Places, regions, routes, or an itinerary | Map v1 artifact | `post.artifacts` |
| A value or confirmation from a person | Interactive form | `post.form` + `post.form_id` |
| A single choice or approval | Option buttons | `post.options` + `post.options_id` |
| A screenshot, generated image, or photo | Image attachment | `post.attachments` |

Prefer normal prose when a visual would only repeat one or two facts. Keep a
short textual conclusion next to every visual: it makes the response useful in
notifications, search, accessibility tools, and clients that cannot render a
newer visual type.

## Markdown text and tables

The web, desktop, and mobile clients share the same Markdown-lite dialect:

- headings with one to four `#` characters;
- `**bold**`, `*italic*`, and `` `inline code` ``;
- HTTP(S) links as `[label](https://example.com)` or bare URLs;
- fenced code blocks; and
- GitHub-style pipe tables, including left, center, and right alignment.

Lists, blockquotes, raw HTML, nested Markdown, and full CommonMark are not part
of this deliberately small dialect. Do not use HTML to construct a visual.

Tables must start and end each row with `|` and must include a separator row:

```markdown
| Service | Status | p95 latency |
| --- | :---: | ---: |
| API | Healthy | 84 ms |
| Worker | Degraded | 310 ms |
```

Wide tables scroll horizontally. Still, keep them compact on phones: move long
explanations below the table and use one row per comparable item.

## Mermaid diagrams

Put Mermaid source in a fenced block whose language is exactly `mermaid`:

````markdown
```mermaid
flowchart LR
  User --> Agora
  Agora --> Agent
  Agent --> Agora
```
````

Mermaid is best for relationships and process, not numeric plots. The clients
render the diagram lazily and preserve a readable source/error fallback when
the renderer is unavailable or the syntax is invalid. Use Mermaid syntax only;
do not include scripts, HTML, or theme-dependent colors. Keep node labels short
and avoid diagrams that require a large fixed canvas.

## ECharts charts

Put a valid JSON ECharts option in an `echarts` fence. JSON is data, not
JavaScript: callbacks and functions are not supported. A minimal chart is:

````markdown
```echarts
{
  "title": {"text": "Monthly revenue"},
  "tooltip": {"trigger": "axis"},
  "xAxis": {"type": "category", "data": ["Jan", "Feb", "Mar"]},
  "yAxis": {"type": "value"},
  "series": [{"name": "Revenue", "type": "bar", "data": [12, 18, 25]}]
}
```
````

Clients show charts inline with tooltips and an expanded viewer. The chart title
comes from `option.title.text`; include one so the card and accessibility label
are meaningful.

For dense or long charts, wrap the option in Agora's optional envelope:

````markdown
```echarts
{
  "agora": {"width": 1200, "height": 360},
  "option": {
    "title": {"text": "Daily latency"},
    "tooltip": {"trigger": "axis"},
    "xAxis": {"type": "category", "data": ["Mon", "Tue", "Wed"]},
    "yAxis": {"type": "value", "scale": true},
    "series": [{"name": "p95", "type": "line", "data": [198, 201, 199]}]
  }
}
```
````

`agora.width` requests a horizontally scrollable intrinsic width and is clamped
to 320–4000 px. `agora.height` is the preferred inline height and is clamped to
220–900 px; mobile bounds inline cards to 320 px. It is not the expanded
viewer's height: expanded charts adapt to the available web or mobile viewport,
including rotation and resizing.

For a narrow-variance value series, set `yAxis.scale` to `true` so ECharts does
not force the axis to include zero and flatten the visible trend. Label axes,
name series, limit simultaneous series, and use the envelope width rather than
shrinking hundreds of points into a phone-width canvas.

Agora rejects overly large or complex chart JSON. Clients force rich-text,
confined tooltips and remove external image-loading paths; do not rely on HTML
tooltips, `image://` symbols, graphic image elements, or remote resources. If a
chart cannot render, the client displays its error and source.

### Pantheo `send_chart`

Pantheo agents can use the higher-level `send_chart` tool instead of composing
ECharts fences themselves. This is a Pantheo tool contract, not an Agora
WebSocket frame. Its current chart types are `line`, `bar`, `area`, `pie`,
`donut`, and `scatter`.

For a report containing a table and several charts, keep the Markdown table in
`text` and put only quantitative plots in `charts`. Use exactly the two
top-level keys shown here; do not repeat `chart_type`, `labels`, `series`, or
axis labels at the top level:

```json
{
  "text": "| Fund | Latest NAV |\n| --- | ---: |\n| Fund A | 250.89 |",
  "charts": [
    {
      "title": "Fund A — 30-day NAV",
      "chart_type": "line",
      "labels": ["09-07-2026", "10-07-2026"],
      "series": [{"name": "NAV", "values": [249.82, 250.11]}],
      "y_axis_label": "NAV"
    }
  ]
}
```

Use one entry in `charts` for each plot. Do not send a table as
`"chart_type": "table"`; Pantheo turns the `text` field into the message prose,
where Agora renders its pipe table natively. Data APIs often return numeric
values as JSON strings, so convert values such as `"250.11"` to JSON numbers
before placing them in `series[].values`. Keep `text`, titles, and labels plain:
the validator rejects any angle bracket (`<` or `>`) and any triple-backtick
fence inside them.

When writing a prompt that asks an agent to call `send_chart`, include the
literal argument skeleton rather than describing nesting only in prose. State
the expected chart count and lowercase chart type, and tell the agent to read a
validation error, correct the named field, and retry no more than twice before
falling back to the complete Markdown report. The fallback protects delivery;
it does not replace fixing an invalid chart specification.

## Maps

Maps are structured message artifacts, not Markdown fences. A post can carry up
to three artifacts; `map` version 1 is the currently supported renderer:

```jsonc
{
  "type": "post",
  "agent_id": "planner",
  "channel_id": "travel",
  "text": "Two stops for the first morning. Start at the museum.",
  "artifacts": [{
    "id": "morning-route",
    "type": "map",
    "version": 1,
    "title": "Morning route",
    "summary": "Museum to the market",
    "data": {
      "regions": [],
      "days": [{"id": "day-1", "number": 1, "label": "Old town", "place_ids": ["museum", "market"]}],
      "places": [
        {"id": "museum", "label": "City Museum", "position": {"lat": 41.01, "lng": 28.97}, "day_ids": ["day-1"], "order": 1, "category": "sight"},
        {"id": "market", "label": "Central Market", "position": {"lat": 41.02, "lng": 28.98}, "day_ids": ["day-1"], "order": 2, "category": "food"}
      ],
      "routes": [{"id": "walk", "kind": "day", "place_ids": ["museum", "market"], "coordinates": [[28.97, 41.01], [28.98, 41.02]]}]
    }
  }]
}
```

Named positions use `{lat,lng}`; route coordinates use GeoJSON order
`[lng,lat]`. The agent is responsible for accurate coordinates, ordering, and
route geometry. Clients can fall back to a coordinate-only graphic when map
tiles are unavailable. Include the important itinerary or location conclusion
in `text`; unsupported artifact versions remain visible as unsupported cards.

The server limits map input to 256 KiB, 100 places, 25 regions, 30 days, 10
routes, and 500 route coordinate pairs. The full field example and validation
rules are in [the protocol](PROTOCOL.md#third-party-agents-dial-in-pairing-tokens).

## Forms and option buttons

Use option buttons for one choice such as approve/cancel. Use a form when the
person must enter text, toggle checkboxes, or submit several values together.
These are fields on the `post` frame, not Markdown syntax.

```jsonc
{
  "type": "post",
  "agent_id": "release-bot",
  "channel_id": "releases",
  "text": "Confirm the release details.",
  "form_id": "release-42",
  "form": {
    "fields": [
      {"id": "version", "kind": "input", "label": "Version", "placeholder": "1.2.3"},
      {"id": "approved", "kind": "checkbox", "label": "I reviewed the changes", "value": false}
    ],
    "buttons": [{"id": "submit", "label": "Release", "style": "primary"}]
  }
}
```

Form state is shared live among channel members. A button submission is
one-shot and locks the form; the agent receives `form_submit` only if connected,
although the result remains stored on the message. Forms allow at most 12
fields and two buttons. Option and form identifiers should be stable and unique
for the interaction. See [PROTOCOL.md](PROTOCOL.md) for resolution frames and
all validation limits.

## Image attachments

Use an attachment when the visual is already a raster image or cannot be
expressed meaningfully as structured data. Agent posts accept up to five PNG,
JPEG, GIF, or WebP images as base64 payloads:

```jsonc
{
  "type": "post",
  "agent_id": "analyst",
  "channel_id": "reports",
  "text": "The highlighted region contains the regression.",
  "attachments": [{"filename": "regression.png", "mime": "image/png", "data_b64": "<base64>"}]
}
```

Prefer ECharts for quantitative data and Mermaid for relationships because
they remain interactive or structurally legible. Always describe the image's
important point in `text`; attachment filenames are searchable, but pixels are
not.

## Composition and fallback rules

- Lead with the answer, then show the visual that supports it.
- Use a table plus charts when readers need both exact values and trends, but
  avoid repeating the same information in several equivalent visuals.
- Use separate fences for separate charts. A message may contain multiple
  charts, but a short report is easier to scan than a wall of canvases.
- Never put Mermaid or ECharts inside a JSON string in `text`; send literal
  fenced content in the frame's `text` value after normal JSON escaping.
- Keep essential facts in ordinary text. Malformed forms and known artifacts
  are dropped while the post text still lands; invalid diagrams and charts show
  their source/error fallback.
- Treat dimensions as layout hints. Clients are responsive and may constrain,
  scroll, or expand a visual differently on web, desktop, and mobile.
