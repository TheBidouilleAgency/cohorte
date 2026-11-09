import { defineConfig } from 'vitepress'

// Deployed to GitHub Pages at https://thebidouilleagency.github.io/cohorte/
// by .github/workflows/docs.yml — `base` must match the repo name.
export default defineConfig({
  title: 'Cohorte',
  description:
    'Portable, stack-agnostic multi-agent development pipeline for Claude Code — install the core, run /cohorte-init-pipeline, and it adapts to your project.',
  base: '/cohorte/',
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/png', href: '/cohorte/favicon-32.png' }]],

  themeConfig: {
    logo: '/cohorte-mark.svg',

    nav: [
      { text: 'Guide', link: '/guide/why-cohorte' },
      { text: 'Reference', link: '/reference/commands' },
      {
        text: 'Changelog',
        link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/CHANGELOG.md',
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Why not just ask your agent?', link: '/guide/why-cohorte' },
            { text: 'What is Cohorte?', link: '/guide/what-is-cohorte' },
            { text: 'Getting started', link: '/guide/getting-started' },
          ],
        },
        {
          text: 'Using the pipeline',
          items: [
            { text: 'The feature cycle', link: '/guide/feature-cycle' },
            { text: 'Workflows (multi-agent runs)', link: '/guide/workflows' },
            { text: 'Token economy', link: '/guide/token-economy' },
            { text: 'Parallel features', link: '/guide/parallel-features' },
          ],
        },
        {
          text: 'Capabilities',
          items: [
            { text: 'Design system', link: '/guide/design-system' },
            { text: 'Kanban mirror', link: '/guide/kanban' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Commands', link: '/reference/commands' },
            { text: 'Agents', link: '/reference/agents' },
            { text: 'The profile (PIPELINE.md)', link: '/reference/profile' },
            { text: 'Gate & permissions', link: '/reference/gate' },
            { text: 'Shipped scripts', link: '/reference/scripts' },
            { text: 'Runtimes (Codex, Cursor, Gemini, OpenCode)', link: '/reference/runtimes' },
            { text: 'Installers & updates', link: '/reference/installers' },
            { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/TheBidouilleAgency/cohorte' }],

    search: { provider: 'local' },

    outline: { level: [2, 3] },

    footer: {
      message: 'Released under the AGPL-3.0 license.',
      // Raw HTML (v-html) — the img src must carry the /cohorte/ base itself.
      copyright:
        'Built by <a href="https://github.com/TheBidouilleAgency" target="_blank" rel="noopener" ' +
        'style="display:inline-flex;align-items:center;gap:6px;vertical-align:middle;font-weight:500">' +
        '<img src="/cohorte/tba-mark-64.png" alt="The Bidouille Agency" ' +
        'style="height:18px;width:18px;border-radius:5px">The Bidouille Agency</a>',
    },

    editLink: {
      pattern: 'https://github.com/TheBidouilleAgency/cohorte/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
