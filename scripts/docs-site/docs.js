/* Progressive enhancement for the generated docs pages: mobile drawer,
   copy buttons, TOC scroll-spy, and client-side search over the
   build-time search-index.json. Pages stay fully readable without JS. */

(() => {
  "use strict";

  // Site-root prefix for the current page ("" at the root, "../" one level
  // down); search hrefs in the index are site-root-relative.
  const ROOT = document.body.dataset.root || "";

  // ----- mobile drawer -----
  const menuBtn = document.getElementById("menu-btn");
  const scrim = document.getElementById("scrim");
  const closeNav = () => document.body.classList.remove("nav-open");
  menuBtn?.addEventListener("click", () => document.body.classList.toggle("nav-open"));
  scrim?.addEventListener("click", closeNav);

  // ----- progressive-enhancement tabs -----
  const tabGroups = Array.from(document.querySelectorAll("[data-doc-tabs]"));
  const activateTab = (group, tabId, { focus = false } = {}) => {
    const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
    const panels = Array.from(group.querySelectorAll('[role="tabpanel"]'));
    const selected = tabs.find((tab) => tab.dataset.tab === tabId) || tabs[0];
    if (!selected) return;
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.tab !== selected.dataset.tab; });
    if (focus) selected.focus();
    document.dispatchEvent(new CustomEvent("docs:tabchange"));
  };
  const activateTabForHash = ({ scroll = false } = {}) => {
    if (!location.hash) return;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const panel = target?.closest('[role="tabpanel"]');
    const group = panel?.closest("[data-doc-tabs]");
    if (!panel || !group) return;
    activateTab(group, panel.dataset.tab);
    if (scroll) requestAnimationFrame(() => target.scrollIntoView());
  };
  tabGroups.forEach((group) => {
    group.classList.add("tabs-enhanced");
    const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        activateTab(group, tab.dataset.tab);
        history.pushState(null, "", `#${tab.dataset.tab}`);
      });
      tab.addEventListener("keydown", (event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        activateTab(group, tabs[next].dataset.tab, { focus: true });
        history.pushState(null, "", `#${tabs[next].dataset.tab}`);
      });
    });
    const initialPanel = location.hash
      ? document.getElementById(decodeURIComponent(location.hash.slice(1)))?.closest('[role="tabpanel"]')
      : null;
    activateTab(group, initialPanel?.dataset.tab || tabs[0]?.dataset.tab);
  });
  window.addEventListener("hashchange", () => activateTabForHash({ scroll: true }));
  window.addEventListener("popstate", () => activateTabForHash({ scroll: true }));

  // ----- copy buttons on code blocks -----
  document.querySelectorAll(".code-block").forEach((block) => {
    const pre = block.querySelector("pre");
    if (!pre) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.textContent = "Copied";
        btn.classList.add("ok");
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("ok");
      }, 1400);
    });
    block.appendChild(btn);
  });

  // ----- TOC scroll-spy -----
  const tocLinks = Array.from(document.querySelectorAll(".toc a"));
  if (tocLinks.length) {
    let pairs = [];
    const rebuildPairs = () => {
      const activeTabs = new Set(
        Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map((tab) => tab.dataset.tab),
      );
      tocLinks.forEach((link) => {
        link.hidden = !!link.dataset.tab && !activeTabs.has(link.dataset.tab);
      });
      pairs = tocLinks
      .filter((link) => !link.hidden)
      .map((link) => {
        const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
        return heading ? { heading, link } : null;
      })
      .filter(Boolean);
    };
    const spy = () => {
      let current = pairs[0];
      for (const pair of pairs) {
        if (pair.heading.getBoundingClientRect().top <= 90) current = pair;
        else break;
      }
      tocLinks.forEach((l) => l.classList.toggle("active", l === current?.link));
    };
    let ticking = false;
    document.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          spy();
        });
      },
      { passive: true },
    );
    document.addEventListener("docs:tabchange", () => {
      rebuildPairs();
      spy();
    });
    rebuildPairs();
    spy();
  }

  // ----- search -----
  const input = document.getElementById("search-input");
  const resultsEl = document.getElementById("search-results");
  if (input && resultsEl) {
    let index = null;
    let selected = -1;

    const closeSearch = () => {
      resultsEl.hidden = true;
      selected = -1;
    };

    const loadIndex = async () => {
      if (index) return;
      try {
        const res = await fetch(ROOT + "search-index.json");
        index = await res.json();
      } catch {
        index = [];
      }
    };

    const escapeHtml = (value) =>
      String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[ch]);

    const highlight = (text, query) => {
      const at = text.toLowerCase().indexOf(query.toLowerCase());
      if (at === -1) return escapeHtml(text);
      return (
        escapeHtml(text.slice(0, at)) +
        "<mark>" + escapeHtml(text.slice(at, at + query.length)) + "</mark>" +
        escapeHtml(text.slice(at + query.length))
      );
    };

    const render = (query) => {
      const q = query.trim().toLowerCase();
      if (!q || !index) {
        closeSearch();
        return;
      }
      const scored = [];
      for (const entry of index) {
        const heading = entry.h || entry.t;
        const hay = heading.toLowerCase();
        const inTitle = entry.t.toLowerCase().includes(q);
        if (!hay.includes(q) && !inTitle) continue;
        let score = 0;
        if (hay.startsWith(q)) score += 3;
        if (hay.includes(q)) score += 2;
        if (!entry.h) score += 1; // page titles above section hits
        scored.push({ entry, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 12);
      if (!top.length) {
        resultsEl.innerHTML = '<span class="r-empty">No matches</span>';
        resultsEl.hidden = false;
        selected = -1;
        return;
      }
      resultsEl.innerHTML = top
        .map(({ entry }) => {
          const href = ROOT + entry.p + (entry.id ? "#" + entry.id : "");
          const main = highlight(entry.h || entry.t, q);
          const context = entry.h ? escapeHtml(entry.t) : "Guide";
          return `<a href="${href}"><span class="r-h">${main}</span><span class="r-p">${context}</span></a>`;
        })
        .join("");
      resultsEl.hidden = false;
      selected = -1;
    };

    const move = (delta) => {
      const items = Array.from(resultsEl.querySelectorAll("a"));
      if (!items.length) return;
      selected = (selected + delta + items.length) % items.length;
      items.forEach((item, i) => item.classList.toggle("active", i === selected));
      items[selected].scrollIntoView({ block: "nearest" });
    };

    input.addEventListener("focus", loadIndex);
    input.addEventListener("input", async () => {
      await loadIndex();
      render(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter") {
        const active = resultsEl.querySelector("a.active") || resultsEl.querySelector("a");
        if (active && !resultsEl.hidden) {
          event.preventDefault();
          window.location.href = active.getAttribute("href");
        }
      } else if (event.key === "Escape") {
        closeSearch();
        input.blur();
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search")) closeSearch();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeNav();
        closeSearch();
      } else if (
        event.key === "/" &&
        !event.metaKey && !event.ctrlKey && !event.altKey &&
        !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || "")
      ) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }
})();
