declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [brand]: Name;
};

export type RepositoryId = Brand<string, 'RepositoryId'>;
export type CommonRepositoryId = Brand<string, 'CommonRepositoryId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type ObjectId = Brand<string, 'ObjectId'>;
export type RepoRelativePath = Brand<string, 'RepoRelativePath'>;

const isWindowsUnsafePathSegment = (segment: string): boolean => {
  const deviceName = segment.split('.', 1)[0]?.replace(/[ .]+$/, '') ?? '';

  return (
    segment.includes(':') ||
    segment.endsWith('.') ||
    segment.endsWith(' ') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceName)
  );
};

export const asRepositoryId = (value: string): RepositoryId => {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('invalid repository id');
  }

  return value as RepositoryId;
};

export const asCommonRepositoryId = (value: string): CommonRepositoryId => {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('invalid common repository id');
  }

  return value as CommonRepositoryId;
};

export const asOperationId = (value: string): OperationId => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('invalid operation id');
  }

  return value as OperationId;
};

export const asObjectId = (value: string): ObjectId => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new TypeError('invalid object id');
  }

  return value as ObjectId;
};

export const asRepoRelativePath = (
  value: string,
  platform: string = process.platform,
): RepoRelativePath => {
  const segments = value.split('/');

  if (
    !value ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    (platform === 'win32' && value.includes('\\')) ||
    segments.some((part) => part === '' || part === '.' || part === '..') ||
    (platform === 'win32' && segments.some(isWindowsUnsafePathSegment))
  ) {
    throw new TypeError('invalid repository-relative path');
  }

  return value as RepoRelativePath;
};
