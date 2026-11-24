chrome.action.onClicked.addListener((tab) => {
  const url = new URL(chrome.runtime.getURL("index.html"));
  if (tab.id !== undefined) url.searchParams.set("tab", String(tab.id));
  if (tab.url) url.searchParams.set("source", tab.url);
  chrome.tabs.create({ url: url.href });
});
