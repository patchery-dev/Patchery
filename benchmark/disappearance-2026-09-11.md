# Disappearance rate of the benchmark corpus

Measured 2026-09-11 on Node v24.20.0.

| case | package | class | verdict | engines | why |
|---|---|---|---|---|---|
| bcoe/yargs | which@7 | api | loads | ^22.22.2 || ^24.15.0 || >=26.0.0 |  |
| expressjs/body-parser | content-type@3 | packaging | loads | >=22 |  |
| expressjs/body-parser | raw-body@4 | packaging | loads | >=22 |  |
| expressjs/express | content-disposition@3 | packaging | loads | >=22 |  |
| expressjs/express | content-type@3 | packaging | loads | >=22 |  |
| expressjs/multer | append-field@2 | packaging | loads | ^12.20.0 || ^14.13.1 || >=16.0.0 |  |
| jquense/yup | type-fest@5 | packaging | still-broken | >=20 | node:internal/modules/cjs/loader:761 |
| mozilla/treeherder | @fortawesome/fontawesome-svg-core@7 | api | loads | >=6 |  |
| node-fetch/node-fetch | data-uri-to-buffer@8 | packaging | loads | >= 20 |  |
| node-fetch/node-fetch | fetch-blob@4 | packaging | still-broken | >=16.7 | node:internal/modules/esm/module_job:313 |
| nodemailer/nodemailer | proxy@4 | packaging | loads | >= 20 |  |
| winstonjs/winston | is-stream@4 | packaging | loads | >=18 |  |
| winstonjs/winston | readable-stream@4 | api | loads | ^12.22.0 || ^14.17.0 || >=16.0.0 |  |
| winstonjs/winston | through2@5 | packaging | loads |  |  |

## The number

**12 of 14** cases install and `require()` cleanly on Node v24.20.0.

Split, because the two halves mean different things:

- packaging: **9 of 11** load. For these, loading IS the break, so this is the disappearance rate.
- api: **3 of 3** load. For these it means nothing - the break is a changed API at a call site, and a package that loads can still break it.

Upper bound, not the answer: a package loading does not make the case's own suite go green. That needs the repository at its pinned commit, which this does not run.
