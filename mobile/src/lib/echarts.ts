import type { NormalizedEChart } from "@agora/core";
import { themes, type AppTheme } from "./theme";

const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js";

/* The stage fills the WebView viewport rather than taking the option's own
   pixel height: the native side owns the box (bounded inline, full height when
   expanded), so a phone rotation or a taller device repaints at the new size
   instead of leaving dead space below the chart. */
export function echartHtml(chart: NormalizedEChart, theme: AppTheme = themes.dark): string {
  const option = JSON.stringify(chart.option).replace(/</g, "\\u003c");
  const source = JSON.stringify(JSON.stringify(chart.option, null, 2)).replace(/</g, "\\u003c");
  const width = chart.width ? `${chart.width}px` : "100vw";
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<style>
html,body{margin:0;background:${theme.colors.bg};color:${theme.colors.text};overflow-x:auto;overflow-y:hidden}
#stage{width:${width};min-width:100vw;height:100vh}#err{padding:14px;color:${theme.colors.red};font:12px ui-monospace,monospace;white-space:pre-wrap}
</style></head><body><div id="stage"></div><script src="${ECHARTS_CDN}"></script><script>
(()=>{const stage=document.getElementById("stage");try{if(!window.echarts)throw new Error("Could not load the chart renderer (offline?)");const chart=echarts.init(stage,${theme.mode === "dark" ? '"dark"' : "null"},{renderer:"canvas"});chart.setOption(${option});const resize=()=>chart.resize();addEventListener("resize",resize);if(window.ResizeObserver)new ResizeObserver(resize).observe(stage)}catch(e){const err=document.createElement("div");err.id="err";err.textContent=String(e&&e.message||e)+"\\n\\n"+${source};stage.replaceWith(err)}})();
</script></body></html>`;
}
