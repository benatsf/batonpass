/**
 * Claude desktop's built-in browser keeps a session's tabs only in memory: it closes them when the
 * signed-in account changes and after 30 idle minutes, and nothing outside the app can reopen them.
 * The agent's own browser calls are in the ledger, so a resumed session can be told what it had open.
 */

export const BROWSER_TOOL_PREFIX = 'mcp__Claude_Browser__';
const MAX_PAGES = 8;

const unquote = (raw: string) => {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

/** String values of `name` in a tool input, which ingest may have cut at 300 characters (cut values are skipped). */
function values(input: string, name: string): string[] {
  return [...input.matchAll(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map((m) => unquote(m[1]!));
}

/** Web pages only; a redacted URL cannot be reopened. */
const reopenable = (url: string) => /^(https?|file):\/\//i.test(url) && !url.includes('[REDACTED');

/**
 * The pages a session's agent last had open in the built-in browser, newest first, replayed from
 * its recorded tool calls (`<tool name> <input JSON>`, oldest first). Tabs the user opened by hand
 * are not in the transcript.
 */
export function openPages(calls: Array<{ text: string }>): string[] {
  const tabs = new Map<string, string>();
  let opened = 0;
  const show = (tab: string, url: string) => {
    tabs.delete(tab);
    tabs.set(tab, url);
  };
  for (const { text } of calls) {
    if (!text.startsWith(BROWSER_TOOL_PREFIX)) continue;
    const space = text.indexOf(' ');
    const tool = text.slice(BROWSER_TOOL_PREFIX.length, space === -1 ? undefined : space);
    const input = space === -1 ? '' : text.slice(space + 1);
    if (tool === 'tabs_close') {
      for (const tab of values(input, 'tabId')) tabs.delete(tab);
      continue;
    }
    if (tool === 'navigate') {
      const url = values(input, 'url')[0];
      if (url && reopenable(url)) show(values(input, 'tabId')[0] ?? 'seed', url);
      continue;
    }
    // preview_start opens a tab of its own; a batch may visit several pages.
    if (tool === 'preview_start' || tool === 'browser_batch') {
      for (const url of values(input, 'url')) if (reopenable(url)) show(`opened-${opened++}`, url);
    }
  }
  return [...new Set([...tabs.values()].reverse())].slice(0, MAX_PAGES);
}

export function renderTabs(pages: string[]): string {
  const safe = (url: string) => url.replace(/[<>\s]/g, encodeURIComponent);
  return [
    '<baton-browser-tabs>',
    "Pages this session had open in Claude's built-in browser, newest first. Claude closes these tabs when the signed-in account changes and after 30 idle minutes. If the work continues on one of them and it is no longer open, reopen it with the browser tools.",
    ...pages.map((url) => `- ${safe(url)}`),
    '</baton-browser-tabs>',
  ].join('\n');
}
