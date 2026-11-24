import { createTabRequest } from "./bridge.mjs";
import { normalizeJobUrl, searchJenkins } from "./search.mjs";

const byId = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const source = params.get("source");
const tabId = Number(params.get("tab"));
let origin = null;
let cancelled = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message) {
  byId("errors").append(element("p", message, "error"));
}

function showMatch(match) {
  const card = element("article", undefined, "result");
  card.append(element("span", match.pushRecorded ? "PUSH COMMAND RECORDED" : "IMAGE REFERENCE FOUND", "eyebrow"));
  card.append(element("h2", match.branch));
  card.append(element("p", `Branch source: ${match.branchSource}`));
  card.append(element("p", `Commit: ${match.commit || "Not unambiguously identified in the console log"}`, "commit"));
  card.append(element("p", `Build ${match.build.number} | ${match.build.result || "IN PROGRESS"} | ${new Date(match.build.timestamp).toLocaleString()}`));
  const link = element("a", "Open Jenkins build");
  link.href = match.build.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  card.append(link);
  const details = element("details");
  details.open = true;
  details.append(element("summary", "Matching console evidence"));
  details.append(element("pre", match.evidence.join("\n")));
  card.append(details);
  byId("results").append(card);
}

try {
  if (!globalThis.chrome || !chrome.scripting || !params.has("tab") || !Number.isInteger(tabId) || !source) {
    throw new Error("Open Jenkins in Chrome or Edge, sign in, then click the Jenkins Image Finder extension icon.");
  }
  const sourceUrl = new URL(source);
  if (!["http:", "https:"].includes(sourceUrl.protocol)) throw new Error("Launch the extension from an HTTP(S) Jenkins tab.");
  origin = sourceUrl.origin;
  byId("connection").textContent = `Using your signed-in tab at ${origin}. Keep that tab open.`;
  const jobStart = sourceUrl.pathname.indexOf("/job/");
  if (jobStart >= 0) {
    const jobPath = sourceUrl.pathname.slice(jobStart).match(/^(?:\/job\/[^/]+)+/);
    if (jobPath) byId("job-url").value = `${origin}${sourceUrl.pathname.slice(0, jobStart)}${jobPath[0]}/`;
  }
} catch (error) {
  byId("connection").textContent = error.message;
  byId("connection").classList.add("error");
  byId("search").disabled = true;
}

byId("cancel").addEventListener("click", () => {
  cancelled = true;
  byId("cancel").disabled = true;
  byId("progress").textContent = "Stopping after the current request (up to 30 seconds)...";
});

byId("search-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!origin) return;
  byId("errors").replaceChildren();
  byId("results").replaceChildren();
  byId("summary").textContent = "";
  cancelled = false;
  byId("search").disabled = true;
  byId("cancel").disabled = false;
  try {
    const jobUrl = normalizeJobUrl(byId("job-url").value);
    if (new URL(jobUrl).origin !== origin) {
      throw new Error("For another Jenkins server, open it, sign in, and click the extension icon from that tab.");
    }
    const result = await searchJenkins({
      jobUrl,
      query: byId("image").value,
      maxLogs: Number(byId("max-logs").value),
      firstMatch: byId("first-match").checked,
      request: createTabRequest(tabId, origin),
      isCancelled: () => cancelled,
      onMatch: showMatch,
      onProgress: state => {
        byId("progress").textContent = `${state.phase}: ${state.jobs} jobs, ${state.builds} builds discovered, ${state.examined} logs attempted.`;
      }
    });
    byId("progress").textContent = `${result.cancelled ? "Search stopped" : "Search finished"}: ${result.examined} of ${result.builds} discovered logs attempted.`;
    const status = result.complete ? "Complete for retained builds." : "Not exhaustive.";
    byId("summary").textContent = `${result.matches.length} matching builds. ${status}`;
    if (result.stoppedAfterMatch) byId("summary").append(" Stopped after the first match.");
    if (!result.matches.length && !result.complete) byId("summary").append(" No match in the searched logs does not mean the image was never built.");
    for (const limit of result.limits) showError(limit);
    if (result.errors.length) {
      showError(`${result.errors.length} requests failed. Their jobs or logs were not fully searched.`);
      for (const error of result.errors.slice(0, 20)) showError(`${error.url}: ${error.message}`);
      if (result.errors.length > 20) showError(`${result.errors.length - 20} additional failures omitted.`);
    }
  } catch (error) {
    byId("progress").textContent = "Search failed.";
    showError(error.message);
  } finally {
    byId("search").disabled = false;
    byId("cancel").disabled = true;
  }
});
