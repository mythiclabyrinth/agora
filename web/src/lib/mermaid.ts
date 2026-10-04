/* Lazy mermaid rendering over the vendored /mermaid.min.js, loaded on
   demand the first time a diagram is on screen. Document-wide and
   self-recursing:
   render results are cached by graph source ("" = known-bad) and re-applied
   whenever a caller kicks the runner, so late mounts and re-renders always
   converge. */

declare global {
  interface Window {
    mermaid?: {
      initialize(cfg: Record<string, unknown>): void;
      render(id: string, src: string): Promise<{ svg: string }>;
    };
  }
}

const svgCache = new Map<string, string>(); // graph source -> svg ("" = failed)
const sources = new WeakMap<HTMLElement, string>();
let renderQueue = Promise.resolve();
let loadPromise: Promise<void> | null = null;
let seq = 0;

function loadMermaid(): Promise<void> {
  if (window.mermaid) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = new Promise<void>((resolve) => {
      const s = document.createElement("script");
      s.src = "/mermaid.min.js";
      s.onload = () => resolve();
      s.onerror = () => { loadPromise = null; resolve(); };
      document.head.appendChild(s);
    });
  }
  return loadPromise;
}

async function renderDiagrams(): Promise<void> {
  const theme = document.documentElement.dataset.theme === "light" ? "default" : "dark";
  const nodes = [...document.querySelectorAll<HTMLElement>(".md-mermaid")]
    .filter(node => !node.classList.contains("rendered") || node.dataset.diagramTheme !== theme);
  if (!nodes.length) return;
  // Apply what's cached; collect what still needs a render.
  const need = new Set<string>();
  nodes.forEach(node => {
    const src = node.classList.contains("rendered") ? sources.get(node) || "" : (node.textContent || "").trim();
    sources.set(node, src);
    const svg = svgCache.get(`${theme}:${src}`);
    if (svg) {
      node.innerHTML = svg;
      node.classList.add("rendered");
      node.dataset.diagramTheme = theme;
    } else if (svg === undefined) {
      need.add(src);
    }
  });
  if (!need.size) return;
  await loadMermaid();
  if (!window.mermaid) return; // offline/blocked: leave the code standing
  window.mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
  for (const src of need) {
    const key = `${theme}:${src}`;
    if (svgCache.has(key)) continue;
    const id = `ago-mmd-${++seq}`;
    try {
      const { svg } = await window.mermaid.render(id, src);
      svgCache.set(key, svg);
    } catch {
      svgCache.set(key, "");
      // Mermaid can leave its scratch element behind on a parse error.
      const scratch = document.getElementById(id) || document.getElementById(`d${id}`);
      if (scratch) scratch.remove();
    }
  }
  // Apply what just rendered (nodes may have re-mounted meanwhile).
  await renderDiagrams();
}

export function renderMermaid(): Promise<void> {
  // Mermaid's renderer/config are global. Serialize renders so rapid appearance
  // changes cannot apply an SVG using another diagram's theme configuration.
  renderQueue = renderQueue.then(renderDiagrams, renderDiagrams);
  return renderQueue;
}
