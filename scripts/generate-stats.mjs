// Generates dist/stats.svg from the GitHub GraphQL API — a self-owned
// replacement for third-party stats-card services. Runs in CI with the
// repo's GITHUB_TOKEN; locally: GITHUB_TOKEN=$(gh auth token) node scripts/generate-stats.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const USER = 'Chandu6702';
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const query = `
  query ($login: String!) {
    user(login: $login) {
      followers { totalCount }
      pullRequests { totalCount }
      issues { totalCount }
      contributionsCollection {
        contributionCalendar { totalContributions }
      }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        totalCount
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`;

const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, variables: { login: USER } }),
});
const payload = await res.json();
if (payload.errors) {
  console.error(JSON.stringify(payload.errors, null, 2));
  process.exit(1);
}
const user = payload.data.user;

const stars = user.repositories.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0);
const contributions = user.contributionsCollection.contributionCalendar.totalContributions;

// Self-owned visitor counter: the traffic API only keeps 14 days, so a
// running total (deduped by day) is persisted as visits.json on the same
// output branch the card ships from. Today is skipped — it's still counting.
// The Actions GITHUB_TOKEN cannot read traffic — that needs a PAT, provided
// as the TRAFFIC_TOKEN secret. Without one the card just omits the count.
let visits = null;
try {
  const trafficRes = await fetch(
    `https://api.github.com/repos/${USER}/${USER}/traffic/views?per=day`,
    { headers: { Authorization: `bearer ${process.env.TRAFFIC_TOKEN || token}` } },
  );
  if (!trafficRes.ok) {
    console.error(`traffic lookup skipped: HTTP ${trafficRes.status} (set the TRAFFIC_TOKEN secret to enable visit counting)`);
  }
  if (trafficRes.ok) {
    const traffic = await trafficRes.json();
    let state = { total: 0, lastDate: '' };
    const prev = await fetch(
      `https://raw.githubusercontent.com/${USER}/${USER}/output/visits.json`,
    );
    if (prev.ok) {
      state = await prev.json();
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const day of traffic.views ?? []) {
      const date = day.timestamp.slice(0, 10);
      if (date > state.lastDate && date < today) {
        state.total += day.count;
        state.lastDate = date;
      }
    }
    visits = state.total;
    await mkdir('dist', { recursive: true });
    await writeFile('dist/visits.json', JSON.stringify(state));
  }
} catch (e) {
  console.error('traffic lookup failed (non-fatal):', e.message);
}

// Aggregate language bytes across repositories, keep the top five.
const langBytes = new Map();
for (const repo of user.repositories.nodes) {
  for (const edge of repo.languages.edges) {
    const key = edge.node.name;
    const entry = langBytes.get(key) ?? { size: 0, color: edge.node.color ?? '#8b949e' };
    entry.size += edge.size;
    langBytes.set(key, entry);
  }
}
const totalBytes = [...langBytes.values()].reduce((sum, l) => sum + l.size, 0) || 1;
const topLangs = [...langBytes.entries()]
  .map(([name, { size, color }]) => ({ name, color, pct: (size / totalBytes) * 100 }))
  .sort((a, b) => b.pct - a.pct)
  .slice(0, 5);

const stats = [
  { label: 'Contributions (year)', value: contributions },
  { label: 'Public repositories', value: user.repositories.totalCount },
  { label: 'Pull requests', value: user.pullRequests.totalCount },
  { label: 'Issues', value: user.issues.totalCount },
  { label: 'Stars earned', value: stars },
  { label: 'Followers', value: user.followers.totalCount },
];

// ---- render ----
const W = 800;
const H = 210;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const statRows = stats
  .map(
    (s, i) => `
    <text x="46" y="${78 + i * 22}" class="label">${esc(s.label)}</text>
    <text x="250" y="${78 + i * 22}" class="value">${s.value.toLocaleString('en')}</text>`,
  )
  .join('');

// Stacked language bar with 2px gaps + legend, colors follow GitHub's own
// per-language palette so identity matches what users see on repos.
const BAR_X = 330;
const BAR_W = 424;
let cursor = BAR_X;
const segments = topLangs
  .map((lang) => {
    const width = Math.max(6, (lang.pct / 100) * BAR_W - 2);
    const seg = `<rect x="${cursor.toFixed(1)}" y="70" width="${width.toFixed(1)}" height="10" rx="3" fill="${lang.color}" />`;
    cursor += width + 2;
    return seg;
  })
  .join('\n    ');

const legend = topLangs
  .map(
    (lang, i) => `
    <circle cx="${BAR_X + 8 + (i % 3) * 150}" cy="${104 + Math.floor(i / 3) * 24}" r="5" fill="${lang.color}" />
    <text x="${BAR_X + 20 + (i % 3) * 150}" y="${108 + Math.floor(i / 3) * 24}" class="label">${esc(lang.name)} ${lang.pct.toFixed(1)}%</text>`,
  )
  .join('');

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub statistics for ${USER}">
  <style>
    .title { font: 600 18px 'Segoe UI', Ubuntu, sans-serif; fill: #e6edf3; }
    .label { font: 400 13px 'Segoe UI', Ubuntu, sans-serif; fill: #8b949e; }
    .value { font: 600 13px 'Segoe UI', Ubuntu, sans-serif; fill: #e6edf3; }
    .subtitle { font: 600 14px 'Segoe UI', Ubuntu, sans-serif; fill: #e6edf3; }
    .card { animation: fade 0.8s ease-out; }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    .pulse { stroke-dasharray: 120; stroke-dashoffset: 120; animation: draw 2.4s ease-out 0.3s forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }
  </style>
  <g class="card">
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="#0f172a" stroke="#1e293b" />
    <polyline class="pulse" points="30,32 44,32 50,20 58,42 64,26 68,32 82,32" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    <text x="94" y="38" class="title">${USER} on GitHub</text>
    <text x="748" y="38" text-anchor="end" class="label">${
      visits !== null ? `${visits.toLocaleString('en')} profile visits · ` : ''
    }updated ${new Date().toISOString().slice(0, 10)}</text>
    ${statRows}
    <text x="${BAR_X}" y="58" class="subtitle">Most-written languages</text>
    ${segments}
    ${legend}
  </g>
</svg>
`;

await mkdir('dist', { recursive: true });
await writeFile('dist/stats.svg', svg);
console.log(`stats.svg written — ${contributions} contributions, top language ${topLangs[0]?.name ?? 'n/a'}`);
