/**
 * Future provider interfaces: declared in V1, never registered. No network,
 * credential or content plumbing may be attached to these types until the
 * corresponding provider plan ships with its own consent gates.
 */
export interface ProviderDataRequest {
  readonly classification: 'metadata' | 'source' | 'diff';
  readonly purpose: string;
  readonly bytes: number;
}

export interface ProviderConsent {
  readonly operationId: string;
  readonly allowed: readonly ProviderDataRequest[];
}

export interface RemoteHostingProvider {
  readonly id: string;
  readonly domains: readonly string[];
  connect(consent: ProviderConsent, signal: AbortSignal): Promise<void>;
}

export interface AiProvider {
  readonly id: string;
  explain(request: ProviderDataRequest, consent: ProviderConsent, signal: AbortSignal): Promise<string>;
}

export interface PatchSharingProvider {
  readonly id: string;
  share(request: ProviderDataRequest, consent: ProviderConsent, signal: AbortSignal): Promise<{ readonly url: string }>;
}

/** V1 ships zero provider registrations by contract. */
export const registeredFutureProviders: readonly unknown[] = [];
