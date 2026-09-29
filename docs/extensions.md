# Tools and lifecycle hooks

The model sees one tool, `bash`. You add capabilities by registering just-bash commands; the agent can compose them with pipes, redirections, and the built-in text/file commands. The trusted host owns Git operations, credentials, queue state, and feedback delivery.

## Load a module

Set `EXTENSIONS=./examples/extensions.mjs` in the service configuration and restart. Use a JavaScript ES module with a default export. Paths are resolved from the service working directory.

The shipped example adds a `project-info` command and a completion reaction. Here is a complete equivalent:

```js
import { defineCommand } from 'just-bash';

export default {
  capabilities: [{
    name: 'project-info',
    description: 'Read package.json: project-info',
    create: ({ assertActive }) => defineCommand('project-info', async (_args, ctx) => {
      await assertActive();
      return { stdout: await ctx.fs.readFile('/package.json'), stderr: '', exitCode: 0 };
    }),
  }],
  hooks: [({ phase, issue }) => phase === 'succeeded' ? [{
    kind: 'reaction',
    key: 'custom-completion-heart',
    payload: {
      repository: issue.repository,
      issueNumber: issue.issueNumber,
      content: 'heart',
    },
  }] : []],
};
```

The model can now run `project-info | jq '.scripts'`. `agent-tools` lists available capabilities. A repository without `package.json` will produce a command error for this example; adapt the command to the project.

## Capability contract

`create({signal, assertActive})` returns a `defineCommand` command whose name matches the capability name. The command receives `(args, ctx)` and returns `{stdout, stderr, exitCode}`. Use `ctx.fs` to read or write the isolated checkout. just-bash documents [custom commands](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md#custom-commands).

Names must start with a lowercase letter and contain only lowercase letters, digits, or hyphens. Keep them unique and avoid built-in command names. `agent-tools` is reserved. The runner checks lease ownership before shell execution and before capability execution. Call `assertActive()` again immediately before an external side effect and honor `signal` during asynchronous work.

Extension modules execute as trusted host code. A capability that invokes a host process is granting that capability's authority to the model. For validation tools, use an isolated runner with a defined command and resource limits. The default sandbox has no package manager, Git executable, Python, JavaScript execution, or network configured.

## Return durable feedback from hooks

Hooks are synchronous functions of `{phase, job, issue, summary?, commit?, changed?, error?}` returning an array of effects. Supported phases:

| Phase | When it occurs |
| --- | --- |
| `started` | An attempt begins before repository preparation. |
| `succeeded` | The result is ready; feedback commits with job completion. |
| `retrying` | A handled run error leaves retry budget. |
| `failed` | A handled run error exhausts retry budget. |

Return `[]` when the hook has nothing to do. Hooks should be deterministic, bounded, and avoid throwing: a hook error can fail the attempt. Do not perform an API request inside a hook. Instead return:

```js
{
  kind: 'comment',
  key: 'custom-success-comment',
  payload: { repository: issue.repository, issueNumber: issue.issueNumber, body: 'Ready for review.' },
}
```

Reaction effects use `kind:'reaction'` and a payload with `content` instead of `body`; optionally add `commentId`. Supported values are `+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, and `eyes`.

Keys are unique per job. A stable key deduplicates a replay; using the same key with a different payload keeps the first effect. Use an attempt-specific key only if each attempt should deliberately emit a separate effect. The default hooks are installed in addition to custom hooks when `GITHUB_FEEDBACK=true`.

The model-facing `github-comment` and `github-react` commands already enqueue durable feedback. Their payload-based keys are stable across job retries. An abrupt process death may prevent a hook from executing; a lease that expires on the final allowed attempt can leave a dead job without failure feedback. Inspect queue status for these cases.

## Replace the model adapter

An extension can export `createModel(job, issue)` returning an adapter with `complete(messages, signal)`. Return `{script:'...'}`, `{scripts:['...', '...']}`, or `{text:'final summary'}`. Every script counts toward `MAX_STEPS`. The runner executes batches sequentially and rejects a batch that would exceed the remaining budget before running it.

The included `ScriptedModel` is useful for repeatable demos. For a live adapter, respect cancellation and return a final summary that accurately distinguishes performed validation from validation requiring unavailable tools. GitHub credentials belong to the host feedback/source clients, not to model messages or bash environment variables.

See [usage](usage.md) for built-in commands and settings, and [operations](operations.md) for inspecting failures.
