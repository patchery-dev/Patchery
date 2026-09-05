/* ============================================================================
   Patchery — docs/assets/site.js

   Motion is Framer Motion's animation engine in its standalone browser build
   (motion.dev), so the springs here are the same ones the React version uses —
   without React, and without a build step. Everything degrades to plain CSS if
   the CDN is unreachable or the visitor asks for reduced motion.
   ========================================================================== */
(function () {
  "use strict";

  var M = window.Motion || null;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fine = window.matchMedia("(pointer: fine)").matches;
  var animated = !!M && !reduced;

  if (reduced) document.documentElement.classList.add("no-motion");

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* One spring for entrances, one for anything that follows the pointer. The
     whole page moves with the same physics instead of a dozen ad-hoc easings. */
  var ENTER  = { type: "spring", stiffness: 150, damping: 22, mass: 0.7 };
  var LIFT   = { type: "spring", stiffness: 120, damping: 19, mass: 0.8 };

  /* ══════════════════════════  boot  ══════════════════════════ */

  var boot = $("#boot"), bootBar = $("#bootBar"), booted = false;

  function finishBoot() {
    if (booted) return;
    booted = true;
    if (bootBar) bootBar.style.width = "100%";
    setTimeout(function () {
      if (boot) boot.classList.add("is-done");
      document.body.classList.remove("is-loading");
      revealHero();
      watchReveals();
    }, reduced ? 0 : 260);
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
  setTimeout(finishBoot, reduced ? 0 : 2600);   // never hold the page hostage

  /* ══════════════════════════  smooth scroll  ══════════════════════════ */

  /* No smooth-scroll library, deliberately.

     A momentum-scroll library swallows the wheel event and then does the
     scrolling itself on the animation frame loop. When that loop stalls, the
     event has already been consumed and the replacement never happens: the
     page simply stops scrolling. Trading the browser's own scrolling — which
     cannot break, and which already honours the reader's operating-system
     settings — for a slightly softer feel is a bad bargain on any page, and an
     absurd one on a page whose entire argument is that things should be
     verifiable rather than merely pleasant.

     In-page links get smooth behaviour from CSS scroll-behavior instead, with
     scroll-margin-top on the targets to clear the fixed header. */

  /* ══════════════════════  nav, folio, paper mode  ══════════════════════ */

  var nav = $("#nav");
  var folio = $("#folio");
  var folioNow = $("#folioNow");
  var folioName = $("#folioName");
  var sections = $$("[data-folio]");
  var lastY = 0, lastFolio = "";

  function chromeUpdate() {
    var y = window.scrollY || window.pageYOffset;

    if (nav) {
      nav.classList.toggle("is-stuck", y > 40);
      nav.classList.toggle("is-hidden", y > 460 && y > lastY + 4);
    }
    lastY = y;

    // Which section owns the line just under the header?
    var probe = y + 90;
    var here = null;
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var top = s.offsetTop;
      if (probe >= top) here = s;
    }
    if (!here) here = sections[0];
    if (!here) return;

    var id = here.getAttribute("data-folio");
    if (id !== lastFolio) {
      lastFolio = id;
      if (folioNow) folioNow.textContent = id;
      if (folioName) folioName.textContent = here.getAttribute("data-folio-name") || "";

    }

    // The inverted section needs the fixed chrome to invert with it.
    var onPaper = here.hasAttribute("data-invert");
    if (nav) nav.classList.toggle("on-paper", onPaper);
    if (folio) folio.classList.toggle("on-paper", onPaper);
  }

  /* One scroll listener, coalesced to a frame, drives the header, the folio,
     the progress bar and the pinned run. Scroll position is the single source
     of truth: every one of these is a pure function of scrollY, so it cannot
     drift out of sync or get stuck part-way the way a timed animation can. */
  var fillEl = $("#scrollbarFill");
  var lastRun = -1;

  function onScroll() {
    rescueVisible();
    chromeUpdate();
    if (fillEl) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      fillEl.style.transform = "scaleX(" + (max > 0 ? window.scrollY / max : 0).toFixed(4) + ")";
    }
    pipeUpdate();
  }

  /* Throttled on the clock, not on requestAnimationFrame.

     rAF only fires when the browser is actually rendering. Coalescing scroll
     work into it means that on a machine that has stopped painting — which is
     precisely when things go wrong — the handler never runs at all, and the
     page is left in whatever state it was in. A timestamp throttle keeps the
     cost the same and has no such failure mode. Every function called here is
     a pure function of scroll position, so running it late is harmless and
     running it never is not an option. */
  window.addEventListener("scroll", function () {
    var now = performance.now();
    if (now - lastRun < 8) return;
    lastRun = now;
    onScroll();
  }, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  /* ══════════════════════════  reveals  ══════════════════════════ */

  /* Reveals are a CSS transition switched on by a class, never a JavaScript
     animation. This is not a style preference — it is the difference between a
     page that always ends up readable and one that does not.

     A JS-driven spring holds the element at opacity 0 and walks it to 1 frame
     by frame. If the frame loop stalls even once — a background tab, a slow
     device, a dropped frame — the element stays stuck at whatever opacity it
     had reached, forever. That is exactly what was happening: content frozen
     at 0.19 opacity, present in the DOM, invisible on screen, and never
     recovering. A CSS transition runs on the compositor and finishes whether
     or not the main thread is busy. */
  var pending = [];
  var rescueVisible = function () {};

  function watchReveals() {
    var items = $$("[data-reveal]").filter(function (el) { return !el.closest("#hero"); });

    var show = function (el) { el.classList.add("is-in"); };

    if (!("IntersectionObserver" in window)) {
      items.forEach(show);
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          show(e.target);
          io.unobserve(e.target);
        });
      }, { rootMargin: "0px 0px -8% 0px", threshold: 0.04 });
      items.forEach(function (el) { io.observe(el); });
    }

    /* The observer is an optimisation, not the guarantee.

       IntersectionObserver callbacks are delivered as part of the browser's
       rendering steps. If rendering stalls — a busy machine, a background tab,
       a compositor hiccup — the callbacks simply never arrive and every
       element stays hidden with no way back. So the real mechanism is the
       scroll handler below, which is plain arithmetic on getBoundingClientRect
       and cannot be starved. Elements drop out of the list once revealed, so
       this costs nothing after the first pass. */
    pending = items.slice();
    rescueVisible = function () {
      if (!pending.length) return;
      var still = [];
      for (var i = 0; i < pending.length; i++) {
        var el = pending[i], r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) show(el);
        else still.push(el);
      }
      pending = still;
    };
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) rescueVisible();
    });
    window.addEventListener("pageshow", rescueVisible);
    rescueVisible();

    // Headlines built from masked lines get their own staggered slide-up the
    // first time they come into view.
    $$(".thesis__h").forEach(function (h) {
      if (!("IntersectionObserver" in window)) { h.classList.add("is-revealed"); return; }
      var io = new IntersectionObserver(function (e) {
        if (!e[0].isIntersecting) return;
        h.classList.add("is-revealed");
        io.disconnect();
      }, { threshold: 0.25 });
      io.observe(h);
      setTimeout(function () { h.classList.add("is-revealed"); }, 3000);
    });
  }

  function revealHero() {
    var title = $(".hero__title");
    if (title) title.classList.add("is-revealed");
    $$("#hero [data-reveal]").forEach(function (el) { el.classList.add("is-in"); });
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
      // Whether a step is on screen is a class, not an animation. Same reason
      // as the reveals: a stalled frame loop must never be able to hide it.
      s.style.opacity = ""; s.style.transform = "";
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
    var p = Math.min(1, Math.max(0, -r.top / span));
    setStep(Math.min(STEPS - 1, Math.floor(p * STEPS)));
  }

  function handleLayout() {
    current = -1;
    if (stacked.matches) {
      screens.forEach(function (s, i) {
        s.classList.remove("is-on");
        s.style.opacity = ""; s.style.transform = "";
        onStepEnter(i);
      });
      railItems.forEach(function (r) { r.classList.remove("is-on", "is-past"); });
    } else {
      pipeUpdate();
    }
  }

  stacked.addEventListener ? stacked.addEventListener("change", handleLayout)
                           : stacked.addListener(handleLayout);

  /* ── per-step animations ─────────────────────────────────────────────── */

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
      else rewriteTimer = setTimeout(write, 260);
    }
    function write() {
      if (n >= TO.length) {
        if (animated) M.animate(el, { scale: [1, 1.07, 1] }, { duration: 0.5, ease: "easeOut" });
        return;
      }
      el.textContent = TO.slice(0, ++n);
      rewriteTimer = setTimeout(write, 58);
    }
    rewriteTimer = setTimeout(erase, 1400);
  }

  function onStepEnter(n) {
    var scr = screens[n];
    if (!scr) return;

    var typed = $("code[data-type]", scr);
    if (typed) typeLines(typed, 52);

    if (n === 1) {
      var rw = $("#rewrite", scr);
      if (rw) runRewrite(rw);
    }

  }

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
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)) return "lockfile";
    return null;
  }

  /* Same verdicts, said the way the rest of the page talks. */
  var PLAIN = {
    "inside node_modules":       "an installed library",
    "test file":                 "one of your tests",
    "inside a test directory":   "inside a test folder",
    "CI configuration":          "your build settings",
    "lockfile":                  "the file that pins your versions"
  };

  /* Handed to audit.js, which fetches guard.mjs from GitHub and checks that
     what is running here really is what is in the repository. */
  window.PatcheryGuard = protectedReason;

  var gForm  = $("#guardForm"), gInput = $("#guardInput"), gList = $("#guardList");
  var gEmpty = $("#guardEmpty"), gCount = $("#guardCount");
  var gVerdict = $("#guardVerdict"), gText = $("#guardVerdictText");
  var staged = [], lastVerdict = "idle";

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderGuard(justAdded) {
    if (!gList) return;

    gList.innerHTML = staged.map(function (path, i) {
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

    if (!staged.length) {
      verdict = "idle"; text = "waiting";
    } else if (blocked.length) {
      verdict = "fail";
      text = "the whole attempt is thrown away — " + blocked.length +
             (blocked.length === 1 ? " file was off-limits" : " files were off-limits");
    } else {
      verdict = "pass"; text = "allowed through — your tests run again from scratch";
    }

    gVerdict.setAttribute("data-verdict", verdict);
    gText.textContent = text;

    if (verdict === "fail" && verdict !== lastVerdict) {
      // a CSS keyframe, so a stalled frame loop cannot leave it shunted sideways
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
    renderGuard(true);
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
    b.addEventListener("click", function () {
      stage(b.getAttribute("data-path"));
      if (animated) M.animate(b, { scale: [1, 0.93, 1] }, { duration: 0.28 });
    });
  });
  if (gList) {
    gList.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-rm]");
      if (!btn) return;
      // Identify the row by its path, not its index: the list re-renders on
      // every change, so an index captured a moment ago can point at a
      // different file by the time the click lands.
      var at = staged.indexOf(btn.getAttribute("data-rm"));
      if (at === -1) return;
      staged.splice(at, 1);
      renderGuard(false);
    });
  }
  renderGuard(false);

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
    "# .github/workflows/self-maintain.yml",
    "name: self-maintain",
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
    "          branch: self-maintain/${{ inputs.package }}",
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
        if (animated && ok) M.animate(copyBtn, { scale: [1, 1.1, 1] }, { duration: 0.35 });
        setTimeout(function () {
          copyBtn.textContent = "copy";
          copyBtn.classList.remove("is-done");
        }, 1900);
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

  /* ══════════════════════════  cursor + magnets  ══════════════════════════ */

  /* Pointer following is done by hand, in one frame loop, writing transforms
     directly. Starting a fresh spring on every pointermove event meant
     allocating a hundred animation objects a second and asking the engine to
     interrupt and blend all of them — it was the single most expensive thing
     on the page after the compositing layers. */
  if (fine && animated && window.innerWidth >= 1000) {
    var cur = $("#cursor");
    var magnets = $$(".magnetic");
    var mx = innerWidth / 2, my = innerHeight / 2, cx = mx, cy = my;
    var held = null, hx = 0, hy = 0, tx = 0, ty = 0;

    window.addEventListener("pointermove", function (e) {
      mx = e.clientX; my = e.clientY;
      cur.classList.add("is-on");

      var t = e.target;
      var near = function (sel) { return !!(t.closest && t.closest(sel)); };
      cur.classList.toggle("is-link", near("a, button"));
      cur.classList.toggle("is-text", near("pre, input"));

      var over = t.closest && t.closest(".magnetic");
      if (over !== held) { if (held) { tx = ty = 0; } held = over; }
      if (held) {
        var r = held.getBoundingClientRect();
        tx = (mx - (r.left + r.width / 2)) * 0.2;
        ty = (my - (r.top + r.height / 2)) * 0.32;
      }
    }, { passive: true });

    document.addEventListener("pointerleave", function () { cur.classList.remove("is-on"); });

    (function follow() {
      requestAnimationFrame(follow);
      if (document.hidden) return;
      cx += (mx - cx) * 0.19;
      cy += (my - cy) * 0.19;
      cur.style.transform = "translate3d(" + cx.toFixed(1) + "px," + cy.toFixed(1) + "px,0)";

      if (!held) { tx = ty = 0; }
      hx += (tx - hx) * 0.16;
      hy += (ty - hy) * 0.16;
      for (var i = 0; i < magnets.length; i++) {
        var el = magnets[i];
        if (el === held) el.style.transform = "translate3d(" + hx.toFixed(2) + "px," + hy.toFixed(2) + "px,0)";
        else if (el.style.transform) el.style.transform = "";
      }
    })();

    $$(".proofcard").forEach(function (card) {
      card.addEventListener("pointerenter", function () { M.animate(card, { y: -5 }, LIFT); });
      card.addEventListener("pointerleave", function () { M.animate(card, { y: 0 }, LIFT); });
    });
  }

  /* ══════════════════════════  go  ══════════════════════════ */

  handleLayout();
  onScroll();
})();
