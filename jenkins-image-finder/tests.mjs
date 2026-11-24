import assert from "assert";
import { inspectConsole, normalizeJobUrl, normalizeQuery, searchJenkins, timestampHint } from "./search.mjs";
import { createTabRequest, fetchInJenkinsTab } from "./bridge.mjs";

const root = "https://jenkins.example/job/service/";
const branch = `${root}job/hotfix%252Fpatch_gp_25136/`;
const sha = "5795256031bd8ed17f5730474c8d9431896be925";
const query = "bms-orchestrator-service:20260820144606";
const log = `Checking out Revision ${sha} (hotfix/patch_gp_25136)
Branch - hotfix/patch_gp_25136
+ docker push 10.113.56.67/ngp-hotfix/${query}
Finished: SUCCESS`;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const build = number => ({ number, timestamp: 1787217366868 + number, result: "SUCCESS" });

test("normalizes job URLs and rejects credentials and non-job paths", () => {
  assert.strictEqual(normalizeJobUrl(root + "?x=y"), root);
  assert.strictEqual(normalizeJobUrl(branch), branch);
  assert.strictEqual(normalizeJobUrl("https://host/jenkins/job/a"), "https://host/jenkins/job/a/");
  for (const url of ["file:///job/a", "https://user:pass@host/job/a", root + "8/console", root + "api/json"]) {
    assert.throws(() => normalizeJobUrl(url));
  }
  assert.strictEqual(normalizeQuery("/" + query), query);
  assert.throws(() => normalizeQuery(" "));
});

test("extracts the known exact image, branch, commit, and push evidence", () => {
  const found = inspectConsole(log, query, "fallback");
  assert.strictEqual(found.branch, "hotfix/patch_gp_25136");
  assert.strictEqual(found.commit, sha);
  assert.strictEqual(found.pushRecorded, true);
  assert.strictEqual(found.branchSource, "Console log");
  assert.strictEqual(found.evidence.length, 1);
  assert(inspectConsole(log, "20260820144606", "fallback"));
  assert(inspectConsole(log, "10.113.56.67/ngp-hotfix/" + query, "fallback"));
});

test("does not match tag prefixes, other images, or standalone timestamps", () => {
  assert.strictEqual(inspectConsole(log, "2026082014460", "fallback"), null);
  assert.strictEqual(inspectConsole(log, "other-service:20260820144606", "fallback"), null);
  assert.strictEqual(inspectConsole(log.replace(query, query + "7"), query, "fallback"), null);
  assert.strictEqual(inspectConsole("BUILD_TIMESTAMP=20260820144606", "20260820144606", "fallback"), null);
});

test("does not invent push evidence or ambiguous commits", () => {
  const found = inspectConsole(`deploy image "${query}"`, query, "some-job");
  assert.strictEqual(found.pushRecorded, false);
  assert.strictEqual(found.branchSource, "Job name (inferred)");
  assert.strictEqual(found.commit, null);
  const ambiguous = `Checking out Revision ${sha} (library)\nChecking out Revision ${sha} (application)\n${query}`;
  assert.strictEqual(inspectConsole(ambiguous, query, "some-job").commit, null);
});

test("handles remote ref names without choosing between conflicting commits", () => {
  const remote = log.replace("(hotfix/patch_gp_25136)", "(refs/remotes/origin/hotfix/patch_gp_25136)");
  assert.strictEqual(inspectConsole(remote, query, "fallback").commit, sha);
  const conflicting = `${log}\nChecking out Revision ${"a".repeat(40)} (hotfix/patch_gp_25136)`;
  assert.strictEqual(inspectConsole(conflicting, query, "fallback").commit, null);
});

test("uses timestamp hints only for valid calendar dates", () => {
  assert.strictEqual(timestampHint(query), Date.parse("2026-08-20T14:46:06Z"));
  assert.strictEqual(timestampHint("20260230120000"), null);
  assert.strictEqual(timestampHint("latest"), null);
});

test("discovers multibranch jobs and verifies a console match", async () => {
  const result = await searchJenkins({
    jobUrl: root, query, maxLogs: 10,
    request: async (url, format) => {
      if (format === "text") return log;
      if (url.startsWith(branch)) return { allBuilds: [build(8)] };
      return { jobs: [{ url: branch }] };
    }
  });
  assert.strictEqual(result.complete, true);
  assert.strictEqual(result.matches[0].build.url, branch + "8/");
  assert.strictEqual(result.matches[0].branch, "hotfix/patch_gp_25136");
});

test("paginates retained build history and marks log limits incomplete", async () => {
  let secondPage = false;
  const result = await searchJenkins({
    jobUrl: branch, query, maxLogs: 1,
    request: async (url, format) => {
      if (format === "text") return "no image here";
      if (decodeURIComponent(url).includes("{100,200}")) {
        secondPage = true;
        return { allBuilds: [build(101)] };
      }
      return { allBuilds: Array.from({ length: 100 }, (_, index) => build(index + 1)) };
    }
  });
  assert(secondPage);
  assert.strictEqual(result.builds, 101);
  assert.strictEqual(result.examined, 1);
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.limits.length, 1);
});

test("reports failed logs and forbidden external job links", async () => {
  const result = await searchJenkins({
    jobUrl: branch, query, maxLogs: 10,
    request: async (url, format) => {
      if (format === "text") throw new Error("HTTP 403");
      return { allBuilds: [build(8)] };
    }
  });
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.errors[0].message, "HTTP 403");
  const external = await searchJenkins({
    jobUrl: root, query, maxLogs: 10,
    request: async () => ({ jobs: [{ url: "https://other.example/job/a/" }] })
  });
  assert.strictEqual(external.complete, false);
  assert.strictEqual(external.errors.length, 1);
});

test("honors cancellation and first-match stops without claiming completeness", async () => {
  const stopped = await searchJenkins({
    jobUrl: branch, query, maxLogs: 10, isCancelled: () => true,
    request: async () => { throw new Error("Should not be requested"); }
  });
  assert.strictEqual(stopped.cancelled, true);
  assert.strictEqual(stopped.complete, false);
  const first = await searchJenkins({
    jobUrl: branch, query, maxLogs: 10, firstMatch: true,
    request: async (url, format) => format === "text" ? log : { allBuilds: [build(8), build(9)] }
  });
  assert.strictEqual(first.examined, 1);
  assert.strictEqual(first.stoppedAfterMatch, true);
  assert.strictEqual(first.complete, false);
});

test("prioritizes timestamp neighbors without excluding distant builds", async () => {
  const seen = [];
  const hint = timestampHint(query);
  const result = await searchJenkins({
    jobUrl: branch, query, maxLogs: 10,
    request: async (url, format) => {
      if (format === "text") { seen.push(url); return ""; }
      return { allBuilds: [{ ...build(1), timestamp: 0 }, { ...build(2), timestamp: hint }] };
    }
  });
  assert.strictEqual(seen[0], branch + "2/consoleText");
  assert.strictEqual(result.examined, 2);
  assert.strictEqual(result.complete, true);
});

test("surfaces incomplete or unsupported API history responses", async () => {
  const result = await searchJenkins({
    jobUrl: branch, query, maxLogs: 10, request: async () => ({ name: "unsupported" })
  });
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.errors.length, 1);
});

test("enforces user-selected log limits", async () => {
  for (const maxLogs of [0, 5001, 1.5, NaN]) {
    await assert.rejects(() => searchJenkins({ jobUrl: root, query, maxLogs, request: async () => ({}) }));
  }
});

test("tab bridge rejects cross-origin URLs and surfaces permission and JSON errors", async () => {
  const saved = globalThis.chrome;
  try {
    globalThis.chrome = { scripting: { executeScript: async () => [{ result: { ok: true, text: '{"name":"job"}' } }] } };
    const request = createTabRequest(1, "https://jenkins.example");
    assert.deepStrictEqual(await request(root), { name: "job" });
    await assert.rejects(() => request("https://other.example/job/a/"), /different origin/);
    globalThis.chrome.scripting.executeScript = async () => [{ result: { ok: true, text: "not json" } }];
    await assert.rejects(() => request(root), /invalid JSON/);
    globalThis.chrome.scripting.executeScript = async () => [{ result: { ok: false, error: "Login expired" } }];
    await assert.rejects(() => request(root), /Login expired/);
    globalThis.chrome.scripting.executeScript = async () => { throw new Error("Permission denied"); };
    await assert.rejects(() => request(root), /Cannot access the Jenkins tab/);
  } finally {
    if (saved === undefined) delete globalThis.chrome;
    else globalThis.chrome = saved;
  }
});

test("signed-in fetch reports login, HTML, size, HTTP and timeout failures", async () => {
  const names = ["location", "fetch", "AbortController", "TextDecoder"];
  const saved = names.map(name => [name, globalThis[name]]);
  try {
    globalThis.location = { origin: "https://jenkins.example" };
    globalThis.AbortController = class { abort() {} };
    globalThis.TextDecoder = class { decode(value) { return value ? Buffer.from(value).toString() : ""; } };
    const response = (text, contentType = "text/plain") => {
      let read = false;
      return {
        ok: true, url: root, headers: { get: () => contentType },
        body: { getReader: () => ({
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { done: false, value: Buffer.from(text) };
          },
          cancel: async () => {}
        }) }
      };
    };
    globalThis.fetch = async () => response("ok");
    assert.deepStrictEqual(await fetchInJenkinsTab(root, 100), { ok: true, text: "ok" });
    assert.strictEqual((await fetchInJenkinsTab("https://other.example/job/a", 100)).ok, false);
    globalThis.fetch = async () => ({ ...response("login"), url: "https://jenkins.example/login" });
    assert.match((await fetchInJenkinsTab(root, 100)).error, /login expired/);
    globalThis.fetch = async () => response("<html>Login</html>", "text/html");
    assert.match((await fetchInJenkinsTab(root, 100)).error, /HTML page/);
    globalThis.fetch = async () => response("too large");
    assert.match((await fetchInJenkinsTab(root, 2)).error, /safety limit/);
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    assert.match((await fetchInJenkinsTab(root, 100)).error, /HTTP 403/);
    globalThis.fetch = async () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; };
    assert.match((await fetchInJenkinsTab(root, 100)).error, /timed out/);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

async function runTests() {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n${error.stack}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} tests passed`);
  process.exitCode = failed ? 1 : 0;
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
