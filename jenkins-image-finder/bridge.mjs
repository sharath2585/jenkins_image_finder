// This function is serialized into the signed-in tab; keep it self-contained.
export async function fetchInJenkinsTab(requestUrl, maximumBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const url = new URL(requestUrl);
    if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("The request must use the signed-in Jenkins tab's origin.");
    }
    const response = await fetch(url.href, {
      credentials: "same-origin",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain" }
    });
    if (!response.ok) throw new Error(`Jenkins returned HTTP ${response.status}. Check your login and job permissions.`);
    if (new URL(response.url).pathname.includes("/login")) {
      throw new Error("Jenkins login expired. Sign in again in the original tab.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${Math.round(maximumBytes / 1048576)} MB safety limit; this request was not searched completely.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const type = response.headers.get("content-type") || "";
    if (type.includes("text/html") || /^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error("Jenkins returned an HTML page instead of data. Check login, job URL, and permissions.");
    }
    return { ok: true, text };
  } catch (error) {
    return {
      ok: false,
      error: error.name === "AbortError" ? "Jenkins request timed out after 30 seconds." : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createTabRequest(tabId, origin) {
  return async function request(url, format = "json") {
    if (new URL(url).origin !== origin) throw new Error("Jenkins returned a link to a different origin; refusing to follow it.");
    let executions;
    try {
      executions = await chrome.scripting.executeScript({
        target: { tabId },
        func: fetchInJenkinsTab,
        args: [url, format === "json" ? 4 * 1048576 : 8 * 1048576]
      });
    } catch (error) {
      throw new Error(`Cannot access the Jenkins tab. Keep it open, signed in, and click the extension from that tab again. ${error.message}`);
    }
    const result = executions[0] && executions[0].result;
    if (!result || !result.ok) throw new Error(result ? result.error : "The Jenkins tab returned no response.");
    if (format === "text") return result.text;
    try {
      return JSON.parse(result.text);
    } catch (error) {
      throw new Error(`Jenkins returned invalid JSON: ${error.message}`);
    }
  };
}
