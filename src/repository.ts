/** GitHub owner/repository names, excluding URL dot segments. */
export function isRepositoryName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  return !!owner && !!repo && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)
    && /^[A-Za-z0-9_.-]{1,100}$/.test(repo) && repo !== '.' && repo !== '..';
}
