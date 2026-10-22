# Integration contract fixture

Run `node --test --test-reporter=tap tests/*.test.mjs` with Node 24. There are no dependencies.

Agent A raises `batchSize` from 2 to 4 in `src/batch.mjs`. Agent B raises `concurrency` from 2 to 4 in `src/concurrency.mjs`. Each change passes alone. Their ordinary Git merge succeeds, but their combination exceeds the shared capacity of 8.

This is a deliberately designed demonstration fixture. Real agent edits, Git commits and test execution are required to present a run as live evidence. Do not change the tests to make the combined candidate pass.
