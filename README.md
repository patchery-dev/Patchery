# self-maintaining-action

**Bir bağımlılık kırıcı bir değişiklik yaptığında, kodunuzu bir AI ajanına düzelttiren, düzeltmeyi kendi testlerinizle doğrulayan ve size PR açan GitHub Action'ı.**

Dependabot paketin sürümünü yükseltir ve testleriniz kırılırsa sizi orada bırakır.
Bu action bir adım ötesini yapar: changelog'u okur, çağrı yerlerini yeni API'ye taşır,
testleri çalıştırır — ve **sadece testler geçerse** PR açar.

---

## Nasıl çalışır

```
1. Testi çalıştır      →  gerçekten kırık mı? Geçiyorsa hiçbir şey yapma.
2. Ajanı çalıştır      →  changelog'u oku, çağrı yerlerini düzelt.
3. git ile kontrol et  →  ne değişti? Testlere/node_modules'a dokunulduysa GERİ AL.
4. Testi tekrar çalıştır →  ajanın "geçti" demesine güvenme, kendin ölç.
5. PR aç               →  sadece 1-4 temiz geçtiyse.
```

Kritik olan 3. ve 4. adım. Bir AI ajanına "testi geçir" derseniz, testi silerek de
geçirebilir. Bu action ajanın raporuna hiç bakmaz: değişiklikleri `git status` ile
kendisi okur, korumalı bir dosyaya dokunulmuşsa her şeyi geri alır, ve testi
kendisi yeniden çalıştırır.

**Korumalı dosyalar** (ajan bunlara dokunursa çalışma tamamen iptal edilir):

- test dosyaları — `*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `__mocks__/`
- `node_modules/`
- `.github/`
- lock dosyaları — `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`

---

## Kurulum

### 1. Secret'ları ekleyin

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Zorunlu | Ne için |
| --- | --- | --- |
| `ANTHROPIC_AUTH_TOKEN` | ✅ | Ajanın API anahtarı / token'ı |
| `ANTHROPIC_BASE_URL` | ➖ | Uyumlu, farklı bir endpoint kullanıyorsanız |
| `ANTHROPIC_MODEL` | ➖ | Model adı (boşsa varsayılan) |

Anahtarı **asla** workflow dosyasına düz yazmayın; Actions log'ları herkese açık olabilir.

### 2. Workflow'u kopyalayın

[`examples/self-maintain.yml`](examples/self-maintain.yml) dosyasını kendi reponuzda
`.github/workflows/self-maintain.yml` olarak kaydedin.

### 3. Çalıştırın

Repo → **Actions → self-maintain → Run workflow**. Hangi paketin kırdığını ve hangi
klasörün düzeltileceğini orada yazarsınız.

> Bu sürümde otomatik zamanlama/tarama **yok** — bilerek. Hangi paketin ele alınacağına
> siz karar veriyorsunuz. Tam otomatik tarama sonraki sürümün işi.

---

## Girdiler

| Girdi | Varsayılan | Açıklama |
| --- | --- | --- |
| `package` | — (zorunlu) | Kıran paketin adı |
| `target-dir` | `.` | Düzeltilecek proje klasörü |
| `test-command` | `npm test` | Doğrulama komutu (öncesi + sonrası çalışır) |
| `changelog` | `""` | Changelog yolu/URL'i. Boşsa ajan kendi arar |
| `max-turns` | `25` | Ajanın tur limiti — maliyet freni |
| `extra-instructions` | `""` | Ajana ek talimat |
| `require-failing-baseline` | `true` | Test zaten geçiyorsa ajanı hiç çalıştırma |
| `dry-run` | `false` | Sadece baseline testi ölç |
| `node-version` | `20` | Kurulacak Node sürümü |
| `anthropic-auth-token` | — (zorunlu) | Secret'tan verin |
| `anthropic-base-url` | `""` | Secret'tan verin |
| `anthropic-model` | `""` | Secret'tan verin |

## Çıktılar

| Çıktı | Açıklama |
| --- | --- |
| `changed` | `true` / `false` — gerçekten dosya değişti mi |
| `tests-passed` | Düzeltme sonrası testler geçti mi |
| `files` | Değişen dosyalar, satır satır (`add-paths` için hazır) |
| `pr-body-file` | Doldurulmuş PR gövdesinin yolu (`body-path` için hazır) |
| `summary` | Tek satır özet |

---

## Kendi üstünde deneme (demo)

Bu repoda bilerek kırık bir örnek var: [`test-fixture/`](test-fixture/) — `fake-lib`
1.x'ten 2.0.0'a çıkmış, `formatPrice(amount)` artık `formatPrice(amount, currency)`.
`test-fixture/app.js` hâlâ eski çağrıyı yapıyor, bu yüzden `npm test` kalıyor.

**Actions → self-maintain (demo) → Run workflow** deyin. Beklenen sonuç: ajan
`app.js`'i düzeltir, testler geçer, `self-maintain/fake-lib` dalında bir PR açılır.

> Demo PR'ını **birleştirmeyin** — fixture'ın kırık kalması gerekiyor, yoksa sonraki
> çalıştırmalar "düzeltilecek bir şey yok" der.

Yerelde denemek için (Actions'a gerek yok):

```bash
npm install
SMA_PACKAGE=fake-lib \
SMA_TARGET_DIR=test-fixture \
SMA_CHANGELOG=node_modules/fake-lib/CHANGELOG.md \
ANTHROPIC_AUTH_TOKEN=... \
node scripts/agent.mjs
```

---

## Sınırlar (dürüstçe)

- Şu an sadece **Node/npm** projelerinde denendi. Test komutu değiştirilebildiği için
  başka ekosistemler de çalışabilir ama doğrulanmadı.
- Tek seferde **tek paket**. Zincirleme kırılmaları çözmez.
- Ajanın maliyeti çalışma başına değişir; `max-turns` bunun frenidir.
- Açılan PR **insan tarafından gözden geçirilmelidir**. Otomatik birleştirme yoktur ve
  önerilmez.
- Ajan gizli/özel kod görür. Kullandığınız modelin sağlayıcısının veri politikasını
  bilmeden özel repolarda kullanmayın.

## Lisans

MIT
