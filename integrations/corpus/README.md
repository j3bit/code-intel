# Integration corpus

Most fixtures in this directory are small, repository-owned samples intended to
exercise one language-server method deterministically. The following fixtures
are pinned copies from public projects so shell servers are also tested against
real-world configuration syntax:

| Fixture | Upstream source | Revision | License | Local changes |
| --- | --- | --- | --- | --- |
| `zsh/zshrc.zsh` | [Oh My Zsh `zshrc.zsh-template`](https://github.com/ohmyzsh/ohmyzsh/blob/c5ba74cf02cce4c342153f79089100194f30940f/templates/zshrc.zsh-template) | `c5ba74cf02cce4c342153f79089100194f30940f` | [MIT](licenses/ohmyzsh-MIT.txt) | None |
| `tcsh/dot.tcshrc` | [tcsh `dot.tcshrc`](https://github.com/tcsh-org/tcsh/blob/b7db07931546178c4cb2542b5fc850c483628ed5/dot.tcshrc) | `b7db07931546178c4cb2542b5fc850c483628ed5` | [BSD-3-Clause](licenses/tcsh-BSD-3-Clause.txt) | None |

The source URL, revision, and license are duplicated in
`integrations/real-server-matrix.json` so generated reports remain
self-describing.
