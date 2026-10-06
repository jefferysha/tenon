# T1 导出 API（@tenon/kernel，merged into integ/v02 at eeb17e7e）

Everything via `export * from './test-system/index.js'`; test-only helpers at `@tenon/kernel/test-system/test-support`.

- Closed sets (vocabulary.ts): TEST_KINDS, TEST_RUNNERS, REPORT_FORMATS, COVERAGE_FORMATS, PLAN_SCOPES, RUN_SCOPES + is* guards; defaultReportFormat, kindRunnerProblem, kindFormatProblem, isCaseReportFormat, looksLikeTestFile, INLINE_SUITE_PREFIX.
- Catalog: parseTestCatalog(text) → {ok:true,catalog}|{ok:false,issues}; formatCatalogIssues(issues,file?); serializeTestCatalog; catalogDigest; catalogSuitesDigest(catalog,ids); catalogSuite(catalog,id); suiteFileGlobs; suiteCoverGlobs.
- Plan: parseTestPlan(text,expectedChange?); serializeTestPlan; normalizeTestPlan; testPlanDigest; testPlanBytesDigest; emptyTestPlan(change); planCatalogProblems(plan,catalog); waiverKey.
- Plan I/O (CLI only): readTestPlanState(changeDir,change) → missing|tampered{reason}|ok{plan,digest,ledger}; writeTestPlan(changeDir,plan,{actor,recordedAt}) → {digest} (takes the change lock; do not call inside another withLock(changeDir)).
- Covers: parseCovers, formatCovers, parseCaseRef, caseMatchesRef, fileRefMatches, formatCaseRef.
- Known failures: parseKnownFailures, serializeKnownFailures, classifyAgainstKnownFailures(entries,suite,identity,status,today) → pass|new-fail|skip|known-fail|fixed|expired; knownFailureExpired.
- Machine profile: machineProfile(input) → {id,label,facts} (pure); readMachineProfileInput(runtimeVersion, env) (caller passes profiles_env values).
- Benchmark/baseline: summarizeSamples, median, percentile, medianAbsoluteDeviation, evaluateBenchmarkMetric(spec,summary,baselineMedian) (has `noisy` → T2 re-runs), readTestBaselineV2, writeTestBaselineV2, nextBaselineV2, baselineV2Path(repoRoot,suite,profile).
- Paths: testSystemPaths(repoRoot), testPlanPath, testPlanLedgerPath, testRunRecordsDir(repoRoot,slug,change), testRecordChainLockDir.
- Record v2: TestRunRecordV2Draft; appendTestRunRecordV2(repoRoot,slug,draft) → {record,path,chain:'appended'|'started'|'reset',previous} (fills prev_digest/chain_reset/digest, locked, exclusive publish); readRecordChain → empty|intact|broken; listRecordDirectory, verifyRecordChain, recordV2Digest, decodeTestRunRecordV2, declaresRecordV2.
- Files/trace: testFileRegistration({changedFiles,catalog,plan}) → {unregistered:[{path,suites}],orphans}; extractScenarios(capability,markdown); extractTaskItems(markdown).
- Blockers: TEST_BLOCKER_CODES, TEST_BLOCKER_LABELS[code]={zh,en}, TEST_NOTICE_CODES, TEST_NOTICE_LABELS, renderTestBlocker, shellQuote; blocker = {code,blocking,message,fix?,subject?}.
- Evaluation: evaluateTestPolicy(input) (pure) → TestPolicyReport {stepId,pass,blockers,notices,suites:SuiteVerdict[],trace:TraceRow[],files,chain}; evaluateStepTestPolicy(input) (IO); renderPolicyBlockers; stepTestRequirements(step); testPolicyDigest; inlineSuiteFromTest.
- Existing entry points: TestEvidenceContext gains optional changedFiles: () => Promise<readonly string[]>; TestEvidenceReport gains optional policy?: TestPolicyReport (server snapshot and `tenon status` should read it). StepTestPolicyDef / StepTestPolicyIR exported.
- Default policies live in templates/workflows/default.yaml `test_policy:` keys (regenerate with npm run generate:default-workflow).
