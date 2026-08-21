import { createHash } from 'node:crypto';

export interface DiagnosticsInput {
  readonly version: string;
  readonly capabilities?: readonly string[];
  readonly errorCodes?: readonly string[];
  readonly operationStates?: readonly string[];
  readonly durationsMs?: readonly number[];
  readonly remoteUrls?: readonly string[];
  readonly paths?: readonly string[];
  readonly notes?: string;
}

export interface RedactorOptions {
  /** Paths are hashed by default; false keeps local path context. Credentials are always redacted. */
  readonly redactPaths: boolean;
}

export interface RedactedDiagnostics {
  readonly schema: 1;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly errorCodes: readonly string[];
  readonly operationStates: readonly string[];
  readonly durationsMs: readonly number[];
  readonly remoteUrls: readonly string[];
  readonly paths: readonly string[];
  readonly pathHashes: readonly string[];
  readonly notes: string;
}

const secretPatterns: readonly RegExp[] = [
  /[A-Za-z0-9_]*(?:token|secret|password|credential|apikey|api_key)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /ssh-rsa [A-Za-z0-9+/=]{40,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Structured allowlist redaction. Only known fields enter the output model —
 * the redactor never serializes arbitrary objects and scrubs afterwards.
 * Remote URLs go through the URL parser to drop username/password/query;
 * credential scrubbing cannot be turned off by configuration.
 */
export function redactDiagnostics(input: DiagnosticsInput, options: RedactorOptions): RedactedDiagnostics {
  const scrub = (value: string): string => {
    let result = value;
    for (const pattern of secretPatterns) result = result.replace(pattern, (match) => match.replace(/[:=].*$/, '=***'));
    return result;
  };
  const safeUrl = (raw: string): string => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return scrub(raw).replace(/:\/\/[^/@]+@/, '://***@');
    }
  };
  const paths = input.paths ?? [];
  return {
    schema: 1,
    version: scrub(input.version),
    capabilities: (input.capabilities ?? []).map(scrub),
    errorCodes: (input.errorCodes ?? []).map(scrub),
    operationStates: (input.operationStates ?? []).map(scrub),
    durationsMs: (input.durationsMs ?? []).filter((value) => Number.isFinite(value) && value >= 0),
    remoteUrls: (input.remoteUrls ?? []).map(safeUrl),
    paths: options.redactPaths ? [] : paths.map(scrub),
    pathHashes: paths.map((path) => createHash('sha256').update(path).digest('hex').slice(0, 16)),
    notes: scrub(input.notes ?? ''),
  };
}
