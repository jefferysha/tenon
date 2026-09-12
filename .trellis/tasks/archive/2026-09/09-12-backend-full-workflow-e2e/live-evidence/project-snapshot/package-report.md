# Local release report

Created `release/tasks-service.tgz` from service source, docs, tests, `README.md`, and `package.json`. Archive inspection confirms `src/server.mjs` at archive root and excludes runtime ledgers, skills, logs, node_modules, and the tarball itself.

Source and packaged acceptance commands were attempted; this sandbox prevents TCP listeners (`listen EPERM`). Results are recorded in `package-run-summary.txt` and command logs.
