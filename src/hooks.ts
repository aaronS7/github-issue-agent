import { defineCommand, decodeBytesToUtf8 } from 'just-bash';
import { createHash } from 'node:crypto';
import type { AgentCapability } from './agent.js';
import type { IssueEvent } from './events.js';
import { REACTIONS, type FeedbackTarget, type Reaction } from './github.js';
import type { DurableQueue, OutboxInput, QueueJob } from './queue.js';

export interface LifecycleContext {
  phase: 'started' | 'succeeded' | 'retrying' | 'failed';
  job: QueueJob;
  issue: IssueEvent;
  summary?: string;
  commit?: string;
  changed?: boolean;
  error?: string;
}
/** Hooks are pure: return effects; delivery is handled by the durable outbox. */
export type LifecycleHook = (context: LifecycleContext) => OutboxInput[];

export function targetFor(issue: IssueEvent): FeedbackTarget {
  return {
    repository: issue.repository, issueNumber: issue.issueNumber,
    ...(issue.comment ? { commentId: issue.comment.id } : {}),
  };
}

export const defaultLifecycleHook: LifecycleHook = (context) => {
  const target = targetFor(context.issue);
  const reaction = (content: Reaction): OutboxInput => ({
    kind: 'reaction', key: `lifecycle-${context.phase}-reaction`, payload: { ...target, content },
  });
  if (context.phase === 'started') return [reaction('eyes')];
  if (context.phase === 'retrying') return [];
  const body = context.phase === 'succeeded'
    ? `Run #${context.job.id} completed.\n\n${context.summary ?? ''}\n\n${context.changed
      ? `Changes are saved in local commit \`${context.commit}\`; the worker retains the checkout and patch for review.`
      : 'The run produced no file changes.'}`
    : `Run #${context.job.id} failed after ${context.job.attempts} attempts. See the worker logs and queue for details.`;
  return [reaction(context.phase === 'succeeded' ? 'rocket' : 'confused'), {
    kind: 'comment', key: `lifecycle-${context.phase}-comment`, payload: { ...target, body },
  }];
};

export function feedbackCapabilities(queue: DurableQueue, job: QueueJob, issue: IssueEvent): AgentCapability[] {
  const occurrences = new Map<string, number>();
  const target = targetFor(issue);
  const enqueue = (effect: OutboxInput) => {
    const hash = createHash('sha256').update(JSON.stringify([effect.kind, effect.payload])).digest('hex');
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    effect.key = `agent-${hash}-${occurrence}`;
    if (!job.leaseToken || !queue.enqueueEffects(job.id, job.leaseToken, [effect])) throw new Error('Lease lost');
  };
  return [{
    name: 'github-comment', description: 'Queue an issue reply: github-comment "message" or pipe the message on stdin.',
    create: ({ assertActive }) => defineCommand('github-comment', async (args, ctx) => {
      const body = args.length ? args.join(' ') : decodeBytesToUtf8(ctx.stdin);
      if (!body.trim() || body.length > 60_000) return { stdout: '', stderr: 'Comment must contain 1–60000 characters\n', exitCode: 2 };
      await assertActive();
      enqueue({ kind: 'comment', payload: { ...target, body } });
      return { stdout: 'Comment queued for delivery.\n', stderr: '', exitCode: 0 };
    }),
  }, {
    name: 'github-react', description: `Queue a reaction on the triggering issue/comment: github-react ${REACTIONS.join('|')}`,
    create: ({ assertActive }) => defineCommand('github-react', async (args) => {
      if (args.length !== 1 || !REACTIONS.includes(args[0] as Reaction)) {
        return { stdout: '', stderr: 'Choose a supported GitHub reaction\n', exitCode: 2 };
      }
      await assertActive();
      enqueue({ kind: 'reaction', payload: { ...target, content: args[0] } });
      return { stdout: 'Reaction queued for delivery.\n', stderr: '', exitCode: 0 };
    }),
  }];
}
