import { defineConfig } from 'vitepress'

// Deployed to GitHub Pages at https://thebidouilleagency.github.io/cohorte/
// by .github/workflows/docs.yml — `base` must match the repo name.
export default defineConfig({
  title: 'Cohorte',
  description:
    'Durable multi-agent development pipeline for Pi with typed contracts, SQLite state and crash-safe runs.',
  base: '/cohorte/',
  // docs/v3/ is the V3 working set (spec, design of record, ADRs, plan): engineering
  // documents with raw `{{ }}` and `<placeholders>` that Vue would try to compile.
  srcExclude: ['v3/**'],
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
          text: 'V3',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Maintainer guide', link: '/guide/maintainers' },
          ],
        },
        {
          text: 'Architecture',
          items: [
            { text: 'V3 specification', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/SPEC.md' },
            { text: 'Design record', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/DESIGN.md' },
            { text: 'CLI reference', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/CLI.md' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Commands', link: '/reference/commands' },
            { text: 'Exit codes', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/reference/exit-codes.md' },
            { text: 'Error codes', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/reference/error-codes.md' },
            { text: 'Configuration', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/reference/configuration.md' },
            { text: 'Security model', link: 'https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/reference/security-model.md' },
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
