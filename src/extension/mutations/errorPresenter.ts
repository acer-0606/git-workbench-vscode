import { GitWorkbenchError } from '@git-workbench/domain';

export interface PresentedMutationFailure {
  readonly title: string;
  readonly operationId?: string;
  readonly repositoryChanged: boolean;
  readonly retryAdvice: string;
  readonly diagnosticsHint: string;
}

const retryAdviceText: Readonly<Record<string, string>> = {
  none: '此操作无法重试，请调整输入后重新发起。',
  retry: '可以直接重试该操作。',
  refresh: '仓库状态已变化，请刷新后基于新状态重新确认。',
  reconcile: '结果未知或需对账，请打开恢复中心查看证据后再操作。',
  authenticate: '需要完成认证后重试。',
};

/**
 * Redacts URLs (credentials), absolute home paths and control bytes before
 * anything reaches a notification or the shared output channel.
 */
export function redactMessage(message: string, home: string): string {
  return message
    .replace(/https?:\/\/[^\s]+@/g, 'https://***@')
    .replace(/[A-Za-z]+:\/\/[^\s]+:[^\s]+@/g, '$1://***@')
    .split(home).join('~')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

export function presentMutationFailure(error: unknown, home: string): PresentedMutationFailure {
  if (!(error instanceof GitWorkbenchError)) {
    return {
      title: 'Git Workbench 操作失败',
      repositoryChanged: false,
      retryAdvice: retryAdviceText.none!,
      diagnosticsHint: '详细诊断已写入 Git Workbench 输出通道。',
    };
  }
  return {
    title: `Git Workbench 操作失败：${error.payload.code}`,
    ...(error.payload.operationId === undefined ? {} : { operationId: error.payload.operationId }),
    repositoryChanged: error.payload.repositoryChanged,
    retryAdvice: retryAdviceText[error.payload.retry] ?? retryAdviceText.none!,
    diagnosticsHint: error.payload.repositoryChanged
      ? '仓库状态已变化，视图将自动刷新；详细诊断已写入 Git Workbench 输出通道。'
      : '详细诊断已写入 Git Workbench 输出通道。',
    // The raw message is only ever sent to the restricted output channel,
    // already redacted by redactMessage at the presentation site.
  };
}
