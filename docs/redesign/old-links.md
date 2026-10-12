# Old links (from the retired graphite design)

Copied word for word from `design/particl-graphite/README.md` § 1.2 when that folder was removed (owner, 12 Oct 2026: `design/` keeps only v14 and v12). `tests/unit/shellRedirects.spec.ts` reads this section to prove every old link is either rewritten (OLD_TO_NEW) or still served (PENDING).

### 1.2 Old → new: every old page and deep link

| Old URL / page | Now |
|---|---|
| `?suite=studio&page=stages` (Studio overview) | Home `?view=home` (projects as cards) |
| `?suite=studio&page=brief` (01 Brief & Script) | Studio board › Brief region `?view=board&frame=d` (brief document card); the questions step is `frame=b` |
| `?suite=studio&page=beats` (02 Beats & Shots) | Studio board › Storyboard region; the shot-list table is the board's List view (`frame=d`, Board/List toggle) |
| `?suite=studio&page=boards` (03 Storyboards) | Studio board › Storyboard `frame=d`; Looks `frame=c` |
| `?suite=studio&page=env` (04 Environment) | Studio board › Cast region (Cast, Environment and Elements cards) `frame=h` |
| `?suite=studio&page=cast` (05 Cast & Elements) | Studio board › Cast `frame=h` (identity status, consent record) |
| `?suite=studio&page=astra` (06 Astra 3D) | **3D blocking**, a tool on a shot card (Inspector › Advanced); no page of its own |
| `?suite=studio&page=rig` (07 Rig · canvas / `&rig=list`) | **The Board itself** `?view=board` (canvas) and its List view |
| `?suite=studio&page=takes` (08 Takes) | Shots region `frame=f`/`g`, Review mode `frame=l`, Make › Recent (`make=recent`) |
| `?suite=studio&page=edit` (09 Edit & Sound) | Cut region `frame=i` ("Open Edit & Sound" opens the editor) |
| `?suite=studio&page=deliver` (10 Deliver) | Deliver card `frame=i` |
| `?view=gen&mode=video\|images\|audio` (Gen), `&task=edit\|upscale`, `&sheet=1` | **Make** panel `…&make=1 \| image \| audio`; Seedance Edit and the upscales are "Change with words" / card actions; the model sheet is "Change" on the engine line (`make=change`) |
| `?suite=business&page=dtc` (Image ads) | Ads board `kind=ads&frame=2` (image ad group) |
| `?suite=business&page=setup` | Ads board `frame=1` (Brand kit, Product facts, Reference ad cards) |
| `?suite=business&page=brand \| product \| reference` | Ads board `frame=1` cards |
| `?suite=business&page=format \| hooks` | Ads board `frame=2` (Hooks card, Format briefs card) |
| `?suite=business&page=design` (poster Designer) | Ads board `frame=3` (full editor from a card) |
| `?suite=viral&page=motion \| swap` (Genjutsu) | Make › **Motion transfer** / **Object swap** (`make=motion \| swap`); Social board Effects card `kind=social&frame=2` |
| `?suite=viral&page=history` | Make › Recent (`make=recent`) and the board's History drawer |
| `?view=crew&crew=room \| members \| sessions` | **Crew review** inside a board `frame=m`; sessions are in the Project record `frame=n` |
| `?suite=atomik&page=agent` | Atomik's panel (`&atomik=1` on any screen); the plan card on the board `frame=e` |
| `?suite=atomik&page=runs` | Control room › **Activity** `?suite=atomik&page=runs` |
| `?suite=atomik&page=approvals` | Control room › Approvals (same URL) |
| `?suite=atomik&page=budget` | Settings › Spending rules `?view=workspace&ws=rules`; per-project spend in Activity and the Project record |
| `?suite=atomik&page=models` | Settings › Advanced › Models `?view=workspace&ws=advanced&open=models` |
| `?suite=atomik&page=skills` (Tools & connections) | Settings › Connections `ws=connections` (MCP, publishing) and Advanced › Tools |
| `?suite=atomik&page=memory`, `page=saved-skills` | Control room › Memory, Skills (same URLs) |
| `?view=workspace&ws=general \| people \| credits \| usage \| dashboard \| engines \| security` | Settings in five sections: Team (`people`, `security`), Plan & credits (`credits`, `usage`), Spending rules, Connections, Advanced (`engines`, `general`); `dashboard` → Activity |
| `&lib=0 \| assets`, `&insp=0` | The Library is a rail drawer (closed by default); the Inspector opens only on selection — both params are no-ops |
| `&palette=1`, `&beats=graph` | `&palette=1` still opens ⌘K; `beats=graph` → the Board itself |

## 2 · (end of the copied section)
