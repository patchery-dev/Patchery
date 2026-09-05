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

  /* Shared motion vocabulary — one spring for entrances, one snappier one for
     anything that follows the pointer. Keeping them here means the whole page
     moves with the same physics instead of a dozen ad-hoc easings. */
  var ENTER  = { type: "spring", stiffness: 150, damping: 22, mass: 0.7 };
  var LIFT   = { type: "spring", stiffness: 110, damping: 18, mass: 0.8 };
  var FOLLOW = { type: "spring", stiffness: 480, damping: 42, mass: 0.6 };
  var MAGNET = { type: "spring", stiffness: 180, damping: 14, mass: 0.5 };

  /* ══════════════════════════  boot  ══════════════════════════ */

  var boot = $("#boot");
  var bootBar = $("#bootBar");
  var booted = false;

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

  var lenis = null;
  if (window.Lenis && !reduced) {
    lenis = new window.Lenis({ duration: 1.05, smoothWheel: true, touchMultiplier: 1.6 });
    (function loop(t) { lenis.raf(t); requestAnimationFrame(loop); })(0);

    $$('a[href^="#"]').forEach(function (a) {
      a.addEventListener("click", function (e) {
        var target = document.querySelector(a.getAttribute("href"));
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -70 });
      });
    });
  }

  /* ══════════════════════════  nav + progress  ══════════════════════════ */

  var nav = $("#nav");
  var lastY = 0;

  function navUpdate() {
    var y = window.scrollY || window.pageYOffset;
    if (nav) {
      nav.classList.toggle("is-stuck", y > 40);
      nav.classList.toggle("is-hidden", y > 460 && y > lastY + 4);
    }
    lastY = y;
  }

  if (animated) {
    // Scroll-linked, not scroll-triggered: the bar is bound to page progress.
    M.scroll(M.animate("#scrollbarFill", { scaleX: [0, 1] }, { ease: "linear" }));
    M.scroll(navUpdate);
  } else {
    var fillEl = $("#scrollbarFill");
    window.addEventListener("scroll", function () {
      navUpdate();
      if (!fillEl) return;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      fillEl.style.transform = "scaleX(" + (max > 0 ? window.scrollY / max : 0) + ")";
    }, { passive: true });
  }

  /* ══════════════════════════  reveals  ══════════════════════════ */

  function watchReveals() {
    var items = $$("[data-reveal]").filter(function (el) { return !el.closest("#hero"); });

    if (!animated) {
      items.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }

    items.forEach(function (el) {
      var stop = M.inView(el, function () {
        M.animate(el, { opacity: 1, y: 0 }, ENTER);
        if (stop) stop();          // reveal once, then stop watching
      }, { amount: 0.15, margin: "0px 0px -10% 0px" });
    });
  }

  function revealHero() {
    var lines = $$(".hero__title .line > span");
    var rest = $$("#hero [data-reveal]");

    if (!animated) {
      rest.forEach(function (el) { el.classList.add("is-in"); });
      return;
    }

    M.animate(lines, { y: ["115%", "0%"] }, Object.assign({ delay: M.stagger(0.07) }, LIFT));
    M.animate(rest, { opacity: [0, 1], y: [22, 0] },
      Object.assign({ delay: M.stagger(0.08, { startDelay: 0.25 }) }, ENTER));
  }

  /* ══════════════════════════  the pinned run  ══════════════════════════ */

  var track = $("#pipeTrack");
  var screens = $$(".scr");
  var railItems = $$(".rail__i");
  var STEPS = screens.length;
  var current = -1;
  var stacked = window.matchMedia("(max-width: 860px)");
  var stopScroll = null;

  function setStep(n) {
    if (n === current) return;
    var forward = n > current;
    current = n;

    screens.forEach(function (s, i) {
      var on = i === n;
      s.classList.toggle("is-on", on);
      if (animated && on) {
        M.animate(s, { opacity: [0, 1], y: [forward ? 18 : -18, 0] }, ENTER);
      }
    });
    railItems.forEach(function (r, i) {
      r.classList.toggle("is-on", i === n);
      r.classList.toggle("is-past", i < n);
    });
    onStepEnter(n);
  }

  function bindPipe() {
    if (stopScroll) { stopScroll(); stopScroll = null; }
    if (!track || stacked.matches) return;

    var onProgress = function (progress) {
      setStep(Math.min(STEPS - 1, Math.max(0, Math.floor(progress * STEPS))));
    };

    if (animated) {
      stopScroll = M.scroll(onProgress, { target: track, offset: ["start start", "end end"] });
    } else {
      var handler = function () {
        var r = track.getBoundingClientRect();
        var span = r.height - window.innerHeight;
        if (span > 0) onProgress(Math.min(1, Math.max(0, -r.top / span)));
      };
      window.addEventListener("scroll", handler, { passive: true });
      stopScroll = function () { window.removeEventListener("scroll", handler); };
      handler();
    }
  }

  function handleLayout() {
    current = -1;
    if (stacked.matches) {
      if (stopScroll) { stopScroll(); stopScroll = null; }
      screens.forEach(function (s) { s.classList.remove("is-on"); s.style.opacity = ""; s.style.transform = ""; });
      railItems.forEach(function (r) { r.classList.remove("is-on", "is-past"); });
      screens.forEach(function (s, i) { onStepEnter(i); });
    } else {
      bindPipe();
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

  var REWRITE_FROM = "formatPrice(amount)";
  var REWRITE_TO   = 'formatPrice(amount, "USD")';
  var rewriteTimer = null;

  function runRewrite(el) {
    clearTimeout(rewriteTimer);
    if (reduced) { el.textContent = REWRITE_TO; return; }

    var shared = 0;
    while (shared < REWRITE_FROM.length && REWRITE_FROM[shared] === REWRITE_TO[shared]) shared++;

    el.textContent = REWRITE_FROM;
    var n = REWRITE_FROM.length;

    function erase() {
      if (n > shared) {
        el.textContent = REWRITE_FROM.slice(0, --n);
        rewriteTimer = setTimeout(erase, 42);
      } else {
        rewriteTimer = setTimeout(write, 260);
      }
    }
    function write() {
      if (n < REWRITE_TO.length) {
        el.textContent = REWRITE_TO.slice(0, ++n);
        rewriteTimer = setTimeout(write, 58);
        if (n === REWRITE_TO.length && animated) {
          M.animate(el, { scale: [1, 1.06, 1] }, { duration: 0.5, ease: "easeOut" });
        }
      }
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
    if (n === 4 && animated) {
      M.animate($$(".diff i", scr), { opacity: [0, 1], x: [-8, 0] },
        { delay: M.stagger(0.06, { startDelay: 0.2 }), duration: 0.45 });
    }
  }

  /* ══════════════════════════  the guard  ══════════════════════════ */

  /* Copied verbatim from scripts/guard.mjs — if this and the repo ever
     disagree, the repo is right and this page is a lie. Keep them identical. */
  function protectedReason(relPath) {
    var p = String(relPath).replace(/\\/g, "/");
    if (/(^|\/)node_modules\//.test(p)) return "inside node_modules";
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return "test file";
    if (/(^|\/)(__tests__|__mocks__|tests?)\//.test(p)) return "inside a test directory";
    if (/(^|\/)\.github\//.test(p)) return "CI configuration";
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)) return "lockfile";
    return null;
  }

  var gForm    = $("#guardForm");
  var gInput   = $("#guardInput");
  var gList    = $("#guardList");
  var gEmpty   = $("#guardEmpty");
  var gCount   = $("#guardCount");
  var gVerdict = $("#guardVerdict");
  var gText    = $("#guardVerdictText");
  var staged   = [];
  var lastVerdict = "idle";

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
               '<span class="g-why">' + (why ? esc(why) : "allowed") + "</span>" +
               '<button class="g-x" type="button" data-rm="' + i + '" aria-label="Remove ' + esc(path) + '">&times;</button>' +
             "</div></li>";
    }).join("");

    if (gEmpty) gEmpty.hidden = staged.length > 0;
    if (gCount) gCount.textContent = staged.length + (staged.length === 1 ? " file" : " files");

    var blocked = staged.filter(function (path) { return !!protectedReason(path); });
    var verdict, text;

    if (!staged.length) {
      verdict = "idle"; text = "waiting for a diff";
    } else if (blocked.length) {
      verdict = "fail";
      text = "run discarded — git checkout -- . · " + blocked.length +
             (blocked.length === 1 ? " protected path touched" : " protected paths touched");
    } else {
      verdict = "pass"; text = "diff accepted — re-running your test command";
    }

    gVerdict.setAttribute("data-verdict", verdict);
    gText.textContent = text;

    if (animated) {
      var row = justAdded ? gList.lastElementChild : null;
      if (row) M.animate(row, { opacity: [0, 1], y: [-8, 0] }, LIFT);
      if (verdict !== lastVerdict && verdict !== "idle") {
        M.animate(gVerdict, { x: verdict === "fail" ? [0, -7, 6, -4, 0] : [0, 0] },
          { duration: 0.42, ease: "easeOut" });
      }
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
      if (animated) M.animate(b, { scale: [1, 0.94, 1] }, { duration: 0.28 });
    });
  });
  if (gList) {
    gList.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-rm]");
      if (!btn) return;
      staged.splice(parseInt(btn.getAttribute("data-rm"), 10), 1);
      renderGuard(false);
    });
  }
  renderGuard(false);

  /* ══════════════════════════  ticker + marquee  ══════════════════════════ */

  var BREAKING = [
    ["openai", "3.x → 4.0"],
    ["@google/generative-ai", "→ @google/genai"],
    ["eslint", "8 → 9"],
    ["react-router", "5 → 6"],
    ["next", "12 → 13"],
    ["tailwindcss", "3 → 4"],
    ["express", "4 → 5"],
    ["zod", "3 → 4"],
    ["mongoose", "7 → 8"],
    ["prisma", "5 → 6"],
    ["jest", "27 → 28"],
    ["vite", "4 → 5"]
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

  if (fine && animated) {
    var cur = $("#cursor");

    window.addEventListener("pointermove", function (e) {
      cur.classList.add("is-on");
      // Re-targeting a running spring inherits its velocity, which is why the
      // ring trails the pointer instead of snapping to it.
      M.animate(cur, { x: e.clientX, y: e.clientY }, FOLLOW);

      var t = e.target;
      cur.classList.toggle("is-link", !!(t.closest && t.closest("a, button")));
      cur.classList.toggle("is-text", !!(t.closest && t.closest("pre, input, .term")));
    }, { passive: true });

    document.addEventListener("pointerleave", function () { cur.classList.remove("is-on"); });

    $$(".magnetic").forEach(function (el) {
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        M.animate(el, {
          x: (e.clientX - (r.left + r.width / 2)) * 0.22,
          y: (e.clientY - (r.top + r.height / 2)) * 0.34
        }, MAGNET);
      });
      el.addEventListener("pointerleave", function () {
        M.animate(el, { x: 0, y: 0 }, MAGNET);
      });
    });

    $$(".proofcard").forEach(function (card) {
      card.addEventListener("pointerenter", function () { M.animate(card, { y: -4 }, LIFT); });
      card.addEventListener("pointerleave", function () { M.animate(card, { y: 0 }, LIFT); });
    });
  }

  /* ══════════════════════════  go  ══════════════════════════ */

  handleLayout();
  navUpdate();
  window.addEventListener("resize", function () { current = -1; bindPipe(); }, { passive: true });
})();
