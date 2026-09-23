import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'fr-FR',
  title: 'Cohorte',
  description: 'Documentation du moteur local de workflows pour agents de code',
  base: '/cohorte/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Démarrer', link: '/guide/installation' },
      { text: 'Parcours', link: '/guide/parcours' },
      { text: 'Référence', link: '/reference/cli' },
      { text: 'GitHub', link: 'https://github.com/TheBidouilleAgency/cohorte' }
    ],
    sidebar: [
      {
        text: 'Découvrir',
        items: [
          { text: 'Accueil', link: '/' },
          { text: 'Installer', link: '/guide/installation' },
          { text: 'Premiers pas', link: '/guide/demarrage' },
          { text: 'Concepts', link: '/guide/concepts' }
        ]
      },
      {
        text: 'Utiliser Cohorte',
        items: [
          { text: 'Parcours de travail', link: '/guide/parcours' },
          { text: 'Fournisseurs et comptes', link: '/guide/providers' },
          { text: 'Dépannage', link: '/guide/depannage' }
        ]
      },
      {
        text: 'Référence',
        items: [
          { text: 'Commandes CLI', link: '/reference/cli' },
          { text: 'Profil de projet', link: '/reference/profile' },
          { text: 'Intégrations', link: '/reference/integrations' }
        ]
      },
      {
        text: 'Technique et maintenance',
        items: [
          { text: 'État de l’implémentation', link: '/IMPLEMENTATION' },
          { text: 'Qualification', link: '/qualification/README' },
          { text: 'Protocole local', link: '/PROTOCOL' },
          { text: 'Roadmap', link: '/ROADMAP' },
          { text: 'Publier une version', link: '/RELEASING' },
          { text: 'Audit de l’expérience CLI', link: '/CLI-UX-AUDIT' }
        ]
      }
    ],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/TheBidouilleAgency/cohorte/edit/main/docs/:path',
      text: 'Modifier cette page'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/TheBidouilleAgency/cohorte' }
    ],
    footer: { message: 'Cohorte est publié sous licence AGPL-3.0-only.' }
  }
})
