/* ============================================================================
   Patchery — docs/assets/site.js

   No animation library. No smooth-scroll library. Nothing here decides whether
   anything is visible — the stylesheet already renders a complete, readable
   page on its own, and every custom property this file writes has an initial
   value that means "nothing has happened yet".

   That is not minimalism for its own sake. An earlier build hid all of its
   content in CSS and handed the job of revealing it to JavaScript springs
   running on the animation frame loop. When that loop stalled — a busy laptop,
   a background tab, one dropped frame — the page froze part-way and stayed
   black. Everything below is written so that failing to run is survivable.
   ========================================================================== */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ══════════════════════════  boot  ══════════════════════════ */

  var boot = $("#boot"), bootBar = $("#bootBar"), booted = false;

  function finishBoot() {
    if (booted) return;
    booted = true;
    if (bootBar) bootBar.style.width = "100%";
    setTimeout(function () {
      if (boot) boot.classList.add("is-done");
      document.body.classList.remove("is-loading");
    }, reduced ? 0 : 240);
  }

  if (bootBar && !reduced) {
    var p = 0;
    var creep = setInterval(function () {
      p = Math.min(88, p + 6 + Math.random() * 12);
      bootBar.style.width = p + "%";
      if (booted) clearInterval(creep);
    }, 90);
  }

  var ready = [];
  if (document.fonts && document.fonts.ready) ready.push(document.fonts.ready);
  ready.push(new Promise(function (res) {
    if (document.readyState === "complete") res();
    else window.addEventListener("load", res, { once: true });
  }));
  Promise.all(ready).then(finishBoot);
  setTimeout(finishBoot, reduced ? 0 : 2400);   // never hold the page hostage

  /* ══════════════════  chrome, folio, progress  ══════════════════ */

  var nav = $("#nav");
  var folio = $("#folio"), folioNow = $("#folioNow"), folioName = $("#folioName");
  var fillEl = $("#scrollbarFill");
  var sections = $$("[data-folio]");
  var menu = $("#menu");
  var lastY = 0, lastFolio = "";

  function chromeUpdate() {
    var y = window.scrollY || window.pageYOffset;

    if (nav) {
      nav.classList.toggle("is-stuck", y > 40);
      nav.classList.toggle("is-hidden", y > 460 && y > lastY + 4 && !(menu && menu.open));
    }
    lastY = y;

    var probe = y + 90, here = null;
    for (var i = 0; i < sections.length; i++) {
      if (probe >= sections[i].offsetTop) here = sections[i];
    }
    if (!here) here = sections[0];
    if (!here) return;

    var id = here.getAttribute("data-folio");
    if (id !== lastFolio) {
      lastFolio = id;
      if (folioNow) folioNow.textContent = id;
      if (folioName) folioName.textContent = here.getAttribute("data-folio-name") || "";
    }

    var onPaper = here.hasAttribute("data-invert");
    if (nav) nav.classList.toggle("on-paper", onPaper);
    if (folio) folio.classList.toggle("on-paper", onPaper);
  }

  /* The sections index opens and closes on its own — it is a <details>, and
     that is deliberate: if this file never loads, it still works. Everything
     here is convenience laid on top: close it once you have chosen, close it
     on Escape, close it when you click past it. */
  if (menu) {
    menu.addEventListener("click", function (e) {
      if (e.target.closest(".menu__panel a")) menu.open = false;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.open) {
        menu.open = false;
        var sum = menu.querySelector("summary");
        if (sum) sum.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
  }

  /* ══════════════════  the vanishing line  ══════════════════

     Where the browser supports scroll-driven animation the whole effect is in
     the stylesheet, running on the compositor, and this does nothing. Where it
     does not, the same three properties are written from scroll position —
     still a pure function of where the page is, never of elapsed time, so it
     cannot end up stranded half-finished. */

  var vanish = $("#vanish");
  var vanishNative = window.CSS && CSS.supports && CSS.supports("animation-timeline: view()");

  function vanishUpdate() {
    if (!vanish || vanishNative || reduced) return;
    var r = vanish.getBoundingClientRect();
    var h = window.innerHeight;
    var t = Math.min(1, Math.max(0, 1 - (r.top + r.height * 0.35) / (h * 0.75)));

    var strike = t < 0.38 ? t / 0.38 : t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.28);
    var erase  = t < 0.38 ? 0 : Math.min(1, (t - 0.38) / 0.34);
    var note   = t < 0.72 ? 0 : Math.min(1, 0.35 + 0.65 * ((t - 0.72) / 0.28));

    vanish.style.setProperty("--strike", (strike * 100).toFixed(1) + "%");
    vanish.style.setProperty("--erase",  (erase  * 100).toFixed(1) + "%");
    vanish.style.setProperty("--note",   note.toFixed(3));
  }

  /* ══════════════════════════  the pinned run  ══════════════════════════ */

  var track = $("#pipeTrack");
  var screens = $$(".scr");
  var railItems = $$(".rail__i");
  var STEPS = screens.length;
  var current = -1;
  var stacked = window.matchMedia("(max-width: 860px)");

  function setStep(n) {
    if (n === current) return;
    current = n;
    screens.forEach(function (s, i) {
      s.classList.toggle("is-on", i === n);
      s.classList.toggle("is-back", i > n);
    });
    railItems.forEach(function (r, i) {
      r.classList.toggle("is-on", i === n);
      r.classList.toggle("is-past", i < n);
    });
    onStepEnter(n);
  }

  function pipeUpdate() {
    if (!track || stacked.matches) return;
    var r = track.getBoundingClientRect();
    var span = r.height - window.innerHeight;
    if (span <= 0) return;
    var t = Math.min(1, Math.max(0, -r.top / span));
    setStep(Math.min(STEPS - 1, Math.floor(t * STEPS)));
  }

  function handleLayout() {
    current = -1;
    if (stacked.matches) {
      screens.forEach(function (s, i) {
        s.classList.remove("is-on", "is-back");
        onStepEnter(i);
      });
      railItems.forEach(function (r) { r.classList.remove("is-on", "is-past"); });
    } else {
      pipeUpdate();
    }
  }
  stacked.addEventListener ? stacked.addEventListener("change", handleLayout)
                           : stacked.addListener(handleLayout);

  /* ── per-step detail ── */

  var timers = {};

  function typeLines(code, speed) {
    var key = code.getAttribute("data-key");
    if (!key) { key = "t" + Math.random().toString(36).slice(2); code.setAttribute("data-key", key); }
    clearTimeout(timers[key]);

    var src = code.getAttribute("data-src");
    if (src === null) { src = code.innerHTML; code.setAttribute("data-src", src); }
    if (reduced) { code.innerHTML = src; return; }

    // No tag in these blocks spans a newline, so splitting on \n is safe.
    var lines = src.split("\n");
    var i = 0;
    (function step() {
      code.innerHTML = lines.slice(0, i).join("\n") +
        (i < lines.length ? '\n<span class="caret"></span>' : "");
      if (i++ < lines.length) timers[key] = setTimeout(step, speed);
    })();
  }

  var FROM = "formatPrice(amount)";
  var TO   = 'formatPrice(amount, "USD")';
  var rewriteTimer = null;

  function runRewrite(el) {
    clearTimeout(rewriteTimer);
    if (reduced) { el.textContent = TO; return; }

    var shared = 0;
    while (shared < FROM.length && FROM[shared] === TO[shared]) shared++;
    el.textContent = FROM;
    var n = FROM.length;

    function erase() {
      if (n > shared) { el.textContent = FROM.slice(0, --n); rewriteTimer = setTimeout(erase, 42); }
      else rewriteTimer = setTimeout(write, 240);
    }
    function write() {
      if (n >= TO.length) return;
      el.textContent = TO.slice(0, ++n);
      rewriteTimer = setTimeout(write, 56);
    }
    rewriteTimer = setTimeout(erase, 1300);
  }

  function onStepEnter(n) {
    var scr = screens[n];
    if (!scr) return;
    var typed = $("code[data-type]", scr);
    if (typed) typeLines(typed, 50);
    if (n === 1) {
      var rw = $("#rewrite", scr);
      if (rw) runRewrite(rw);
    }
  }

  /* ══════════════════  one scroll driver  ══════════════════

     Throttled on the clock rather than coalesced into requestAnimationFrame.
     rAF only fires while the browser is rendering, so putting scroll work
     inside it means the handler stops exactly when things are going wrong.
     Everything below is a pure function of scroll position; running it late is
     harmless, and running it never is not an option. */

  var lastRun = -1;

  function onScroll() {
    chromeUpdate();
    if (fillEl) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      fillEl.style.transform = "scaleX(" + (max > 0 ? window.scrollY / max : 0).toFixed(4) + ")";
    }
    pipeUpdate();
    vanishUpdate();
  }

  window.addEventListener("scroll", function () {
    var now = performance.now();
    if (now - lastRun < 8) return;
    lastRun = now;
    onScroll();
  }, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  /* ══════════════════════════  the guard  ══════════════════════════ */

  /* Copied verbatim from protectedReason() in scripts/guard.mjs. It is one of
     several checks a real run makes — deletions, and writes outside the target
     folder, are refused separately — but this is the off-limits list itself. If
     this and the repo ever disagree, the repo is right and this page is a lie. */
  function protectedReason(relPath) {
    var p = String(relPath).replace(/\\/g, "/");
    if (/(^|\/)node_modules\//.test(p)) return "inside node_modules";
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return "test file";
    if (/(^|\/)(__tests__|__mocks__|tests?)\//.test(p)) return "inside a test directory";
    if (/(^|\/)\.github\//.test(p)) return "CI configuration";
    // The test files themselves are protected, but the file that decides which tests
    // run was not: excluding a spec in vitest.config.js turns the build green without
    // touching a single test. Deterministic rule first; an agent reviewing the diff is
    // a backstop, not the only line of defence.
    if (
      /(^|\/)(jest|vitest|playwright|cypress|karma)\.(config|conf)\.[cm]?[jt]s$/.test(p) ||
      /(^|\/)\.mocharc\.[^/]+$/.test(p) ||
      /(^|\/)(jest|vitest)\.setup\.[cm]?[jt]s$/.test(p) ||
      /(^|\/)setupTests\.[cm]?[jt]sx?$/.test(p)
    ) {
      return "test harness configuration";
    }
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)) return "lockfile";
    return null;
  }

  /* Handed to audit.js, which fetches guard.mjs from GitHub and checks that
     what is running here really is what is in the repository. */
  window.PatcheryGuard = protectedReason;

  /* ══════════════════  the run figures  ══════════════════

     The demo fixture is committed broken so the run can be repeated, which
     means its turn count and cost change every time somebody repeats it. The
     numbers in the HTML are correct at the moment it was written and are what
     a reader with no JavaScript sees; this re-reads them from the pull request
     itself and corrects them if the demo has been run again since.

     If the request fails, or GitHub rate-limits the browser, nothing happens
     and the typed figures stand. Nothing on this page is hidden waiting for
     this to succeed. */
  (function () {
    var slots = $$("[data-run]");
    if (!slots.length || typeof fetch !== "function") return;

    fetch("https://api.github.com/repos/patchery-dev/Patchery/pulls/2", {
      headers: { Accept: "application/vnd.github+json" }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (pr) {
        if (!pr || !pr.body) return;
        var turns = pr.body.match(/turns:\s*(\d+)/i);
        var cost = pr.body.match(/turns:\s*\d+[^\n]*?\$([\d.]+)/i);
        var model = pr.body.match(/Model:\s*`([^`\n]+)`/i);
        var next = { turns: turns && turns[1], cost: cost && ("$" + cost[1]), model: model && model[1].trim() };
        for (var i = 0; i < slots.length; i++) {
          var want = next[slots[i].getAttribute("data-run")];
          if (want && slots[i].textContent.trim() !== want) slots[i].textContent = want;
        }
      })
      .catch(function () { /* the typed figures stand */ });
  })();

  /* The same verdicts, said the way the rest of the page talks. */
  var PLAIN = {
    "inside node_modules":     "an installed library",
    "test file":               "one of your tests",
    "inside a test directory": "inside a test folder",
    "CI configuration":         "your build settings",
    "test harness configuration": "the file that decides which tests run",
    "lockfile":                 "the file that pins your versions"
  };

  var gForm = $("#guardForm"), gInput = $("#guardInput"), gList = $("#guardList");
  var gEmpty = $("#guardEmpty"), gCount = $("#guardCount");
  var gVerdict = $("#guardVerdict"), gText = $("#guardVerdictText");
  var staged = [], lastVerdict = "idle";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderGuard() {
    if (!gList) return;

    gList.innerHTML = staged.map(function (path) {
      var why = protectedReason(path);
      return '<li><div class="guard__row ' + (why ? "is-bad" : "is-ok") + '">' +
               '<span class="g-sign">' + (why ? "&#10005;" : "&#10003;") + "</span>" +
               '<span class="g-path" title="' + esc(path) + '">' + esc(path) + "</span>" +
               '<span class="g-why">' + (why ? esc(PLAIN[why] || why) : "allowed") + "</span>" +
               '<button class="g-x" type="button" data-rm="' + esc(path) + '" aria-label="Remove ' + esc(path) + '">&times;</button>' +
             "</div></li>";
    }).join("");

    if (gEmpty) gEmpty.hidden = staged.length > 0;
    if (gCount) gCount.textContent = staged.length + (staged.length === 1 ? " file" : " files");

    var blocked = staged.filter(function (path) { return !!protectedReason(path); });
    var verdict, text;

    if (!staged.length) { verdict = "idle"; text = "waiting"; }
    else if (blocked.length) {
      verdict = "fail";
      text = "the whole attempt is thrown away — " + blocked.length +
             (blocked.length === 1 ? " file was off-limits" : " files were off-limits");
    } else { verdict = "pass"; text = "allowed through — your tests run again from scratch"; }

    gVerdict.setAttribute("data-verdict", verdict);
    gText.textContent = text;

    if (verdict === "fail" && verdict !== lastVerdict) {
      gVerdict.classList.remove("is-shaken");
      void gVerdict.offsetWidth;
      gVerdict.classList.add("is-shaken");
    }
    lastVerdict = verdict;
  }

  function stage(path) {
    path = String(path || "").trim().replace(/^\.\//, "");
    if (!path || staged.indexOf(path) !== -1) return;
    staged.push(path);
    renderGuard();
  }

  if (gForm) {
    gForm.addEventListener("submit", function (e) {
      e.preventDefault();
      stage(gInput.value);
      gInput.value = "";
      gInput.focus();
    });
  }
  $$(".guard__chips button").forEach(function (b) {
    b.addEventListener("click", function () { stage(b.getAttribute("data-path")); });
  });
  if (gList) {
    gList.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-rm]");
      if (!btn) return;
      // keyed by path, not by index: the list re-renders on every change
      var at = staged.indexOf(btn.getAttribute("data-rm"));
      if (at === -1) return;
      staged.splice(at, 1);
      renderGuard();
    });
  }
  renderGuard();

  /* ══════════════════════════  ticker + marquee  ══════════════════════════ */

  var BREAKING = [
    ["openai", "3.x → 4.0"], ["@google/generative-ai", "→ @google/genai"],
    ["eslint", "8 → 9"], ["react-router", "5 → 6"], ["next", "12 → 13"],
    ["tailwindcss", "3 → 4"], ["express", "4 → 5"], ["zod", "3 → 4"],
    ["mongoose", "7 → 8"], ["prisma", "5 → 6"], ["jest", "27 → 28"], ["vite", "4 → 5"]
  ];

  var ticker = $("#ticker");
  if (ticker) {
    var cell = BREAKING.map(function (x) {
      return "<span>" + esc(x[0]) + " <u>" + esc(x[1]) + "</u> <b>breaking</b></span>";
    }).join("");
    ticker.innerHTML = cell + cell;   // duplicated so the -50% loop is seamless
  }

  var marquee = $("#marquee");
  if (marquee) {
    var unit = "<span>When a dependency breaks your code, Patchery fixes it and <em>proves</em> the fix.</span>";
    marquee.innerHTML = unit + unit + unit + unit;
  }

  /* ══════════════════════════  copy the workflow  ══════════════════════════ */

  var YML = [
    "# .github/workflows/patchery.yml",
    "name: Patchery",
    "",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      package:",
    '        description: "Name of the package that broke (e.g. openai)"',
    "        required: true",
    "      target-dir:",
    '        description: "Directory to fix, relative to the repository root"',
    "        required: true",
    '        default: "."',
    "      test-command:",
    '        description: "Verification command"',
    "        required: true",
    '        default: "npm test"',
    "      changelog:",
    '        description: "Changelog path or URL (empty = let the agent find it)"',
    "        required: false",
    '        default: ""',
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "",
    "jobs:",
    "  fix:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    "      - name: Install dependencies",
    "        run: npm ci",
    "        working-directory: ${{ inputs.target-dir }}",
    "",
    "      - name: Fix the broken dependency",
    "        id: sma",
    "        uses: patchery-dev/Patchery@v0",
    "        with:",
    "          package: ${{ inputs.package }}",
    "          target-dir: ${{ inputs.target-dir }}",
    "          test-command: ${{ inputs.test-command }}",
    "          changelog: ${{ inputs.changelog }}",
    "          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}",
    "          anthropic-base-url: ${{ secrets.ANTHROPIC_BASE_URL }}",
    "          anthropic-model: ${{ secrets.ANTHROPIC_MODEL }}",
    "",
    "      - name: Open a pull request",
    "        if: steps.sma.outputs.changed == 'true'",
    "        uses: peter-evans/create-pull-request@v7",
    "        with:",
    "          branch: patchery/${{ inputs.package }}",
    '          title: "fix(deps): migrate ${{ inputs.package }} call sites"',
    "          body-path: ${{ steps.sma.outputs.pr-body-file }}",
    "          add-paths: ${{ steps.sma.outputs.files }}",
    '          commit-message: "fix(deps): migrate ${{ inputs.package }} call sites"',
    "          labels: dependencies, automated",
    "          delete-branch: true",
    ""
  ].join("\n");

  var copyBtn = $("#copyBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var done = function (ok) {
        copyBtn.textContent = ok ? "copied" : "select it";
        copyBtn.classList.toggle("is-done", ok);
        setTimeout(function () {
          copyBtn.textContent = "copy";
          copyBtn.classList.remove("is-done");
        }, 1800);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(YML).then(function () { done(true); }, function () { done(false); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = YML;
        ta.style.cssText = "position:fixed;top:-9999px";
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        done(ok);
      }
    });
  }

  /* ══════════════════════════  go  ══════════════════════════ */

  handleLayout();
  onScroll();
})();
