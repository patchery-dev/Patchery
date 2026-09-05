#!/usr/bin/env node
/**
 * self-maintaining-action — agent orkestratörü
 *
 * Ne yapar (sırayla):
 *   1. Hedef projede testi çalıştırır  -> gerçekten kırık mı? (kırık değilse hiçbir şey yapmaz)
 *   2. AI ajanını (Claude Agent SDK) headless çalıştırır -> kırık API çağrılarını düzeltsin
 *   3. git ile NE değiştiğini bağımsız olarak okur -> yasaklı dosyalara dokunulmuşsa her şeyi geri alır
 *   4. Testi kendisi tekrar çalıştırır -> ajanın "geçti" demesine güvenmez
 *   5. Sonucu GITHUB_OUTPUT / GITHUB_STEP_SUMMARY ve pr-body.md olarak yazar
 *
 * Ayar tamamen ortam değişkeni ile yapılır (action.yml bunları doldurur).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- ayarlar

const env = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const bool = (name, fallback) => {
  const v = env(name).toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
};

const WORKSPACE = path.resolve(env("SMA_WORKSPACE", process.cwd()));
const TARGET_DIR = path.resolve(WORKSPACE, env("SMA_TARGET_DIR", "."));
const PACKAGE = env("SMA_PACKAGE");
const CHANGELOG = env("SMA_CHANGELOG");
const TEST_COMMAND = env("SMA_TEST_COMMAND", "npm test");
const MAX_TURNS = Number(env("SMA_MAX_TURNS", "25"));
const EXTRA = env("SMA_EXTRA_INSTRUCTIONS");
const REQUIRE_RED = bool("SMA_REQUIRE_FAILING_BASELINE", true);
const DRY_RUN = bool("SMA_DRY_RUN", false);

// ------------------------------------------------------- küçük yardımcılar

const log = (...a) => console.log(...a);
const group = (title) => log("\n" + "=".repeat(8) + " " + title + " " + "=".repeat(8));

function writeOutputs(obj) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(obj).map(([k, v]) => {
    const d = "__sma_" + k + "_" + Date.now() + "__";
    return k + "<<" + d + "\n" + String(v) + "\n" + d;
  });
  fs.appendFileSync(file, lines.join("\n") + "\n");
}

function writeStepSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, md + "\n");
}

function fail(message) {
  console.error("\n[HATA] " + message);
  writeOutputs({ changed: "false", tests_passed: "false", summary: message });
  writeStepSummary("### self-maintaining-action\n\n❌ " + message);
  process.exit(1);
}

function git(args, cwd = WORKSPACE) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runTests() {
  const r = spawnSync(TEST_COMMAND, {
    cwd: TARGET_DIR,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    timeout: 15 * 60 * 1000,
  });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  return { ok: r.status === 0, code: r.status, output: output.trim() };
}

/** Ajanın asla değiştirmemesi gereken yollar (güvenlik kuralı: testler dokunulmaz). */
function protectedReason(relPath) {
  const p = relPath.replace(/\\/g, "/");
  if (/(^|\/)node_modules\//.test(p)) return "node_modules içinde";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return "test dosyası";
  if (/(^|\/)(__tests__|__mocks__|tests?)\//.test(p)) return "test klasöründe";
  if (/(^|\/)\.github\//.test(p)) return "CI yapılandırması";
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(p)) return "lock dosyası";
  return null;
}

/** `git status --porcelain` -> değişen yolların kümesi (yeni + silinen dahil). */
function workingTreeFiles() {
  const out = git(["status", "--porcelain", "-uall", "--no-renames"]);
  if (!out) return new Set();
  return new Set(
    out
      .split("\n")
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
  );
}

// ------------------------------------------------------------------ akış

if (!PACKAGE) {
  fail("SMA_PACKAGE boş. Hangi paketin bozduğunu belirtmeden ajan çalıştırılmaz.");
}
if (!fs.existsSync(TARGET_DIR)) {
  fail("Hedef klasör yok: " + TARGET_DIR);
}

group("0. Ortam");
const usingCustomEndpoint = !!env("ANTHROPIC_BASE_URL");
log("workspace    : " + WORKSPACE);
log("hedef klasör : " + TARGET_DIR);
log("paket        : " + PACKAGE);
log("test komutu  : " + TEST_COMMAND);
log("model        : " + env("ANTHROPIC_MODEL", "(varsayılan)"));
log("endpoint     : " + (usingCustomEndpoint ? env("ANTHROPIC_BASE_URL") : "(Anthropic varsayılanı)"));

if (!env("ANTHROPIC_AUTH_TOKEN") && !env("ANTHROPIC_API_KEY")) {
  fail("Ne ANTHROPIC_AUTH_TOKEN ne ANTHROPIC_API_KEY ayarlı. GitHub Secrets'a eklemeyi unutmuş olabilirsiniz.");
}

let repoRoot;
try {
  repoRoot = git(["rev-parse", "--show-toplevel"]);
} catch {
  fail("Bu klasör bir git deposu değil. Değişiklikleri güvenle doğrulayamam, duruyorum.");
}
log("git kökü     : " + repoRoot);

const filesBefore = workingTreeFiles();
if (filesBefore.size > 0) {
  log("not: çalışma ağacı zaten kirli (" + filesBefore.size + " dosya) — bunlar ajanın işi sayılmayacak.");
}

group("1. Önce testi çalıştır (gerçekten kırık mı?)");
const baseline = runTests();
log(baseline.output.slice(-4000) || "(çıktı yok)");
log("\n-> baseline: " + (baseline.ok ? "GEÇTİ" : "KALDI (exit " + baseline.code + ")"));

if (baseline.ok && REQUIRE_RED) {
  const msg = "`" + TEST_COMMAND + "` zaten geçiyor — düzeltilecek bir şey yok. Ajan çalıştırılmadı.";
  log("\n" + msg);
  writeStepSummary("### self-maintaining-action\n\n✅ " + msg);
  writeOutputs({ changed: "false", tests_passed: "true", files: "", summary: msg });
  process.exit(0);
}

if (DRY_RUN) {
  const msg = "SMA_DRY_RUN=true — ajan çalıştırılmadı, sadece baseline ölçüldü.";
  log("\n" + msg);
  writeOutputs({ changed: "false", tests_passed: String(baseline.ok), files: "", summary: msg });
  process.exit(0);
}

group("2. Ajanı çalıştır");

const changelogLine = CHANGELOG
  ? "Read the changelog / migration notes first: " + CHANGELOG
  : "Find the package's changelog or migration notes first — usually node_modules/" +
    PACKAGE +
    "/CHANGELOG.md or its README.";

const prompt = [
  "You are an automated dependency-upgrade agent running inside CI.",
  "",
  'The package "' + PACKAGE + '" introduced a breaking change in this project, and the',
  "project's own source no longer works against it.",
  "",
  changelogLine,
  "",
  "Your job:",
  "1. Read the changelog and understand exactly what changed in the API.",
  "2. Find every place in this project's OWN source files that uses the affected API.",
  "3. Update those call sites to match the new API. Keep the change as small as possible.",
  '4. Run "' + TEST_COMMAND + '" to confirm the fix works.',
  "5. Report which file(s) you changed and why, and the final test output.",
  "",
  "Hard rules — breaking any of these makes your whole run be discarded:",
  "- NEVER edit test files (*.test.*, *.spec.*, anything under test/, tests/, __tests__/).",
  "  The tests define correct behaviour. If a test fails, the source is wrong, not the test.",
  "- NEVER edit anything inside node_modules/.",
  "- NEVER edit .github/ or lockfiles.",
  "- Do not 'fix' the failure by deleting code, skipping assertions, or catching and",
  "  swallowing the error. Migrate the call sites properly.",
  EXTRA ? "\nAdditional instructions from the repository owner:\n" + EXTRA + "\n" : "",
  "Work only inside: " + TARGET_DIR,
].join("\n");

const agentText = [];
let result = null;

try {
  for await (const message of query({
    prompt,
    options: {
      cwd: TARGET_DIR,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      maxTurns: MAX_TURNS,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          agentText.push(block.text);
          log("\n[ajan] " + block.text);
        } else if (block.type === "tool_use") {
          log("[araç] " + block.name + " " + JSON.stringify(block.input).slice(0, 180));
        }
      }
    } else if (message.type === "result") {
      result = message;
    }
  }
} catch (err) {
  fail("Ajan çalışırken hata: " + (err?.message ?? err));
}

if (!result) {
  fail("Ajan sonuç mesajı döndürmedi (bağlantı/kimlik doğrulama sorunu olabilir).");
}

const modelsUsed = Object.keys(result.modelUsage ?? {});
log(
  "\n-> ajan bitti: " + result.subtype + " | tur: " + result.num_turns + " | maliyet: $" + (result.total_cost_usd ?? 0)
);
log("-> kullanılan model(ler): " + (modelsUsed.join(", ") || "(bilinmiyor)"));

// Uyarı: özel endpoint istenmiş ama gerçekte bir Anthropic modeli raporlanmışsa,
// sessizce yanlış altyapıya düşmüş olabiliriz (bu proje daha önce tam bunu yaşadı).
if (usingCustomEndpoint && modelsUsed.some((m) => /^claude-/.test(m))) {
  log(
    '\n[UYARI] ANTHROPIC_BASE_URL özel bir adrese ayarlı ama kullanılan model "' +
      modelsUsed.join(", ") +
      '" gibi görünüyor. Sessizce Anthropic altyapısına düşmüş olabilir — model adını ve secret\'ları kontrol edin.'
  );
}

if (result.subtype !== "success") {
  fail(
    "Ajan başarıyla bitiremedi: " + result.subtype + (result.errors ? " — " + result.errors.join("; ") : "")
  );
}

group("3. Ne değişti? (git ile bağımsız kontrol)");
const filesAfter = workingTreeFiles();
const changed = [...filesAfter].filter((f) => !filesBefore.has(f)).sort();

if (changed.length === 0) {
  const msg = "Ajan hiçbir dosyayı değiştirmedi. PR açılacak bir şey yok.";
  log(msg);
  writeStepSummary("### self-maintaining-action\n\n⚠️ " + msg);
  writeOutputs({ changed: "false", tests_passed: "false", files: "", summary: msg });
  process.exit(0);
}

log(changed.map((f) => "  " + f).join("\n"));

function revertAll() {
  for (const f of changed) {
    try {
      git(["checkout", "--", f]);
    } catch {
      try {
        fs.rmSync(path.join(repoRoot, f), { force: true });
      } catch {}
    }
  }
}

const violations = changed.map((f) => [f, protectedReason(f)]).filter(([, r]) => r);
if (violations.length > 0) {
  log("\n[GÜVENLİK] Ajan dokunmaması gereken dosyalara dokundu:");
  for (const [f, reason] of violations) log("  - " + f + " (" + reason + ")");
  log("\nTüm değişiklikler geri alınıyor...");
  revertAll();
  fail("Ajan korumalı dosyaları değiştirdi (testler/node_modules/CI). Değişiklikler geri alındı, PR açılmayacak.");
}

group("4. Testi kendim tekrar çalıştır (ajanın sözüne güvenme)");
const after = runTests();
log(after.output.slice(-4000) || "(çıktı yok)");
log("\n-> düzeltme sonrası: " + (after.ok ? "GEÇTİ" : "KALDI (exit " + after.code + ")"));

if (!after.ok) {
  log("\nTestler hâlâ geçmiyor. Değişiklikler geri alınıyor...");
  revertAll();
  fail("Düzeltme sonrası testler geçmedi. Geri alındı, PR açılmayacak.");
}

group("5. Özet");

let diffstat = "";
try {
  diffstat = git(["diff", "--stat", "--"].concat(changed));
} catch {}

const explanation = agentText.length ? agentText[agentText.length - 1].trim() : "(ajan özet yazmadı)";

const prBody = [
  "## Otomatik bağımlılık düzeltmesi: `" + PACKAGE + "`",
  "",
  "Bu PR'ı **self-maintaining-action** açtı. Bir AI ajanı `" + PACKAGE + "` paketinin kırıcı",
  "değişikliğini okudu, çağrı yerlerini yeni API'ye taşıdı ve testleri çalıştırdı.",
  "",
  "### Doğrulama",
  "",
  "| Adım | Sonuç |",
  "| --- | --- |",
  "| Düzeltme öncesi `" + TEST_COMMAND + "` | ❌ kaldı (exit " + baseline.code + ") |",
  "| Düzeltme sonrası `" + TEST_COMMAND + "` | ✅ geçti |",
  "| Test dosyaları değişti mi | Hayır — CI tarafından zorunlu tutuluyor |",
  "",
  "### Değişen dosyalar",
  "",
  changed.map((f) => "- `" + f + "`").join("\n"),
  "",
  diffstat ? "```\n" + diffstat + "\n```" : "",
  "",
  "### Ajanın açıklaması",
  "",
  explanation,
  "",
  "### Test çıktısı (düzeltme sonrası)",
  "",
  "<details><summary>göster</summary>",
  "",
  "```",
  after.output.slice(-3000),
  "```",
  "",
  "</details>",
  "",
  "---",
  "Model: `" +
    (modelsUsed.join(", ") || "bilinmiyor") +
    "` · tur: " +
    result.num_turns +
    " · maliyet: $" +
    (result.total_cost_usd ?? 0).toFixed(4),
  "",
  "> İnsan gözden geçirmesi gerekir. Bu PR otomatik açıldı ama otomatik birleştirilmez.",
].join("\n");

// Dikkat: pr-body.md'yi ASLA çalışma ağacına yazma — create-pull-request onu da
// commit'e katar. Runner'ın geçici klasörü varsa oraya, yoksa repo dışına yaz.
const prBodyDir = env("RUNNER_TEMP", path.join(repoRoot, ".."));
const prBodyPath = path.join(prBodyDir, "sma-pr-body.md");
fs.writeFileSync(prBodyPath, prBody, "utf8");

writeStepSummary(
  "### self-maintaining-action\n\n✅ `" +
    PACKAGE +
    "` düzeltildi, `" +
    TEST_COMMAND +
    "` geçiyor.\n\n" +
    changed.map((f) => "- `" + f + "`").join("\n")
);
writeOutputs({
  changed: "true",
  tests_passed: "true",
  files: changed.join("\n"),
  pr_body_file: prBodyPath,
  summary: PACKAGE + " düzeltildi (" + changed.length + " dosya), testler geçiyor.",
});

log("\nDeğişen dosyalar: " + changed.join(", "));
log("PR gövdesi yazıldı: " + prBodyPath);
log("\nBitti. ✅");
