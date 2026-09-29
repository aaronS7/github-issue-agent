import { createHash } from 'node:crypto';
import type { OutboxEntry } from './queue.js';
import { isRepositoryName } from './repository.js';
import type { GitHubAuth } from './github-auth.js';

export const REACTIONS = ['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'] as const;
export type Reaction = typeof REACTIONS[number];
export interface FeedbackTarget { repository: string; issueNumber: number; commentId?: number }
export interface CommentPayload extends FeedbackTarget { body: string }
export interface ReactionPayload extends FeedbackTarget { content: Reaction }

export class GitHubClient {
  constructor(private readonly auth: GitHubAuth, private readonly baseUrl = 'https://api.github.com') {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('GitHub API URL must use HTTPS');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid GitHub API URL');
  }

  private async request(path: string, method: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const token = typeof this.auth === 'string' ? this.auth : await this.auth.getToken(signal);
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
          method, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
          headers: {
            authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28', 'user-agent': 'just-bash-issue-agent',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        signal.throwIfAborted();
        throw new Error(`GitHub ${method} request failed`);
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Keep response details out of durable errors. */ }
        // Only retry an explicit authentication rejection, never an ambiguous failed write.
        if (response.status === 401 && typeof this.auth !== 'string') {
          this.auth.invalidate(token);
          if (attempt === 0) continue;
        }
        throw new Error(`GitHub ${method} request failed (HTTP ${response.status})`);
      }
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch {
        signal.throwIfAborted();
        throw new Error(`GitHub ${method} returned invalid JSON`);
      }
    }
  }

  private issuePath(target: FeedbackTarget): string {
    if (!isRepositoryName(target.repository) || !Number.isSafeInteger(target.issueNumber) || target.issueNumber <= 0) {
      throw new Error('Invalid feedback target');
    }
    return `/repos/${target.repository}/issues/${target.issueNumber}`;
  }

  async deliver(entry: OutboxEntry, deliveryId: string, signal: AbortSignal): Promise<void> {
    const target = entry.payload as CommentPayload | ReactionPayload;
    const path = this.issuePath(target);
    if (entry.kind === 'comment') {
      const payload = target as CommentPayload;
      if (typeof payload.body !== 'string' || !payload.body.trim()) throw new Error('Empty comment');
      // Stable across a crash after POST but before SQLite acknowledgment.
      const key = createHash('sha256').update(`${deliveryId}:${entry.key ?? entry.id}`).digest('hex');
      const marker = `<!-- just-bash-agent:${key} -->`;
      let page = 1;
      while (true) {
        const comments = await this.request(`${path}/comments?per_page=100&page=${page}`, 'GET', signal);
        if (!Array.isArray(comments)) throw new Error('Invalid GitHub comments response');
        if (comments.some((c: { body?: unknown }) => typeof c.body === 'string' && c.body.includes(marker))) return;
        if (comments.length < 100) break;
        page++;
      }
      signal.throwIfAborted();
      await this.request(`${path}/comments`, 'POST', signal, { body: `${payload.body.slice(0, 60_000)}\n\n${marker}` });
    } else {
      const payload = target as ReactionPayload;
      if (!REACTIONS.includes(payload.content)) throw new Error('Invalid reaction');
      if (payload.commentId !== undefined && (!Number.isSafeInteger(payload.commentId) || payload.commentId <= 0)) {
        throw new Error('Invalid comment ID');
      }
      const reactionPath = payload.commentId === undefined ? `${path}/reactions`
        : `/repos/${payload.repository}/issues/comments/${payload.commentId}/reactions`;
      await this.request(reactionPath, 'POST', signal, { content: payload.content });
    }
  }
}
