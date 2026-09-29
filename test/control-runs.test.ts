import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createControlServer } from '../src/control-server.js';
import { DurableQueue } from '../src/queue.js';

const secret = 'literal-current-env-secret';

async function serverFixture() {
  const root = mkdtempSync(join(tmpdir(), 'issue-control-runs-'));
  const dataDir = join(root, 'data');
  const envPath = join(root, '.env');
  writeFileSync(envPath, `DATA_DIR='${dataDir}'\nGITHUB_TOKEN='${secret}'\n`);
  const server = createControlServer({ envPath });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cleanup = async () => {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dataDir, base, cleanup };
}

function dataFixture(dataDir: string) {
  const queue = new DurableQueue(join(dataDir, 'queue.sqlite'), { now: () => 1000, leaseMs: 100 });
  const obs = new DatabaseSync(join(dataDir, 'observability.sqlite'));
  obs.exec(`CREATE TABLE run_attempts (
    id TEXT PRIMARY KEY, job_id INTEGER, attempt INTEGER, repository TEXT, issue_number INTEGER,
    lease_token TEXT, status TEXT, phase TEXT, started_at INTEGER, updated_at INTEGER,
    finished_at INTEGER, summary TEXT, error TEXT, steps INTEGER, failed_commands INTEGER,
    model_calls INTEGER, model_ms REAL, command_ms REAL, input_tokens INTEGER,
    output_tokens INTEGER, recording_path TEXT, recording_truncated INTEGER, trace_truncated INTEGER
  );
  CREATE TABLE run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, type TEXT, at INTEGER,
    elapsed_ms REAL, data_json TEXT
  );`);
  const enqueue = (deliveryId: string, title = deliveryId) => queue.enqueue({
    deliveryId, repository: 'owner/repo', issueNumber: 7, eventKind: 'issues.opened',
    payload: { issue: { title, body: 'private issue body' } },
  });
  const insertRun = (jobId: number, leaseToken: string, recordingPath: string | null = null) => {
    const id = randomUUID();
    obs.prepare('INSERT INTO run_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, jobId, 1, 'owner/repo', 7, leaseToken, 'running', 'model',
      1000, 1001, null, `Summary with ${secret}`, null, 2, 0, 1, 12, 3, 20, 4,
      recordingPath, 0, 0,
    );
    return id;
  };
  return { queue, obs, enqueue, insertRun, close: () => { obs.close(); queue.close(); } };
}

test('GET /api/runs reports empty history without creating a data directory', async () => {
  const f = await serverFixture();
  try {
    const response = await fetch(`${f.base}/api/runs`);
    assert.equal(response.status, 200);
    const body = await response.json() as { available: boolean; jobs: unknown[]; nextCursor: number | null };
    assert.equal(body.available, false);
    assert.deepEqual(body.jobs, []);
    assert.equal(body.nextCursor, null);
    assert.equal(existsSync(f.dataDir), false);
  } finally { await f.cleanup(); }
});

test('GET runs filters and paginates; invalid query and cross-origin requests fail', async () => {
  const f = await serverFixture();
  const data = dataFixture(f.dataDir);
  try {
    const first = data.enqueue('first');
    const second = data.enqueue('second');
    const third = data.enqueue('third');
    const claimed = data.queue.claim()!;
    assert.equal(claimed.id, first);
    assert.equal(data.queue.complete(first, claimed.leaseToken!), true);
    const page = await fetch(`${f.base}/api/runs?limit=2`);
    assert.equal(page.status, 200);
    const body = await page.json() as { jobs: Array<{ id: number }>; nextCursor: number };
    assert.deepEqual(body.jobs.map(job => job.id), [third, second]);
    assert.equal(body.nextCursor, second);
    const older = await fetch(`${f.base}/api/runs?before=${body.nextCursor}&status=done`);
    assert.equal(older.status, 200);
    assert.deepEqual((await older.json() as { jobs: Array<{ id: number }> }).jobs.map(job => job.id), [first]);
    for (const path of ['/api/runs?limit=0', '/api/runs?limit=51', '/api/runs?limit=no',
      '/api/runs?before=-1', '/api/runs?status=unknown', `/api/runs/${first}?after=-1`]) {
      assert.equal((await fetch(`${f.base}${path}`)).status, 400, path);
    }
    assert.equal((await fetch(`${f.base}/api/runs`, { headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(`${f.base}/api/runs`, { headers: { origin: f.base } })).status, 200);
  } finally { data.close(); await f.cleanup(); }
});

test('GET detail, cast and JSONL export enforce ownership and redact current env secrets', async () => {
  const f = await serverFixture();
  const data = dataFixture(f.dataDir);
  try {
    const one = data.enqueue('one', `Issue ${secret}`);
    const two = data.enqueue('two');
    const claimed = data.queue.claim()!;
    assert.equal(claimed.id, one);
    const recordingDir = join(f.dataDir, 'recordings');
    mkdirSync(recordingDir);
    const runId = randomUUID();
    const castPath = join(recordingDir, `${runId}.cast`);
    data.obs.prepare('INSERT INTO run_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      runId, one, 1, 'owner/repo', 7, claimed.leaseToken, 'running', 'model',
      1000, 1001, null, `Summary with ${secret}`, null, 2, 0, 1, 12, 3, 20, 4,
      castPath, 0, 0,
    );
    const otherRun = data.insertRun(two, 'other-token');
    writeFileSync(castPath, '{"version":2}\n[0.1,"o","safe"]\n[0.2,"o","unfinished"');
    for (let n = 1; n <= 3; n++) {
      data.obs.prepare('INSERT INTO run_events (run_id,type,at,elapsed_ms,data_json) VALUES (?,?,?,?,?)')
        .run(runId, 'command', 1000 + n, n * 10,
          JSON.stringify({ text: `event ${n} ${secret}`, [`field-${secret}`]: 'safe' }));
    }
    const listResponse = await fetch(`${f.base}/api/runs`);
    const listText = await listResponse.text();
    assert.equal(listResponse.status, 200);
    assert.equal(listText.includes(secret), false);
    assert.match(listText, /\[REDACTED\]/);
    const detailResponse = await fetch(`${f.base}/api/runs/${one}/attempts/${runId}?limit=2`);
    assert.equal(detailResponse.status, 200);
    const detailText = await detailResponse.text();
    assert.equal(detailText.includes(secret), false);
    const detail = JSON.parse(detailText) as {
      job: { id: number }; run: { id: string }; events: Array<{ id: number }>;
      nextCursor: number; hasMore: boolean;
    };
    assert.equal(detail.job.id, one);
    assert.equal(detail.run.id, runId);
    assert.deepEqual(detail.events.map(event => event.id), [1, 2]);
    assert.equal(detail.hasMore, true);
    const later = await fetch(`${f.base}/api/runs/${one}/attempts/${runId}?after=${detail.nextCursor}`);
    assert.deepEqual((await later.json() as { events: Array<{ id: number }> }).events.map(event => event.id), [3]);
    assert.equal((await fetch(`${f.base}/api/runs/${one}/attempts/${otherRun}`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/runs/${two}/attempts/${runId}/recording`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/runs/${two}/attempts/${runId}/events.jsonl`)).status, 404);
    const recording = await fetch(`${f.base}/api/runs/${one}/attempts/${runId}/recording`);
    assert.equal(recording.status, 200);
    assert.equal(recording.headers.get('content-type'), 'application/x-asciicast; charset=utf-8');
    assert.equal(recording.headers.get('x-recording-partial'), 'true');
    assert.equal(recording.headers.get('content-disposition'), `attachment; filename="${runId}.cast"`);
    assert.equal(await recording.text(), '{"version":2}\n[0.1,"o","safe"]\n');
    writeFileSync(castPath, '{"version":2}\n[0.1,"o","safe"]\n');
    const activeRecording = await fetch(`${f.base}/api/runs/${one}/attempts/${runId}/recording`);
    assert.equal(activeRecording.headers.get('x-recording-partial'), 'true');
    data.obs.prepare("UPDATE run_attempts SET status='succeeded',finished_at=1100 WHERE id=?").run(runId);
    const finishedRecording = await fetch(`${f.base}/api/runs/${one}/attempts/${runId}/recording`);
    assert.equal(finishedRecording.headers.get('x-recording-partial'), 'false');
    const exported = await fetch(`${f.base}/api/runs/${one}/attempts/${runId}/events.jsonl`);
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const exportText = await exported.text();
    assert.equal(exportText.includes(secret), false);
    const lines = exportText.trim().split('\n').map(line => JSON.parse(line) as { id: number; data: { text: string } });
    assert.deepEqual(lines.map(line => line.id), [1, 2, 3]);
    assert(lines.every(line => line.data.text.includes('[REDACTED]')));
  } finally { data.close(); await f.cleanup(); }
});
