import { defineCommand } from 'just-bash';

// This is trusted service configuration, loaded by EXTENSIONS.
// The agent calls custom commands through the same bash tool.
export default {
  capabilities: [{
    name: 'project-info',
    description: 'Read package.json from the current project: project-info',
    create: ({ assertActive }) => defineCommand('project-info', async (_args, ctx) => {
      await assertActive();
      return { stdout: await ctx.fs.readFile('/package.json'), stderr: '', exitCode: 0 };
    }),
  }],
  hooks: [({ phase, job, issue }) => phase === 'succeeded' ? [{
    kind: 'reaction', key: 'example-heart',
    payload: { repository: issue.repository, issueNumber: issue.issueNumber, content: 'heart' },
  }] : []],
};
