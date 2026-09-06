/* Patchery — docs/assets/site.js
 *
 * Rebuilt 2026-09-07 alongside the page. Three jobs, and the page is complete
 * without any of them: the copy button, the year in the footer, and reading the
 * turns/cost/model back out of pull request #2 so the figures on the page cannot
 * quietly drift away from the run they describe. If the fetch fails, the typed
 * figures stand.
 *
 * No analytics, no third-party script, no cookie. The only network call this
 * file makes is the public GitHub API request below.
 */
(function () {
  "use strict";

  var yr = document.getElementById("yr");
  if (yr) yr.textContent = String(new Date().getFullYear());

  /* ── copy button ──────────────────────────────────────────────────────
     The workflow file, in full. What the page shows is the same file; this
     is the copy you get when you press the button. */
  var YML = [
    "name: Patchery",
    "",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      package:      { required: true }",
    "      target-dir:   { default: \".\" }",
    "      test-command: { default: \"npm test\" }",
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
    "      - run: npm ci",
    "        working-directory: ${{ inputs.target-dir }}",
    "",
    "      - id: patchery",
    "        uses: patchery-dev/Patchery@v0",
    "        with:",
    "          package:              ${{ inputs.package }}",
    "          target-dir:           ${{ inputs.target-dir }}",
    "          test-command:         ${{ inputs.test-command }}",
    "          anthropic-auth-token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}",
    "",
    "      - if: steps.patchery.outputs.changed == 'true'",
    "        uses: peter-evans/create-pull-request@v7",
    "        with:",
    "          branch:    patchery/${{ inputs.package }}",
    "          body-path: ${{ steps.patchery.outputs.pr-body-file }}",
    "          add-paths: ${{ steps.patchery.outputs.files }}",
    ""
  ].join("\n");

  var btn = document.getElementById("copyBtn");
  if (btn) {
    btn.addEventListener("click", function () {
      var done = function (ok) {
        btn.textContent = ok ? "copied" : "select and copy";
        setTimeout(function () { btn.textContent = "copy"; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(YML).then(function () { done(true); },
                                                function () { done(false); });
      } else {
        done(false);
      }
    });
  }

  /* ── the figures on the evidence card ─────────────────────────────────
     They are typed into the HTML so the page is right with JavaScript off.
     This re-reads them from the pull request itself, which is the only
     place they are actually true. */
  var slots = [].slice.call(document.querySelectorAll("[data-run]"));
  if (!slots.length || !window.fetch) return;

  fetch("https://api.github.com/repos/patchery-dev/Patchery/pulls/2", {
    headers: { "Accept": "application/vnd.github+json" }
  })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (pr) {
      if (!pr || !pr.body) return;
      var body = pr.body;
      var turns = body.match(/turns:\s*(\d+)/i);
      /* anchored to the turns line: the changelog quoted in the body has
         dollar figures of its own, and an unanchored match found one. */
      var cost = body.match(/turns:\s*\d+[^\n]*?\$([\d.]+)/i);
      var model = body.match(/Model:\s*`([^`\n]+)`/i);

      var next = {
        turns: turns && turns[1],
        cost: cost && ("$" + cost[1]),
        model: model && model[1].trim()
      };

      slots.forEach(function (el) {
        var v = next[el.getAttribute("data-run")];
        if (v) el.textContent = v;
      });
    })
    .catch(function () { /* the typed figures stand */ });
})();
