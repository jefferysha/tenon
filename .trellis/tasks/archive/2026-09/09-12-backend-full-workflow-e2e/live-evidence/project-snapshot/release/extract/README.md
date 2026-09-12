# Tasks Service

Node.js HTTP task API with persistent JSON storage.

## Launch

```sh
DATA_FILE=./tasks.json PORT=3000 npm start
```

The server prints `LISTENING <actual_port>` when ready. Run `npm test` for the project test suite.

## Release notes

- Task CRUD and health endpoints implemented per `docs/contract.md`.
- JSON validation, bounded request bodies, safe IDs, serialized atomic persistence, and restart recovery included.
- Release archive contains only runtime service, documentation, tests, and package metadata.
