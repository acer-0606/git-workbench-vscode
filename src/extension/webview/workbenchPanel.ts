/**
 * Renders the workbench webview HTML shell. Kept free of the VS Code runtime
 * so the CSP contract can be unit-tested. Every panel must use a fresh nonce;
 * only stylesheet loading is allowed inline-free, scripts require the nonce,
 * and no network origin is ever whitelisted.
 */
export function renderWorkbenchHtml(cspSource: string, scriptUri: string, styleUri: string | undefined, nonce: string): string {
  const stylesheet = styleUri ? `<link rel="stylesheet" href="${styleUri}">` : '';
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src blob:;"><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheet}</head><body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

const noncePattern = /^[A-Za-z0-9_-]{22}$/;

export const isValidNonce = (value: string): boolean => noncePattern.test(value);
