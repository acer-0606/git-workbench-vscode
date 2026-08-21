import { describe, expect, it } from 'vitest';

import { isValidNonce, renderWorkbenchHtml } from './workbenchPanel.js';

describe('renderWorkbenchHtml', () => {
  const nonce = 'abcdefghij0123456789AB';
  const html = renderWorkbenchHtml('https://vscode-webview.example', 'https://vscode-webview.example/workbench.js', undefined, nonce);

  it('locks every source down by default', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-");
    expect(html).toContain("style-src https://vscode-webview.example 'unsafe-inline'");
    expect(html).toContain('worker-src blob:');
    expect(html).not.toMatch(/script-src [^"]*https?:\/\//);
    expect(html).not.toContain("'unsafe-eval'");
  });

  it('requires the nonce on the script tag and nowhere else', () => {
    expect(html).toContain(`<script nonce="${nonce}" src=`);
    expect(html.match(/nonce="/g)?.length).toBe(1);
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
  });

  it('accepts only well-formed nonces', () => {
    expect(isValidNonce(nonce)).toBe(true);
    expect(isValidNonce('short')).toBe(false);
    expect(isValidNonce('with spaces and !!')).toBe(false);
  });
});
