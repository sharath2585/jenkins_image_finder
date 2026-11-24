export function normalizeJobUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP(S) Jenkins job URL without embedded credentials.");
  }
  const start = url.pathname.indexOf("/job/");
  if (start < 0 || !/^(?:\/job\/[^/]+)+\/?$/.test(url.pathname.slice(start))) {
    throw new Error("Enter a Jenkins job or folder URL, not a build, console, or API URL.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/?$/, "/");
  return url.href;
}

export function normalizeQuery(value) {
  const query = value.trim().replace(/^\/+/, "");
  if (!query || /\s|[<>"'`]/.test(query) || query.includes("://")) {
    throw new Error("Enter an image reference, image:tag, or tag without spaces or a URL scheme.");
  }
  return query;
}

export function timestampHint(query) {
  const tag = query.includes(":") ? query.slice(query.lastIndexOf(":") + 1) : query;
  if (!/^\d{14}$/.test(tag)) return null;
  const iso = `${tag.slice(0, 4)}-${tag.slice(4, 6)}-${tag.slice(6, 8)}T${tag.slice(8, 10)}:${tag.slice(10, 12)}:${tag.slice(12, 14)}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === iso.slice(0, 19) ? time : null;
}

function imageMatches(token, query) {
  if (!query.includes(":") && !query.includes("/") && !query.includes("@")) {
    return token.endsWith(`:${query}`) && token.indexOf(":") > 0;
  }
  return token === query || token.endsWith(`/${query}`);
}

export function inspectConsole(text, query, jobName) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  const lines = clean.split(/\r?\n/);
  const evidence = [];
  let branch = null;
  const checkouts = [];
  let pushRecorded = false;
  for (const line of lines) {
    const branchMatch = line.match(/(?:^|\s)Branch - (.+?)\s*$/);
    if (branchMatch) branch = branchMatch[1];
    const checkout = line.match(/Checking out Revision ([a-f0-9]{40,64}) \(([^)]+)\)/i);
    if (checkout) checkouts.push({ commit: checkout[1], branch: checkout[2] });
    const tokens = line.match(/[A-Za-z0-9][A-Za-z0-9._:/@+-]*/g) || [];
    if (tokens.some(token => imageMatches(token, query))) {
      if (evidence.length < 8) evidence.push(line.slice(0, 2000));
      if (/\b(?:docker|podman)\s+(?:image\s+)?push\s/.test(line)) pushRecorded = true;
    }
  }
  if (!evidence.length) return null;
  const branchName = value => value.replace(/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/, "");
  const candidates = branch
    ? checkouts.filter(item => branchName(item.branch) === branchName(branch))
    : checkouts;
  const checkout = candidates.length && new Set(candidates.map(item => item.commit)).size === 1
    && new Set(candidates.map(item => branchName(item.branch))).size === 1 ? candidates[0] : null;
  return {
    branch: branch || (checkout && branchName(checkout.branch)) || jobName,
    branchSource: branch || checkout ? "Console log" : "Job name (inferred)",
    commit: checkout ? checkout.commit : null,
    pushRecorded,
    evidence
  };
}

function apiUrl(url, tree) {
  return `${url}api/json?tree=${encodeURIComponent(tree)}`;
}

function readableName(url) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(decodeURIComponent(parts[parts.length - 1]));
}

export async function searchJenkins(options) {
  const { request, onProgress = () => {}, onMatch = () => {}, isCancelled = () => false } = options;
  const jobUrl = normalizeJobUrl(options.jobUrl);
  const query = normalizeQuery(options.query);
  const maxLogs = Number(options.maxLogs);
  if (!Number.isInteger(maxLogs) || maxLogs < 1 || maxLogs > 5000) {
    throw new Error("The console-log limit must be a whole number from 1 to 5000.");
  }
  const origin = new URL(jobUrl).origin;
  const pending = [jobUrl];
  const visited = new Set();
  const builds = [];
  const errors = [];
  const matches = [];
  const limits = [];
  let examined = 0;
  const addError = (url, error) => errors.push({ url, message: error.message });
  const safeUrl = value => {
    const normalized = normalizeJobUrl(value);
    if (new URL(normalized).origin !== origin) throw new Error("Jenkins job links must stay on the selected origin.");
    return normalized;
  };
  while (pending.length && !isCancelled()) {
    if (visited.size >= 500 || builds.length >= 10000) {
      limits.push("Discovery limit reached (500 jobs or 10,000 builds). Narrow the job URL.");
      break;
    }
    const url = pending.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    onProgress({ phase: "Discovering jobs", jobs: visited.size, builds: builds.length, examined });
    try {
      const data = await request(apiUrl(url, "name,_class,jobs[name,url],allBuilds[number,timestamp,url,result]{0,100}"));
      if (Array.isArray(data.jobs)) {
        for (const job of data.jobs) pending.push(safeUrl(job.url));
      }
      if (Array.isArray(data.allBuilds)) {
        let batch = data.allBuilds;
        let offset = 0;
        while (true) {
          for (const build of batch) {
            if (builds.length >= 10000) break;
            if (!Number.isInteger(build.number) || !Number.isFinite(build.timestamp)) {
              throw new Error("Jenkins returned a build without a valid number or timestamp.");
            }
            builds.push({ ...build, url: `${url}${build.number}/`, jobName: readableName(url) });
          }
          if (batch.length < 100 || builds.length >= 10000 || isCancelled()) break;
          offset += 100;
          onProgress({ phase: "Reading build history", jobs: visited.size, builds: builds.length, examined });
          const next = await request(apiUrl(url, `allBuilds[number,timestamp,url,result]{${offset},${offset + 100}}`));
          if (!Array.isArray(next.allBuilds)) throw new Error("Jenkins did not return the requested build history page.");
          batch = next.allBuilds;
        }
        if (builds.length >= 10000) limits.push("Build discovery reached 10,000 entries; older builds may be missing.");
      } else if (!Array.isArray(data.jobs)) {
        throw new Error("This Jenkins job does not expose jobs or allBuilds through its API.");
      }
    } catch (error) {
      addError(url, error);
    }
  }
  const hint = timestampHint(query);
  builds.sort((a, b) => hint === null
    ? b.timestamp - a.timestamp
    : Math.abs(a.timestamp - hint) - Math.abs(b.timestamp - hint));
  for (const build of builds) {
    if (isCancelled() || examined >= maxLogs || (options.firstMatch && matches.length)) break;
    examined += 1;
    onProgress({ phase: "Searching console logs", jobs: visited.size, builds: builds.length, examined });
    try {
      const text = await request(`${build.url}consoleText`, "text");
      const found = inspectConsole(text, query, build.jobName);
      if (found) {
        const match = { ...found, build };
        matches.push(match);
        onMatch(match);
      }
    } catch (error) {
      addError(build.url, error);
    }
  }
  const cancelled = isCancelled();
  const stoppedAfterMatch = Boolean(options.firstMatch && matches.length && examined < builds.length);
  if (examined >= maxLogs && examined < builds.length) limits.push(`Stopped at the ${maxLogs}-log limit. Increase it or narrow the job URL.`);
  return {
    matches, errors, limits, cancelled, stoppedAfterMatch, examined,
    jobs: visited.size, builds: builds.length,
    complete: !cancelled && !stoppedAfterMatch && !errors.length && !limits.length && examined === builds.length
  };
}
