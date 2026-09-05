/* ============================================================================
   Patchery — docs/assets/audit.js

   The page checks its own claims, in your browser, while you watch.

   Patchery's whole argument is that you should not take an agent's word for
   what it did — you should look at the artefact. It would be incoherent to
   argue that on a page which simply asserts things at you. So every load-
   bearing claim on this page is written here as a falsifiable check, and the
   checks are run for real: the logo is decoded and its pixels sampled, the
   guard source is fetched from GitHub and compared against the copy running on
   this page, the network log is read back, and the pull requests are looked up
   through the GitHub API.

   Two rules, which matter more than the feature:

     1. A check that cannot run says so. It never quietly passes. "Could not
        check" is a distinct, visible outcome from "passed".
     2. A check that fails says FAILED, in red, on the live site. If one of
        these ever turns red in front of a visitor, the page is wrong and it
        will be the first to admit it.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("audit");
  if (!root) return;

  var listEl = document.getElementById("auditList");
  var sumEl  = document.getElementById("auditSummary");
  var runBtn = document.getElementById("auditRun");

  var REPO = "patchery-dev/Patchery";
  var RAW  = "https://raw.githubusercontent.com/" + REPO + "/main/";
  var API  = "https://api.github.com/repos/" + REPO + "/";

  /* ── the checks ─────────────────────────────────────────────────────── */

  var CHECKS = [
    {
      id: "brand.teal",
      claim: "The teal on this page is the exact colour in the logo file.",
      run: function () {
        return sampleLogoTeal().then(function (fromLogo) {
          var css = getComputedStyle(document.documentElement)
            .getPropertyValue("--teal").trim().toLowerCase();
          var same = fromLogo === css;
          return {
            ok: same,
            detail: "logo.png → " + fromLogo + "   ·   --teal → " + css +
                    (same ? "   identical" : "   THESE DIFFER")
          };
        });
      }
    },

    {
      id: "guard.verbatim",
      claim: "The off-limits check running on this page is the one in the repository.",
      run: function () {
        var mine = window.PatcheryGuard && window.PatcheryGuard.toString();
        if (!mine) return Promise.reject(new Error("the page's own copy was not exposed"));
        return fetch(RAW + "scripts/guard.mjs", { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) throw new Error("GitHub returned " + r.status);
            return r.text();
          })
          .then(function (src) {
            var theirs = extractFn(src, "protectedReason");
            if (!theirs) throw new Error("protectedReason() not found in guard.mjs");
            var a = normalise(theirs), b = normalise(mine);
            return {
              ok: a === b,
              detail: a === b
                ? "byte-for-byte identical to main@scripts/guard.mjs, ignoring whitespace"
                : "THE PAGE AND THE REPOSITORY DISAGREE — trust the repository"
            };
          });
      }
    },

    {
      id: "page.no-tracking",
      claim: "This page loads nothing that tracks you.",
      run: function () {
        var hosts = {};
        (performance.getEntriesByType("resource") || []).forEach(function (r) {
          try { hosts[new URL(r.name).host] = true; } catch (e) { /* data: URIs */ }
        });
        hosts[location.host] = true;
        var list = Object.keys(hosts).sort();
        // Not a blocklist standing in for a promise — it is only here to catch
        // the obvious case where something was added without anyone noticing.
        var suspect = list.filter(function (h) {
          return /analytics|segment|mixpanel|hotjar|clarity|plausible|posthog|doubleclick|facebook|gtag|googletagmanager/i.test(h);
        });
        return Promise.resolve({
          ok: suspect.length === 0,
          detail: list.length + " hosts contacted: " + list.join("  ·  ") +
                  (suspect.length ? "   TRACKER FOUND: " + suspect.join(", ") : "")
        });
      }
    },

    {
      id: "proof.pull-request-2",
      claim: "The numbers quoted for pull request #2 are the numbers GitHub has.",
      run: function () {
        return gh("pulls/2").then(function (p) {
          var want = { changed_files: 1, additions: 1, deletions: 1 };
          var bad = Object.keys(want).filter(function (k) { return p[k] !== want[k]; });
          return {
            ok: bad.length === 0 && p.state === "open",
            detail: "state " + p.state + "  ·  " + p.changed_files + " file  ·  +" +
                    p.additions + " −" + p.deletions +
                    (bad.length ? "   PAGE SAYS OTHERWISE: " + bad.join(", ") : "   matches this page")
          };
        });
      }
    },

    {
      id: "claims.nothing-merged",
      claim: "None of the three pull requests shown on this page has been merged.",
      run: function () {
        return Promise.all([
          gh("pulls/2"),
          ghAt("ianarawjo/ChainForge", "pulls/416"),
          ghAt("ToolJet/ToolJet", "pulls/17829")
        ]).then(function (prs) {
          var merged = prs.filter(function (p) { return p.merged_at; });
          return {
            ok: merged.length === 0,
            detail: merged.length === 0
              ? "0 of 3 merged — the sentence on this page is still true"
              : merged.length + " HAVE BEEN MERGED — this page is out of date, and better than it says"
          };
        });
      }
    }
  ];

  /* ── helpers ────────────────────────────────────────────────────────── */

  function gh(path) { return ghAt(REPO, path); }

  function ghAt(repo, path) {
    return fetch("https://api.github.com/repos/" + repo + "/" + path, {
      headers: { Accept: "application/vnd.github+json" }, cache: "no-store"
    }).then(function (r) {
      if (r.status === 403) throw new Error("GitHub rate-limited this browser");
      if (!r.ok) throw new Error("GitHub returned " + r.status);
      return r.json();
    });
  }

  /* Pull one function out of a source file by brace matching, so the check does
     not quietly succeed on a partial or reordered match. */
  function extractFn(src, name) {
    var start = src.indexOf("function " + name);
    if (start === -1) return null;
    var open = src.indexOf("{", start);
    if (open === -1) return null;
    var depth = 0;
    for (var i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
  }

  /* Whitespace and the const/var keyword are the only differences allowed: this
     page ships as ES5, the repository as a module. Rules, regexes and returned
     strings must match exactly. */
  function normalise(fn) {
    return fn
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/\bconst\b|\blet\b|\bvar\b/g, "var")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* Decode the logo in a canvas and take the colour it is actually made of. */
  function sampleLogoTeal() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          var x = c.getContext("2d");
          x.drawImage(img, 0, 0);
          var d = x.getImageData(0, 0, c.width, c.height).data;
          var tally = {};
          for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 200) continue;           // ignore the transparent field
            var hex = "#" + [d[i], d[i+1], d[i+2]]
              .map(function (n) { return n.toString(16).padStart(2, "0"); }).join("");
            tally[hex] = (tally[hex] || 0) + 1;
          }
          var best = null, most = 0;
          for (var h in tally) if (tally[h] > most) { most = tally[h]; best = h; }
          best ? resolve(best) : reject(new Error("the logo had no opaque pixels"));
        } catch (e) { reject(new Error("the browser would not let the logo be read")); }
      };
      img.onerror = function () { reject(new Error("logo.png did not load")); };
      img.src = "assets/logo.png";
    });
  }

  /* ── running them ───────────────────────────────────────────────────── */

  var started = false;

  function row(c, state, detail) {
    return '<li class="ck ck--' + state + '" data-id="' + c.id + '">' +
      '<span class="ck__mark">' +
        (state === "pass" ? "&#10003;" : state === "fail" ? "&#10005;" :
         state === "skip" ? "?" : "<i></i>") + "</span>" +
      '<span class="ck__id">' + c.id + "</span>" +
      '<span class="ck__claim">' + c.claim + "</span>" +
      '<span class="ck__detail">' + (detail || "") + "</span>" +
    "</li>";
  }

  function render(states) {
    listEl.innerHTML = CHECKS.map(function (c, i) {
      var s = states[i];
      return row(c, s.state, s.detail);
    }).join("");
  }

  function runAll() {
    if (started) return;
    started = true;
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = "running"; }

    var states = CHECKS.map(function () { return { state: "run", detail: "" }; });
    render(states);
    var t0 = performance.now();

    var jobs = CHECKS.map(function (c, i) {
      // staggered, so the run reads as a sequence rather than a flicker
      return new Promise(function (res) { setTimeout(res, 260 + i * 300); })
        .then(function () { return c.run(); })
        .then(function (r) {
          states[i] = { state: r.ok ? "pass" : "fail", detail: r.detail };
        })
        .catch(function (e) {
          // Could not check is its own outcome. It is never counted as a pass.
          states[i] = { state: "skip", detail: "could not check — " + e.message };
        })
        .then(function () { render(states); });
    });

    Promise.all(jobs).then(function () {
      var pass = states.filter(function (s) { return s.state === "pass"; }).length;
      var fail = states.filter(function (s) { return s.state === "fail"; }).length;
      var skip = states.filter(function (s) { return s.state === "skip"; }).length;
      var secs = ((performance.now() - t0) / 1000).toFixed(1);

      sumEl.className = "audit__sum" + (fail ? " is-fail" : "");
      sumEl.innerHTML =
        "<b>" + pass + " passed</b>" +
        (fail ? '<b class="bad">' + fail + " failed</b>" : "") +
        (skip ? "<span>" + skip + " could not run</span>" : "") +
        "<span>in " + secs + "s, in your browser</span>";

      if (runBtn) { runBtn.textContent = "run again"; runBtn.disabled = false; }
      started = false;
    });
  }

  if (runBtn) runBtn.addEventListener("click", runAll);

  // Runs itself the first time it comes into view; a claim you have to press a
  // button to verify is not really being made in public.
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting) { io.disconnect(); runAll(); }
    }, { threshold: 0.25 });
    io.observe(root);
  } else {
    runAll();
  }
})();
